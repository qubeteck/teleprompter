# Testing

## Commands
- `npm test` - Run unit tests with Vitest
- `npm run dev` - Start dev server
- `npm run build` - Production build
- `npm run preview` - Preview production build

## Test setup
Tests use jsdom and fake-indexeddb. See `tests/setup.js`.

## Coverage areas
- Utilities (clamping, word counting, formatting)
- Script validation
- Settings sanitization

## Manual smoke tests
See the checklist in the app or test flows: library, editor (autosave), import dialog, reader (play/pause/countdown), voice/camera/remote panels, settings sections, presets CRUD, shortcuts, backup/restore, trash.
