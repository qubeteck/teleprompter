# Security

## Data handling
- All core data (scripts, folders, presets, settings, revisions) is stored locally in IndexedDB.
- Small UI preferences may use localStorage.
- No accounts, no cloud sync, no telemetry by default.
- Imported files are processed locally; OCR runs locally via Tesseract.js.

## Content safety
- HTML imported is sanitized with DOMPurify.
- No imported scripts/styles are executed.
- Exported backups are JSON files you control.

## Permissions
- Camera/microphone access only requested when you use recording/preview.
- Speech recognition only requested when you enable voice follow.
- Fullscreen requested on user action.
- PWA/service worker only caches local assets.

## Recommendations
- Keep your browser updated.
- Back up important scripts regularly (Settings → Data → Backups).
- Review OCR results before relying on them.
- Use a strong device lock if others can access your machine.
