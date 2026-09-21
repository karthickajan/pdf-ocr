import type { OcrPage } from './pdfPipeline'

export const buildSearchablePdf = async (file: File, ocrPages: OcrPage[]) => {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
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

    ocrPage.words.forEach((word) => {
      const text = word.text.trim()

      if (!text) {
        return
      }

      const fontSize = Math.max(4, (word.bbox.y1 - word.bbox.y0) * scaleY * 0.82)

      page.drawText(text, {
        x: word.bbox.x0 * scaleX,
        y: height - word.bbox.y1 * scaleY,
        size: fontSize,
        font,
        opacity: 0,
      })
    })
  })

  const bytes = await pdf.save()
  return new Blob([new Uint8Array(bytes)], {
    type: 'application/pdf',
  })
}