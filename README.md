# Advanced Teleprompter Studio

A local-first, browser-based script studio for presenters, creators, teachers, and speakers. Build, rehearse, and record without accounts, backend services, or forced uploads. Everything you create stays in your browser on your device.

## Features

- **Script library**: Create, import, organize by folders/tags, favorite, search, sort, bulk actions, trash and restore.
- **Editor**: Markdown-backed editor with formatting toolbar, format switching, autosave, search/replace, preview, and keyboard-friendly editing.
- **Import**: TXT, Markdown, HTML, DOCX, PDF, RTF, JSON (script exports), and images/scans with optional local OCR (Tesseract.js).
- **Export**: TXT, Markdown, HTML, JSON; printable stylesheet; versioned backup/restore with merge or explicit replace (safety backups offered).
- **Teleprompter reader**: Smooth RAF-based scrolling, speed in words per minute, direction control, countdown, progress and timer, mirroring, fullscreen, focal line/fade, themes and presets, keyboard shortcuts.
- **Voice follow**: Optional local speech recognition to advance the script while reading aloud (gracefully disables if unsupported).
- **Camera + recording**: Local camera/mic preview and recording in supported formats; files are saved to your device only.
- **Remote control**: Same-browser BroadcastChannel pairing via session/token with QR code; no network server required in this mode and states limitations honestly.
- **PWA/offline**: Works offline after first load; service worker caches app shell and OCR/PDF assets.
- **Accessibility**: Focus management, ARIA, reduced motion support, contrast checking, Unicode support.
- **Privacy first**: No telemetry, no accounts. IndexedDB stores scripts/folders/presets/settings/revisions; localStorage only for small preferences.

## Tech stack

- HTML5, vanilla JavaScript (ES modules), Tailwind CSS 4, Vite 8
- IndexedDB for structured data, localStorage for small prefs
- `marked`, `DOMPurify`, `mammoth`, `pdfjs-dist`, `tesseract.js`, `qrcode`

## Getting started

### Prerequisites
- Node.js >= 22.12.0

### Install and run
```bash
npm install
npm run dev
```

Open the URL shown by Vite (typically `http://127.0.0.1:5173`).

### Build
```bash
npm run build
npm run preview
```

### Test
```bash
npm test
```

## Data and backup

Backups are JSON with a versioned schema and include scripts, folders, presets, settings, and revisions. Restore supports a safe merge (never overwrites conflicts blindly) or explicit replace (with an offered safety backup). Export individual scripts in TXT/Markdown/HTML/JSON or print.

## Shortcuts

Defaults cover play/pause, navigation, fullscreen, controls, speed, mirror, presets, search, and more. Rebind and resolve conflicts in Settings → Shortcuts.

## Project structure

```
src/
  css/           # Tailwind CSS entry
  js/
    app.js       # App shell, router, context
    database.js  # IndexedDB layer
    views/       # Dashboard, library, editor, reader, settings, remote, not-found
    import-parsers/
public/          # Icons, PWA manifest, OCR/PDF assets
tests/           # Vitest tests
```

## Notes on limitations

- Some features depend on browser APIs (MediaRecorder, getUserMedia, SpeechRecognition, File System Access) and are only enabled if supported; unsupported states are shown honestly with no fake controls.
- Remote control uses BroadcastChannel (same browser/origin) and requires a transport/server for cross-device use over a network; the UI explains this.
- Imported HTML is sanitized; no imported scripts are executed.
- OCR and PDF rendering use local assets bundled under `public/`.

## License

MIT (see `LICENSE`).
