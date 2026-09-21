import type { OcrPage } from './pdfPipeline'

export const buildSearchablePdf = async (file: File, ocrPages: OcrPage[]) => {
  const {
    PDFDocument,
    StandardFonts,
    beginText,
    endText,
    popGraphicsState,
    pushGraphicsState,
    setCharacterSqueeze,
    setFontAndSize,
    setTextMatrix,
    setTextRenderingMode,
    showText,
    TextRenderingMode,
  } = await import('pdf-lib')
  const source = await file.arrayBuffer()
  const pdf = await PDFDocument.load(source)
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const ocrByPage = new Map(ocrPages.map((page) => [page.pageNumber, page]))

  pdf.getPages().forEach((page, index) => {
    const ocrPage = ocrByPage.get(index + 1)

    if (!ocrPage) {
      return
    }

    const { width, height } = page.getSize()
    const scaleX = width / ocrPage.width
    const scaleY = height / ocrPage.height
    const fontKey = page.node.newFontDictionary(font.name, font.ref)

    ocrPage.words.forEach((word) => {
      const text = word.text.trim()

      if (!text) {
        return
      }

      const boxWidth = Math.max(1, (word.bbox.x1 - word.bbox.x0) * scaleX)
      const boxHeight = Math.max(1, (word.bbox.y1 - word.bbox.y0) * scaleY)
      const fontSize = Math.max(4, font.sizeAtHeight(boxHeight))
      const naturalWidth = Math.max(0.001, font.widthOfTextAtSize(text, fontSize))
      const naturalHeight = font.heightAtSize(fontSize, { descender: true })
      const visibleHeight = font.heightAtSize(fontSize, { descender: false })
      const descenderHeight = Math.max(0, naturalHeight - visibleHeight)
      const horizontalScale = Math.max(40, Math.min(250, (boxWidth / naturalWidth) * 100))
      const fittedVisibleHeight = visibleHeight * (boxHeight / naturalHeight)
      const baselineY =
        height - word.bbox.y1 * scaleY + descenderHeight + (boxHeight - fittedVisibleHeight) * 0.5

      page.pushOperators(
        pushGraphicsState(),
        beginText(),
        setTextRenderingMode(TextRenderingMode.Invisible),
        setFontAndSize(fontKey, fontSize),
        setCharacterSqueeze(horizontalScale),
        setTextMatrix(1, 0, 0, boxHeight / naturalHeight, word.bbox.x0 * scaleX, baselineY),
        showText(font.encodeText(text)),
        endText(),
        popGraphicsState(),
      )
    })
  })

  const bytes = await pdf.save()
  return new Blob([new Uint8Array(bytes)], {
    type: 'application/pdf',
  })
}