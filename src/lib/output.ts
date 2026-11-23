import { PDFDocument } from 'pdf-lib'
import type { Label, LoadedFile } from './labels'

export type PerPage = 1 | 2 | 4 | 6 | 8
const A4: [number, number] = [595.28, 841.89]

export async function buildPdf(
  labels: Label[],
  files: LoadedFile[],
  perPage: PerPage,
  breakSku: boolean,
  onProgress?: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const out = await PDFDocument.create()
  const srcDocs = await Promise.all(files.map((f) => PDFDocument.load(f.bytes, { ignoreEncryption: true })))

  const embed = async (l: Label) => {
    const src = srcDocs[l.fileIndex].getPage(l.pageIndex)
    // pdf-lib uses bottom-left origin
    return out.embedPage(src, {
      left: l.viewX + l.crop.x0,
      right: l.viewX + l.crop.x1,
      bottom: l.viewY + (l.pageH - l.crop.y1),
      top: l.viewY + (l.pageH - l.crop.y0),
    })
  }

  if (perPage === 1) {
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i]
      const w = l.crop.x1 - l.crop.x0
      const h = l.crop.y1 - l.crop.y0
      const page = out.addPage([w, h])
      page.drawPage(await embed(l), { x: 0, y: 0, width: w, height: h })
      onProgress?.(i + 1, labels.length)
    }
    return out.save()
  }

  const cols = 2
  const rows = perPage / cols
  const [W, H] = A4
  const cw = W / cols
  const ch = H / rows
  const pad = 4

  // reading-order slots; with breakSku every new SKU starts on a fresh row
  const slots: { r: number; c: number; l: Label }[] = []
  let r = 0
  let c = 0
  let prev: string | null = null
  for (const l of labels) {
    if (breakSku && prev !== null && l.sku !== prev && c !== 0) {
      r++
      c = 0
    }
    slots.push({ r, c, l })
    prev = l.sku
    if (++c === cols) {
      r++
      c = 0
    }
  }

  const pages = new Map<number, typeof slots>()
  for (const s of slots) {
    const p = Math.floor(s.r / rows)
    if (!pages.has(p)) pages.set(p, [])
    pages.get(p)!.push(s)
  }

  let done = 0
  for (const p of [...pages.keys()].sort((a, b) => a - b)) {
    const page = out.addPage([W, H])
    for (const s of pages.get(p)!) {
      const lw = s.l.crop.x1 - s.l.crop.x0
      const lh = s.l.crop.y1 - s.l.crop.y0
      const cellW = cw - pad * 2
      const cellH = ch - pad * 2
      const k = Math.min(cellW / lw, cellH / lh)
      const x = s.c * cw + pad
      const yTop = (s.r % rows) * ch + pad
      page.drawPage(await embed(s.l), { x, y: H - yTop - lh * k, width: lw * k, height: lh * k })
      onProgress?.(++done, labels.length)
    }
  }
  return out.save()
}

export function summaryCsv(rows: { sku: string; count: number }[]): string {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`
  return 'SKU,Quantity\n' + rows.map((r) => `${esc(r.sku)},${r.count}`).join('\n') + '\n'
}

export function download(data: BlobPart | Uint8Array, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
