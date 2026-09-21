import type { PDFPageProxy } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import type { Block, Paragraph, Line, RecognizeResult, Word } from 'tesseract.js'

export type AccuracyMode = 'balanced' | 'drawing' | 'max'

export type PageKind = 'cover' | 'drawing' | 'diagram' | 'text' | 'mixed'

export type PageAnalysis = {
  pageNumber: number
  width: number
  height: number
  thumbnailUrl: string
  nativeTextPreview: string
  nativeWordCount: number
  nativeCharCount: number
  inkRatio: number
  kind: PageKind
  needsOcr: boolean
  suggestedScale: number
}

export type PdfAnalysis = {
  fileName: string
  totalPages: number
  pages: PageAnalysis[]
}

export type OcrWord = {
  text: string
  confidence: number
  bbox: Word['bbox']
}

export type OcrPage = {
  pageNumber: number
  width: number
  height: number
  text: string
  confidence: number
  words: OcrWord[]
}

export type OcrRunResult = {
  pages: OcrPage[]
}

type ProgressHandler = (progress: { current: number; total: number; message: string }) => void

const THUMBNAIL_TARGET_WIDTH = 340

let pdfJsPromise: Promise<typeof import('pdfjs-dist')> | null = null
let pdfWorkerConfigured = false

const loadPdfJs = async () => {
  if (!pdfJsPromise) {
    pdfJsPromise = import('pdfjs-dist')
  }

  const pdfJs = await pdfJsPromise

  if (!pdfWorkerConfigured) {
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
    pdfJs.GlobalWorkerOptions.workerSrc = workerUrl
    pdfWorkerConfigured = true
  }

  return pdfJs
}

const createCanvas = (width: number, height: number) => {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(width))
  canvas.height = Math.max(1, Math.floor(height))
  return canvas
}

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim()

const flattenWordsFromBlocks = (blocks: Block[] | null | undefined) => {
  const words: Word[] = []

  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs ?? ([] as Paragraph[])) {
      for (const line of paragraph.lines ?? ([] as Line[])) {
        words.push(...(line.words ?? []))
      }
    }
  }

  return words
}

const extractNativeText = async (page: PDFPageProxy) => {
  const content = await page.getTextContent()
  const text = normalizeWhitespace(
    content.items
      .map((item: TextItem | { type: string }) => ('str' in item ? item.str : ''))
      .filter(Boolean)
      .join(' '),
  )

  return {
    text,
    wordCount: text ? text.split(/\s+/).length : 0,
    charCount: text.length,
  }
}

const renderPage = async (
  page: PDFPageProxy,
  scale: number,
) => {
  const viewport = page.getViewport({ scale })
  const canvas = createCanvas(viewport.width, viewport.height)
  const context = canvas.getContext('2d', { willReadFrequently: true })

  if (!context) {
    throw new Error('Unable to create 2D canvas context.')
  }

  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)

  await page.render({ canvas, canvasContext: context, viewport }).promise

  return { canvas, viewport }
}

const measureInkRatio = (canvas: HTMLCanvasElement) => {
  const context = canvas.getContext('2d', { willReadFrequently: true })

  if (!context) {
    return 0
  }

  const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
  let darkPixels = 0

  for (let index = 0; index < data.length; index += 4) {
    const r = data[index]
    const g = data[index + 1]
    const b = data[index + 2]
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b

    if (luminance < 235) {
      darkPixels += 1
    }
  }

  return darkPixels / (canvas.width * canvas.height)
}

const classifyPage = ({
  nativeWordCount,
  nativeCharCount,
  inkRatio,
}: {
  nativeWordCount: number
  nativeCharCount: number
  inkRatio: number
}): PageKind => {
  if (nativeWordCount <= 3 && inkRatio < 0.03) {
    return 'cover'
  }

  if (nativeWordCount <= 20) {
    return inkRatio < 0.12 ? 'drawing' : 'diagram'
  }

  if (nativeCharCount > 500 && inkRatio > 0.08) {
    return 'text'
  }

  return 'mixed'
}

const getSuggestedScale = (kind: PageKind, nativeWordCount: number, mode: AccuracyMode) => {
  if (mode === 'max') {
    return 3.2
  }

  if (mode === 'drawing') {
    return kind === 'drawing' || kind === 'diagram' || nativeWordCount < 20 ? 2.8 : 2.3
  }

  return kind === 'text' ? 1.9 : 2.25
}

