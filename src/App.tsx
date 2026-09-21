import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import './App.css'
import {
  analyzePdfFile,
  runPdfOcr,
  type AccuracyMode,
  type OcrPage,
  type PdfAnalysis,
} from './lib/pdfPipeline'
import { buildSearchablePdf } from './lib/searchablePdf'

type QueueItem = {
  id: string
  file: File
  addedAt: string
}

type FileState = {
  analysis?: PdfAnalysis
  ocrPages?: OcrPage[]
  analysisMessage?: string
  ocrMessage?: string
  error?: string
}

type SearchHit = {
  pageNumber: number
  text: string
  bbox: OcrPage['words'][number]['bbox']
  confidence: number
}

const normalizeSearch = (value: string) => value.trim().toLowerCase()

function App() {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [files, setFiles] = useState<QueueItem[]>([])
  const [fileStates, setFileStates] = useState<Record<string, FileState>>({})
  const [activeFileId, setActiveFileId] = useState<string | null>(null)
  const [language] = useState('eng')
  const [accuracyMode, setAccuracyMode] = useState<AccuracyMode>('drawing')
  const [selectiveOcr, setSelectiveOcr] = useState(true)
  const [generateSearchablePdf, setGenerateSearchablePdf] = useState(true)
  const [busyAction, setBusyAction] = useState<'analyze' | 'ocr' | 'pdf' | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)

  const deferredSearch = useDeferredValue(searchQuery)

  const totalSizeMb = useMemo(
    () => files.reduce((sum, item) => sum + item.file.size, 0) / (1024 * 1024),
    [files],
  )

  const activeFile = useMemo(
    () => files.find((item) => item.id === activeFileId) ?? null,
    [activeFileId, files],
  )

  const activeState = activeFileId ? fileStates[activeFileId] : undefined
  const activeAnalysis = activeState?.analysis
  const activeOcrPages = activeState?.ocrPages ?? []

  const metrics = useMemo(() => {
    if (!activeAnalysis) {
      return {
        pages: 0,
        needsOcr: 0,
        ocrDone: 0,
      }
    }

    return {
      pages: activeAnalysis.totalPages,
      needsOcr: activeAnalysis.pages.filter((page) => page.needsOcr).length,
      ocrDone: activeOcrPages.length,
    }
  }, [activeAnalysis, activeOcrPages.length])

  const searchHitsByPage = useMemo(() => {
    const query = normalizeSearch(deferredSearch)
    const grouped = new Map<number, SearchHit[]>()

    if (!query) {
      return grouped
    }

    activeOcrPages.forEach((page) => {
      const hits = page.words
        .filter((word) => normalizeSearch(word.text).includes(query))
        .map((word) => ({
          pageNumber: page.pageNumber,
          text: word.text,
          bbox: word.bbox,
          confidence: word.confidence,
        }))

      if (hits.length > 0) {
        grouped.set(page.pageNumber, hits)
      }
    })

    return grouped
  }, [activeOcrPages, deferredSearch])

  const visiblePages = useMemo(() => {
    if (!activeAnalysis) {
      return []
    }

    if (searchHitsByPage.size > 0) {
      return activeAnalysis.pages.filter((page) => searchHitsByPage.has(page.pageNumber))
    }

    return activeAnalysis.pages.slice(0, 16)
  }, [activeAnalysis, searchHitsByPage])

  const resultCount = Array.from(searchHitsByPage.values()).reduce(
    (sum, hits) => sum + hits.length,
    0,
  )

  const patchFileState = (fileId: string, updater: (current: FileState) => FileState) => {
    setFileStates((current) => ({
      ...current,
      [fileId]: updater(current[fileId] ?? {}),
    }))
  }

  useEffect(() => {
    return () => {
      if (downloadUrl) {
        URL.revokeObjectURL(downloadUrl)
      }
    }
  }, [downloadUrl])

  const handleFiles = (incoming: FileList | null) => {
    if (!incoming) {
      return
    }

    const next = Array.from(incoming)
      .filter((file) => file.type === 'application/pdf' || file.name.endsWith('.pdf'))
      .map((file) => ({
        id: `${file.name}-${file.lastModified}-${file.size}`,
        file,
        addedAt: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }),
      }))

    setFiles((current) => {
      const existing = new Set(current.map((item) => item.id))
      const merged = [...current, ...next.filter((item) => !existing.has(item.id))]

      if (!activeFileId && merged.length > 0) {
        setActiveFileId(merged[0].id)
      }

      return merged
    })
  }

  const openPicker = () => {
    inputRef.current?.click()
  }

  const removeFile = (id: string) => {
    setFiles((current) => current.filter((item) => item.id !== id))
    setFileStates((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })

    if (activeFileId === id) {
      const replacement = files.find((item) => item.id !== id)
      setActiveFileId(replacement?.id ?? null)
    }
  }

  const analyzeActiveFile = async () => {
    if (!activeFile || busyAction) {
      return
    }

    setBusyAction('analyze')
    setSearchQuery('')

    patchFileState(activeFile.id, (current) => ({
      ...current,
      error: undefined,
      analysisMessage: 'Opening PDF and inspecting pages...',
      ocrPages: undefined,
    }))

    try {
      const analysis = await analyzePdfFile(activeFile.file, accuracyMode, (progress) => {
        patchFileState(activeFile.id, (current) => ({
          ...current,
          analysisMessage: progress.message,
        }))
      })

      startTransition(() => {
        patchFileState(activeFile.id, (current) => ({
          ...current,
          analysis,
          analysisMessage: `Analyzed ${analysis.totalPages} pages.`,
          ocrPages: undefined,
          ocrMessage: undefined,
        }))
      })
    } catch (error) {
      patchFileState(activeFile.id, (current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'Failed to analyze PDF.',
      }))
    } finally {
      setBusyAction(null)
    }
  }

  const runActiveOcr = async () => {
    if (!activeFile || !activeAnalysis || busyAction) {
      return
    }

    setBusyAction('ocr')

    patchFileState(activeFile.id, (current) => ({
      ...current,
      error: undefined,
      ocrMessage: 'Starting OCR workers...',
    }))

    try {
      const result = await runPdfOcr(
        activeFile.file,
        activeAnalysis,
        accuracyMode,
        selectiveOcr,
        (progress) => {
          patchFileState(activeFile.id, (current) => ({
            ...current,
            ocrMessage: progress.message,
          }))
        },
      )

      startTransition(() => {
        patchFileState(activeFile.id, (current) => ({
          ...current,
          ocrPages: result.pages,
          ocrMessage: `OCR completed for ${result.pages.length} pages.`,
        }))
      })
    } catch (error) {
      patchFileState(activeFile.id, (current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'OCR failed.',
      }))
    } finally {
      setBusyAction(null)
    }
  }

  const downloadSearchablePdf = async () => {
    if (!activeFile || activeOcrPages.length === 0 || busyAction || !generateSearchablePdf) {
      return
    }

    setBusyAction('pdf')

    try {
      const blob = await buildSearchablePdf(activeFile.file, activeOcrPages)
      const url = URL.createObjectURL(blob)

      if (downloadUrl) {
        URL.revokeObjectURL(downloadUrl)
      }

      setDownloadUrl(url)

      const link = document.createElement('a')
      link.href = url
      link.download = activeFile.file.name.replace(/\.pdf$/i, '') + '-searchable.pdf'
      link.click()
    } catch (error) {
      patchFileState(activeFile.id, (current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'Failed to build searchable PDF.',
      }))
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Client-side OCR for scanned PDFs</p>
          <h1>Search exact words inside image-heavy engineering PDFs.</h1>
          <p className="hero-text">
            Built for sparse title sheets, wiring diagrams, GA drawings, and dense
            technical annotations. Files stay local, OCR runs in-browser, and the
            exported PDF keeps a hidden text layer for normal search.
          </p>
        </div>

        <div className="hero-stats">
          <div>
            <span>Target workflow</span>
            <strong>PDF.js + selective OCR + searchable PDF</strong>
          </div>
          <div>
            <span>Optimized for</span>
            <strong>Large scanned drawing sets</strong>
          </div>
          <div>
            <span>Output</span>
            <strong>Search hits with page coordinates</strong>
          </div>
        </div>
      </section>

      <section className="workspace-grid">
        <section className="panel upload-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Step 1</p>
              <h2>Load PDFs</h2>
            </div>
            <span className="pill">Local only</span>
          </div>

          <button type="button" className="dropzone" onClick={openPicker}>
            <span className="dropzone-title">Drop large PDFs here</span>
            <span className="dropzone-copy">
              The sample you attached fits the intended target: mixed title pages,
              sparse diagrams, and tiny labels spread across many pages.
            </span>
            <span className="dropzone-action">Choose PDF files</span>
          </button>

          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            hidden
            onChange={(event) => handleFiles(event.target.files)}
          />

          <div className="queue-summary">
            <div>
              <span>Queued files</span>
              <strong>{files.length}</strong>
            </div>
            <div>
              <span>Total size</span>
              <strong>{totalSizeMb.toFixed(1)} MB</strong>
            </div>
            <div>
              <span>Language</span>
              <strong>{language}</strong>
            </div>
          </div>

          <div className="queue-list">
            {files.length === 0 ? (
              <div className="empty-state">
                Upload one or more PDFs to start page analysis, native-text detection,
                and targeted OCR planning.
              </div>
            ) : (
              files.map((item) => (
                <article
                  key={item.id}
                  className={`queue-item ${activeFileId === item.id ? 'is-active' : ''}`}
                >
                  <div>
                    <h3>{item.file.name}</h3>
                    <p>
                      {(item.file.size / (1024 * 1024)).toFixed(1)} MB added at {item.addedAt}
                    </p>
                  </div>
                  <div className="queue-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => setActiveFileId(item.id)}
                    >
                      Open
                    </button>
                    <button type="button" className="ghost-button" onClick={() => removeFile(item.id)}>
                      Remove
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>

          <div className="action-row">
            <button
              type="button"
              className="primary-button"
              disabled={!activeFile || busyAction !== null}
              onClick={analyzeActiveFile}
            >
              {busyAction === 'analyze' ? 'Analyzing...' : 'Analyze active PDF'}
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={!activeAnalysis || busyAction !== null}
              onClick={runActiveOcr}
            >
              {busyAction === 'ocr' ? 'Running OCR...' : 'Run selective OCR'}
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={!generateSearchablePdf || activeOcrPages.length === 0 || busyAction !== null}
              onClick={downloadSearchablePdf}
            >
              {busyAction === 'pdf' ? 'Building PDF...' : 'Download searchable PDF'}
            </button>
          </div>

          {activeState?.analysisMessage ? <p className="status-line">{activeState.analysisMessage}</p> : null}
          {activeState?.ocrMessage ? <p className="status-line">{activeState.ocrMessage}</p> : null}
          {activeState?.error ? <p className="error-line">{activeState.error}</p> : null}
        </section>

        <section className="panel settings-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Step 2</p>
              <h2>OCR strategy</h2>
            </div>
            <span className="pill accent">Sample-tuned</span>
          </div>

          <div className="mode-grid">
            <button
              type="button"
              className={`mode-card ${accuracyMode === 'balanced' ? 'is-active' : ''}`}
              onClick={() => setAccuracyMode('balanced')}
            >
              <strong>Balanced</strong>
              <span>General reports and medium-size scans</span>
            </button>
            <button
              type="button"
              className={`mode-card ${accuracyMode === 'drawing' ? 'is-active' : ''}`}
              onClick={() => setAccuracyMode('drawing')}
            >
              <strong>Drawing mode</strong>
              <span>High-DPI OCR for engineering sheets and tiny annotations</span>
            </button>
            <button
              type="button"
              className={`mode-card ${accuracyMode === 'max' ? 'is-active' : ''}`}
              onClick={() => setAccuracyMode('max')}
            >
              <strong>Max accuracy</strong>
              <span>More passes, slower processing, best for hard scans</span>
            </button>
          </div>

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={selectiveOcr}
              onChange={(event) => setSelectiveOcr(event.target.checked)}
            />
            <span>
              Selective OCR: keep native PDF text when present and OCR only image-heavy
              pages or regions.
            </span>
          </label>

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={generateSearchablePdf}
              onChange={(event) => setGenerateSearchablePdf(event.target.checked)}
            />
            <span>
              Generate a downloadable searchable PDF with an invisible text layer.
            </span>
          </label>

          <div className="strategy-notes">
            <article>
              <h3>Why this fits your sample</h3>
              <p>
                Title sheets need large-text detection, while terminal and wiring pages
                need small word boxes. A single OCR pass is not enough.
              </p>
            </article>
            <article>
              <h3>Big-file handling</h3>
              <p>
                The processing queue will run page batches in workers, reuse OCR models,
                and avoid rendering the whole PDF into memory at once.
              </p>
            </article>
          </div>

          <div className="metric-grid">
            <article>
              <span>Pages</span>
              <strong>{metrics.pages}</strong>
            </article>
            <article>
              <span>Need OCR</span>
              <strong>{metrics.needsOcr}</strong>
            </article>
            <article>
              <span>OCR done</span>
              <strong>{metrics.ocrDone}</strong>
            </article>
          </div>
        </section>
      </section>

      <section className="pipeline-panel panel">
        <div className="panel-header">
          <div>
            <p className="panel-kicker">Step 3</p>
            <h2>Planned processing pipeline</h2>
          </div>
        </div>

        <div className="pipeline-grid">
          <article>
            <span>01</span>
            <h3>Page classification</h3>
            <p>Detect native text, page density, and whether the sheet is title, diagram, or tabular.</p>
          </article>
          <article>
            <span>02</span>
            <h3>Adaptive rasterization</h3>
            <p>Render sparse drawing pages at higher DPI than text-heavy pages to preserve tiny labels.</p>
          </article>
          <article>
            <span>03</span>
            <h3>Word-box OCR</h3>
            <p>Store page-level bounding boxes so searches can jump to the exact location of each match.</p>
          </article>
          <article>
            <span>04</span>
            <h3>Searchable output</h3>
            <p>Write an invisible text layer back into a downloadable PDF and keep a fast in-browser search index.</p>
          </article>
        </div>
      </section>

      <section className="panel results-panel">
        <div className="panel-header">
          <div>
            <p className="panel-kicker">Step 4</p>
            <h2>Search and page location</h2>
          </div>
          <span className="pill">{resultCount} hits</span>
        </div>

        <div className="search-toolbar">
          <input
            className="search-input"
            type="search"
            placeholder="Search recognized words like ANALYSER, SV09, TB01, wiring, kiln..."
            value={searchQuery}
            disabled={activeOcrPages.length === 0}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          <p className="helper-copy">
            OCR results are matched against word boxes so each hit can be located on the page thumbnail.
          </p>
        </div>

        {activeAnalysis ? (
          <>
            <div className="gallery-note">
              {searchHitsByPage.size > 0
                ? `Showing ${visiblePages.length} pages with matches.`
                : `Showing ${visiblePages.length} of ${activeAnalysis.totalPages} analyzed pages. Search to narrow down exact locations.`}
            </div>

            <div className="page-gallery">
              {visiblePages.map((page) => {
                const hits = searchHitsByPage.get(page.pageNumber) ?? []

                return (
                  <article key={page.pageNumber} className="page-card">
                    <div className="page-card-header">
                      <div>
                        <h3>Page {page.pageNumber}</h3>
                        <p>
                          {page.kind} · {page.nativeWordCount} native words · ink {(page.inkRatio * 100).toFixed(1)}%
                        </p>
                      </div>
                      <span className={`mini-pill ${page.needsOcr ? 'warn' : 'ok'}`}>
                        {page.needsOcr ? 'OCR target' : 'Native text'}
                      </span>
                    </div>

                    <div className="thumbnail-stage">
                      <img src={page.thumbnailUrl} alt={`Page ${page.pageNumber} preview`} />
                      {hits.map((hit, index) => (
                        <span
                          key={`${page.pageNumber}-${index}-${hit.text}`}
                          className="highlight-box"
                          style={{
                            left: `${(hit.bbox.x0 / (activeOcrPages.find((item) => item.pageNumber === page.pageNumber)?.width ?? 1)) * 100}%`,
                            top: `${(hit.bbox.y0 / (activeOcrPages.find((item) => item.pageNumber === page.pageNumber)?.height ?? 1)) * 100}%`,
                            width: `${((hit.bbox.x1 - hit.bbox.x0) / (activeOcrPages.find((item) => item.pageNumber === page.pageNumber)?.width ?? 1)) * 100}%`,
                            height: `${((hit.bbox.y1 - hit.bbox.y0) / (activeOcrPages.find((item) => item.pageNumber === page.pageNumber)?.height ?? 1)) * 100}%`,
                          }}
                          title={`${hit.text} (${hit.confidence.toFixed(0)}%)`}
                        />
                      ))}
                    </div>

                    <p className="page-preview">
                      {activeOcrPages.find((item) => item.pageNumber === page.pageNumber)?.text.slice(0, 200) ||
                        page.nativeTextPreview ||
                        'No native text found before OCR.'}
                    </p>
                  </article>
                )
              })}
            </div>
          </>
        ) : (
          <div className="empty-state">
            Analyze a PDF to inspect page types, then run OCR to search exact words and see their locations.
          </div>
        )}
      </section>
    </main>
  )
}

export default App
