import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export type Platform = 'meesho' | 'flipkart'
export type PlatformChoice = Platform | 'auto'

export interface Label {
  id: number
  fileIndex: number
  pageIndex: number
  sku: string
  /** crop box in PDF points, origin top-left */
  crop: { x0: number; y0: number; x1: number; y1: number }
  pageW: number
  pageH: number
  /** page-box origin in PDF user space (cropped PDFs often don't start at 0,0) */
  viewX: number
  viewY: number
}

export interface LoadedFile {
  name: string
  bytes: Uint8Array
  doc: pdfjs.PDFDocumentProxy
  platform: Platform
}

interface Tx {
  s: string
  x: number
  right: number
  top: number
  bottom: number
}
interface Line {
  top: number
  bottom: number
  items: Tx[]
  text: string
}

const INVOICE_MARKERS = ['tax invoice', 'invoice', 'bill of supply']
const MARGIN = 5
export const UNKNOWN = 'UNKNOWN'

export async function openPdf(file: File): Promise<{ bytes: Uint8Array; doc: pdfjs.PDFDocumentProxy }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  // pdf.js transfers the buffer to its worker, so hand it a copy
  const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise
  return { bytes, doc }
}

async function pageItems(page: pdfjs.PDFPageProxy, viewX: number, viewTop: number): Promise<Tx[]> {
  const tc = await page.getTextContent()
  const out: Tx[] = []
  for (const it of tc.items) {
    if (!('str' in it) || !it.str.trim()) continue
    const e = it.transform[4] - viewX
    const f = it.transform[5]
    const h = it.height || Math.abs(it.transform[3]) || 8
    out.push({ s: it.str, x: e, right: e + it.width, bottom: viewTop - f + h * 0.2, top: viewTop - f - h })
  }
  return out
}

function toLines(items: Tx[]): Line[] {
  const sorted = [...items].sort((a, b) => a.top - b.top || a.x - b.x)
  const lines: Line[] = []
  for (const it of sorted) {
    const h = it.bottom - it.top
    const cur = lines[lines.length - 1]
    if (cur && Math.abs(it.top - cur.top) < Math.max(3, h * 0.5)) {
      cur.items.push(it)
      cur.bottom = Math.max(cur.bottom, it.bottom)
    } else {
      lines.push({ top: it.top, bottom: it.bottom, items: [it], text: '' })
    }
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x)
    l.text = l.items.map((i) => i.s.trim()).join(' ').replace(/\s+/g, ' ').trim()
  }
  return lines
}

export async function detectPlatform(doc: pdfjs.PDFDocumentProxy): Promise<Platform> {
  let txt = ''
  for (let i = 1; i <= Math.min(3, doc.numPages); i++) {
    const tc = await (await doc.getPage(i)).getTextContent()
    txt += tc.items.map((it) => ('str' in it ? it.str : '')).join(' ').toLowerCase()
  }
  return txt.includes('flipkart') || txt.includes('sku id') || txt.includes('e-kart') ? 'flipkart' : 'meesho'
}

/** Pixel-accurate trim of the label area (everything above the invoice heading). */
async function trimToInk(page: pdfjs.PDFPageProxy, cutY: number, W: number): Promise<{ x0: number; y0: number; x1: number; y1: number } | null> {
  const S = 2
  const vp = page.getViewport({ scale: S })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(vp.width)
  canvas.height = Math.ceil(vp.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport: vp }).promise
  const h = Math.min(canvas.height, Math.floor(cutY * S))
  const w = canvas.width
  const data = ctx.getImageData(0, 0, w, h).data
  const dark = (x: number, y: number) => {
    const i = (y * w + x) * 4
    return data[i] < 190 || data[i + 1] < 190 || data[i + 2] < 190
  }
  let x0 = w, x1 = -1, y0 = h, y1 = -1
  const rowDark = new Int32Array(h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (dark(x, y)) {
        rowDark[y]++
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  canvas.width = canvas.height = 0
  if (x1 < 0) return null
  // the label's bottom edge is the last long horizontal rule; ignore short vertical tails below it
  const span = x1 - x0 + 1
  for (let y = y1; y > y0; y--) {
    if (rowDark[y] > span * 0.6) {
      y1 = y
      break
    }
  }
  return {
    x0: Math.max(0, x0 / S - MARGIN),
    y0: Math.max(0, y0 / S - MARGIN),
    x1: Math.min(W, (x1 + 1) / S + MARGIN),
    y1: Math.min(cutY + MARGIN, (y1 + 1) / S + 2),
  }
}

function extractSku(lines: Line[], platform: Platform, labelText: string): string {
  if (platform === 'meesho') {
    for (let i = 0; i < lines.length; i++) {
      const header = lines[i].items.find((t) => t.s.trim().toUpperCase() === 'SKU')
      if (!header) continue
      const size = lines[i].items.find((t) => t.s.trim().toLowerCase() === 'size')
      const xEnd = size ? size.x - 2 : Infinity
      const next = lines[i + 1]
      if (!next) break
      const sku = next.items
        .filter((t) => t.x >= header.x - 4 && t.x < xEnd)
        .map((t) => t.s.trim())
        .join(' ')
        .trim()
      if (sku) return sku
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      if (!/sku\s*id/i.test(lines[i].text)) continue
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        const m = lines[j].text.match(/^\d+\s+(.*)$/)
        if (!m) continue
        const sku = m[1].split('|')[0].replace(/^[\s-]+|[\s|-]+$/g, '').trim()
        if (sku) return sku
      }
    }
  }
  const m = labelText.match(/SKU\s*(?:ID)?\s*[:\-]?\s*([^\s|]+)/i)
  return m ? m[1] : UNKNOWN
}