const shouldOcrPage = (kind: PageKind, nativeWordCount: number) => {
  if (nativeWordCount === 0) {
    return true
  }

  if (kind === 'drawing' || kind === 'diagram') {
    return nativeWordCount < 120
  }

  return nativeWordCount < 24
}

const recognizePage = async (
  worker: {
    recognize: (typeof import('tesseract.js'))['recognize'] extends never
      ? never
      : Awaited<ReturnType<(typeof import('tesseract.js'))['createWorker']>>['recognize']
  },
  canvas: HTMLCanvasElement,
) => {
  const result = await worker.recognize(
    canvas,
    {},
    {
      text: true,
      blocks: true,
      hocr: false,
      tsv: false,
      pdf: false,
    },
  )

  return result as RecognizeResult
}

export const analyzePdfFile = async (
  file: File,
  mode: AccuracyMode,
  onProgress?: ProgressHandler,
) => {
  const { getDocument } = await loadPdfJs()
  const bytes = new Uint8Array(await file.arrayBuffer())
  const document = await getDocument({ data: bytes }).promise
  const pages: PageAnalysis[] = []

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber)
    const baseViewport = page.getViewport({ scale: 1 })
    const { text, wordCount, charCount } = await extractNativeText(page)
    const thumbnailScale = Math.min(1, THUMBNAIL_TARGET_WIDTH / baseViewport.width)
    const { canvas } = await renderPage(page, thumbnailScale)
    const inkRatio = measureInkRatio(canvas)
    const kind = classifyPage({
      nativeWordCount: wordCount,
      nativeCharCount: charCount,
      inkRatio,
    })

    pages.push({
      pageNumber,
      width: baseViewport.width,
      height: baseViewport.height,
      thumbnailUrl: canvas.toDataURL('image/jpeg', 0.74),
      nativeTextPreview: text.slice(0, 180),
      nativeWordCount: wordCount,
      nativeCharCount: charCount,
      inkRatio,
      kind,
      needsOcr: shouldOcrPage(kind, wordCount),
      suggestedScale: getSuggestedScale(kind, wordCount, mode),
    })

    page.cleanup()
    onProgress?.({
      current: pageNumber,
      total: document.numPages,
      message: `Analyzed page ${pageNumber} of ${document.numPages}`,
    })
    await nextTick()
  }

  await document.destroy()

  return {
    fileName: file.name,
    totalPages: pages.length,
    pages,
  } satisfies PdfAnalysis
}

export const runPdfOcr = async (
  file: File,
  analysis: PdfAnalysis,
  mode: AccuracyMode,
  selectiveOcr: boolean,
  onProgress?: ProgressHandler,
) => {
  const { getDocument } = await loadPdfJs()
  const { createWorker, PSM } = await import('tesseract.js')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const document = await getDocument({ data: bytes }).promise
  const worker = await createWorker('eng', 1)

  await worker.setParameters({
    tessedit_pageseg_mode:
      mode === 'drawing' || mode === 'max' ? PSM.SPARSE_TEXT : PSM.AUTO,
    preserve_interword_spaces: '1',
    user_defined_dpi: mode === 'max' ? '360' : '300',
  })

  const targetPages = selectiveOcr
    ? analysis.pages.filter((page) => page.needsOcr)
    : analysis.pages

  const results: OcrPage[] = []

  for (let index = 0; index < targetPages.length; index += 1) {
    const target = targetPages[index]
    const page = await document.getPage(target.pageNumber)
    const { canvas } = await renderPage(page, target.suggestedScale)
    const result = await recognizePage(worker, canvas)
    const recognizedPage = result.data as typeof result.data & { words?: Word[] }
    const rawWords = recognizedPage.words ?? flattenWordsFromBlocks(recognizedPage.blocks)
    const words = rawWords
      .filter((word) => word.text.trim().length > 0 && word.confidence >= 15)
      .map((word) => ({
        text: word.text,
        confidence: word.confidence,
        bbox: word.bbox,
      }))

    results.push({
      pageNumber: target.pageNumber,
      width: canvas.width,
      height: canvas.height,
      text: normalizeWhitespace(recognizedPage.text),
      confidence: recognizedPage.confidence,
      words,
    })

    page.cleanup()
    onProgress?.({
      current: index + 1,
      total: targetPages.length,
      message: `OCR page ${target.pageNumber} of ${analysis.totalPages}`,
    })
    await nextTick()
  }

  await worker.terminate()
  await document.destroy()

  return { pages: results } satisfies OcrRunResult
}