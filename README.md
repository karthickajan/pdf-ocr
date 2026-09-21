# PDF OCR

Client-side OCR for scanned PDFs, optimized for large engineering drawings, wiring sheets, terminal layouts, and other image-heavy technical documents.

## Local development

```bash
npm install
npm run dev
```

## Build for GitHub Pages

```bash
npm run build
```

This project is configured to publish from the `main` branch using the `docs/` folder.

## GitHub Pages settings

Use these repository settings:

- Source: `Deploy from a branch`
- Branch: `main`
- Folder: `/docs`

## Important deployment note

Because this repo is hosted directly from `main`, every deployable commit must include freshly built `docs/` output.

Typical deploy flow:

```bash
npm run build
git add .
git commit -m "Update site"
git push
```