export async function analysePage(
  file: LoadedFile,
  fileIndex: number,
  pageIndex: number,
): Promise<Label | null> {
  const page = await file.doc.getPage(pageIndex + 1)
  const [vx, vy, vx1, vy1] = page.view
  const W = vx1 - vx
  const H = vy1 - vy
  const items = await pageItems(page, vx, vy1)
  if (!items.length) return null // scanned / empty page
  const lines = toLines(items)

  let cutY: number | null = null
  for (const l of lines) {
    const t = l.text.toLowerCase()
    if (l.top > H * 0.2 && INVOICE_MARKERS.some((m) => t.startsWith(m))) {
      cutY = cutY === null ? l.top : Math.min(cutY, l.top)
    }
  }

  let crop = { x0: 0, y0: 0, x1: W, y1: H }
  let labelLines = lines
  if (cutY !== null) {
    labelLines = lines.filter((l) => l.bottom <= cutY! + 1)
    crop = (await trimToInk(page, cutY, W)) ?? { x0: 0, y0: 0, x1: W, y1: cutY }
  }
  const labelText = labelLines.map((l) => l.text).join('\n')
  return {
    id: fileIndex * 100000 + pageIndex,
    fileIndex,
    pageIndex,
    sku: extractSku(labelLines, file.platform, labelText),
    crop,
    pageW: W,
    pageH: H,
    viewX: vx,
    viewY: vy,
  }
}

export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

export type SortMode = 'sku' | 'count'

export function sortLabels(labels: Label[], mode: SortMode): Label[] {
  const counts = new Map<string, number>()
  labels.forEach((l) => counts.set(l.sku, (counts.get(l.sku) ?? 0) + 1))
  return [...labels].sort((a, b) => {
    if (mode === 'count') {
      const d = (counts.get(b.sku) ?? 0) - (counts.get(a.sku) ?? 0)
      if (d) return d
    }
    return naturalCompare(a.sku, b.sku) || a.fileIndex - b.fileIndex || a.pageIndex - b.pageIndex
  })
}

export function skuSummary(labels: Label[]): { sku: string; count: number }[] {
  const m = new Map<string, number>()
  labels.forEach((l) => m.set(l.sku, (m.get(l.sku) ?? 0) + 1))
  return [...m].map(([sku, count]) => ({ sku, count }))
}

/** Render one label (cropped) to a data URL for the preview grid. */
export async function renderThumb(file: LoadedFile, label: Label, width = 360): Promise<string> {
  const page = await file.doc.getPage(label.pageIndex + 1)
  const cw = label.crop.x1 - label.crop.x0
  const scale = (width / cw) * 1
  const vp = page.getViewport({ scale })
  const full = document.createElement('canvas')
  full.width = Math.ceil(vp.width)
  full.height = Math.ceil(vp.height)
  const ctx = full.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, full.width, full.height)
  await page.render({ canvasContext: ctx, viewport: vp }).promise
  const out = document.createElement('canvas')
  out.width = Math.round(cw * scale)
  out.height = Math.round((label.crop.y1 - label.crop.y0) * scale)
  out.getContext('2d')!.drawImage(full, label.crop.x0 * scale, label.crop.y0 * scale, out.width, out.height, 0, 0, out.width, out.height)
  full.width = full.height = 0
  return out.toDataURL('image/jpeg', 0.85)
}
