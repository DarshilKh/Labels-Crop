import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  UNKNOWN,
  analysePage,
  detectPlatform,
  openPdf,
  renderThumb,
  skuSummary,
  sortLabels,
  type Label,
  type LoadedFile,
  type PlatformChoice,
  type SortMode,
} from './lib/labels'
import { buildPdf, download, summaryCsv, type PerPage } from './lib/output'

const PREVIEW_COUNT = 8

export default function App() {
  const [files, setFiles] = useState<LoadedFile[]>([])
  const [labels, setLabels] = useState<Label[]>([])
  const [platform, setPlatform] = useState<PlatformChoice>('auto')
  const [perPage, setPerPage] = useState<PerPage>(1)
  const [breakSku, setBreakSku] = useState(true)
  const [sortMode, setSortMode] = useState<SortMode>('sku')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [dragging, setDragging] = useState(false)
  const rawFiles = useRef<File[]>([])
  const run = useRef(0)

  const analyse = useCallback(async (list: File[], choice: PlatformChoice) => {
    const id = ++run.current
    setError(null)
    setBusy('Reading PDFs…')
    try {
      const loaded: LoadedFile[] = []
      for (const f of list) {
        const { bytes, doc } = await openPdf(f)
        const p = choice === 'auto' ? await detectPlatform(doc) : choice
        loaded.push({ name: f.name, bytes, doc, platform: p })
      }
      const all: Label[] = []
      let done = 0
      const total = loaded.reduce((n, f) => n + f.doc.numPages, 0)
      for (let fi = 0; fi < loaded.length; fi++) {
        for (let pi = 0; pi < loaded[fi].doc.numPages; pi++) {
          if (id !== run.current) return
          const l = await analysePage(loaded[fi], fi, pi)
          if (l) all.push(l)
          if (++done % 5 === 0) setBusy(`Cropping labels… ${done}/${total}`)
        }
      }
      if (id !== run.current) return
      setFiles(loaded)
      setLabels(all)
      if (!all.length) setError('No readable labels found in this PDF (scanned image PDFs are not supported).')
    } catch (e) {
      console.error(e)
      setError('Could not read that PDF. Make sure it is a Meesho or Flipkart label PDF.')
    } finally {
      if (id === run.current) setBusy(null)
    }
  }, [])

  const onFiles = (list: FileList | File[]) => {
    const pdfs = Array.from(list).filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf')
    if (!pdfs.length) return setError('Please drop PDF files.')
    rawFiles.current = pdfs
    analyse(pdfs, platform)
  }

  const changePlatform = (p: PlatformChoice) => {
    setPlatform(p)
    if (rawFiles.current.length) analyse(rawFiles.current, p)
  }

  const sorted = useMemo(() => sortLabels(labels, sortMode), [labels, sortMode])
  const summary = useMemo(() => {
    const s = skuSummary(sorted)
    return s
  }, [sorted])
  const unknown = labels.filter((l) => l.sku === UNKNOWN).length
  const shownSummary = summary.filter((r) => r.sku.toLowerCase().includes(query.toLowerCase()))

  const generate = async () => {
    setBusy('Building PDF…')
    try {
      const bytes = await buildPdf(sorted, files, perPage, breakSku, (d, t) => setBusy(`Building PDF… ${d}/${t}`))
      const base = files[0].name.replace(/\.pdf$/i, '')
      download(bytes as unknown as BlobPart, `${base}_sorted.pdf`, 'application/pdf')
    } catch (e) {
      console.error(e)
      setError('Failed to build the PDF.')
    } finally {
      setBusy(null)
    }
  }

  const reset = () => {
    run.current++
    rawFiles.current = []
    setFiles([])
    setLabels([])
    setError(null)
    setBusy(null)
  }

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo">▤</span>
          <div>
            <h1>Label Sorter</h1>
            <p>Meesho &amp; Flipkart shipping labels → cropped and grouped by SKU</p>
          </div>
        </div>
        {files.length > 0 && (
          <button className="ghost" onClick={reset}>
            Start over
          </button>
        )}
      </header>

      {error && <div className="alert error">{error}</div>}

      {!files.length && (
        <label
          className={'drop' + (dragging ? ' over' : '')}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            onFiles(e.dataTransfer.files)
          }}
        >
          <input type="file" accept="application/pdf" multiple hidden onChange={(e) => e.target.files && onFiles(e.target.files)} />
          <div className="drop-icon">⇪</div>
          <strong>{busy ?? 'Drop your label PDF here'}</strong>
          <span>{busy ? 'This stays in your browser – nothing is uploaded.' : 'or click to choose · you can pick several files at once'}</span>
        </label>
      )}

      {files.length > 0 && (
        <main className="grid">
          <aside className="panel controls">
            <h2>Settings</h2>

            <div className="field">
              <label>Marketplace</label>
              <div className="seg">
                {(['auto', 'meesho', 'flipkart'] as PlatformChoice[]).map((p) => (
                  <button key={p} className={platform === p ? 'on' : ''} onClick={() => changePlatform(p)}>
                    {p === 'auto' ? 'Auto' : p[0].toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
              <small>Detected: {files.map((f) => f.platform).filter((v, i, a) => a.indexOf(v) === i).join(', ')}</small>
            </div>

            <div className="field">
              <label>Sort</label>
              <div className="seg">
                <button className={sortMode === 'sku' ? 'on' : ''} onClick={() => setSortMode('sku')}>
                  SKU A → Z
                </button>
                <button className={sortMode === 'count' ? 'on' : ''} onClick={() => setSortMode('count')}>
                  Most orders first
                </button>
              </div>
            </div>

            <div className="field">
              <label>Labels per page</label>
              <div className="seg">
                {([1, 2, 4, 6, 8] as PerPage[]).map((n) => (
                  <button key={n} className={perPage === n ? 'on' : ''} onClick={() => setPerPage(n)}>
                    {n === 1 ? '1 (cropped)' : n}
                  </button>
                ))}
              </div>
              <small>{perPage === 1 ? 'Each label on its own page, exactly label-sized.' : 'A4 sheet, 2 labels per row.'}</small>
            </div>

            <label className={'check' + (perPage === 1 ? ' disabled' : '')}>
              <input type="checkbox" checked={breakSku} disabled={perPage === 1} onChange={(e) => setBreakSku(e.target.checked)} />
              <span>
                Each SKU starts on a new row
                <small>One category = one line, easy to find</small>
              </span>
            </label>

            <button className="primary" disabled={!!busy} onClick={generate}>
              {busy ?? '⬇ Download sorted PDF'}
            </button>
            <button className="ghost wide" onClick={() => download(summaryCsv(summary), 'sku_summary.csv', 'text/csv')}>
              Download SKU list (CSV)
            </button>
          </aside>

          <section className="main">
            <div className="stats">
              <Stat label="Labels" value={labels.length} />
              <Stat label="Unique SKUs" value={summary.length} />
              <Stat label="Files" value={files.length} />
              <Stat label="Top SKU qty" value={summary.reduce((m, r) => Math.max(m, r.count), 0)} />
            </div>

            {unknown > 0 && (
              <div className="alert warn">
                {unknown} label{unknown > 1 ? 's' : ''} had no readable SKU and {unknown > 1 ? 'are' : 'is'} grouped as “{UNKNOWN}”.
              </div>
            )}

            <div className="panel">
              <div className="panel-head">
                <h2>SKU breakdown</h2>
                <input className="search" placeholder="Search SKU…" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>SKU</th>
                      <th className="num">Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownSummary.map((r, i) => (
                      <tr key={r.sku}>
                        <td className="muted">{i + 1}</td>
                        <td>{r.sku}</td>
                        <td className="num">
                          <span className="pill">{r.count}</span>
                        </td>
                      </tr>
                    ))}
                    {!shownSummary.length && (
                      <tr>
                        <td colSpan={3} className="muted center">
                          No SKU matches
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="panel">
              <h2>Preview (first {Math.min(PREVIEW_COUNT, sorted.length)} labels in output order)</h2>
              <div className="thumbs">
                {sorted.slice(0, PREVIEW_COUNT).map((l) => (
                  <Thumb key={l.id} file={files[l.fileIndex]} label={l} />
                ))}
              </div>
            </div>
          </section>
        </main>
      )}

      <footer>Runs entirely in your browser — your PDFs and customer details are never uploaded.</footer>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  )
}

function Thumb({ file, label }: { file: LoadedFile; label: Label }) {
  const [src, setSrc] = useState<string>()
  useEffect(() => {
    let alive = true
    renderThumb(file, label).then((s) => alive && setSrc(s))
    return () => {
      alive = false
    }
  }, [file, label])
  return (
    <figure className="thumb">
      {src ? <img src={src} alt={label.sku} /> : <div className="ph" />}
      <figcaption title={label.sku}>{label.sku}</figcaption>
    </figure>
  )
}
