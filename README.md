# PDF OCR

Client-side OCR for scanned PDFs, optimized for large engineering drawings, wiring sheets, terminal layouts, and image-only technical documents.

## What it does

- Runs entirely in the browser with no backend upload.
- Analyzes each PDF page before OCR.
- Uses selective OCR for image-heavy pages.
- Highlights where matching words appear on page previews.
- Exports a searchable PDF with an invisible text layer.

## Local development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
npm run preview
```

## Deployment

The repo is configured for GitHub Pages deployment from the `main` branch using GitHub Actions.

- Vite base path: `/pdf-ocr/`
- Workflow: `.github/workflows/deploy.yml`

After pushing to `main`, GitHub Actions will build and publish the contents of `dist` automatically.

## Notes

- Large OCR libraries are lazy-loaded to keep the initial app bundle smaller.
- Best results come from the `Drawing mode` OCR strategy for sparse engineering PDFs.
