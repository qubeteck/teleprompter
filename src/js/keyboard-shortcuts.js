import { formatShortcutLabel, isPlainObject } from './utils.js';
import { isAnyModalOpen } from './ui.js';

export const DEFAULT_SHORTCUTS = Object.freeze({
  playPause: 'Space',
  restart: 'KeyR',
  speedUp: 'ArrowUp',
  speedDown: 'ArrowDown',
  jumpBack: 'ArrowLeft',
  jumpForward: 'ArrowRight',
  jumpStart: 'Home',
  jumpEnd: 'End',
  fullscreen: 'KeyF',
  mirror: 'KeyM',
  fontUp: 'Shift+Equal',
  fontDown: 'Minus',
  toggleControls: 'KeyC',
  toggleHelp: 'Shift+Slash',
  exit: 'Escape',
  voice: 'KeyV',
});

export const SHORTCUT_ACTIONS = Object.freeze([
  { action: 'playPause', label: 'Play / pause', description: 'Start, pause, or resume scrolling', group: 'Playback', key: 'Space' },
  { action: 'restart', label: 'Restart', description: 'Return to the beginning', group: 'Playback', key: 'R' },
  { action: 'speedUp', label: 'Increase speed', description: 'Raise reading speed while playing or paused', group: 'Playback', key: '↑' },
  { action: 'speedDown', label: 'Decrease speed', description: 'Lower reading speed while playing or paused', group: 'Playback', key: '↓' },
  { action: 'jumpBack', label: 'Jump back', description: 'Move back by 10 seconds of reading', group: 'Position', key: '←' },
  { action: 'jumpForward', label: 'Jump forward', description: 'Move forward by 10 seconds of reading', group: 'Position', key: '→' },
  { action: 'jumpStart', label: 'Jump to start', description: 'Move to the beginning of the script', group: 'Position', key: 'Home' },
  { action: 'jumpEnd', label: 'Jump to end', description: 'Move to the end of the script', group: 'Position', key: 'End' },
  { action: 'fullscreen', label: 'Fullscreen', description: 'Toggle fullscreen with a windowed fallback', group: 'Display', key: 'F' },
  { action: 'mirror', label: 'Cycle mirror', description: 'Normal → horizontal → vertical → both', group: 'Display', key: 'M' },
  { action: 'fontUp', label: 'Larger text', description: 'Increase teleprompter font size', group: 'Display', key: '+' },
  { action: 'fontDown', label: 'Smaller text', description: 'Decrease teleprompter font size', group: 'Display', key: '-' },
  { action: 'toggleControls', label: 'Show / hide controls', description: 'Toggle the playback control bar', group: 'Display', key: 'C' },
  { action: 'toggleHelp', label: 'Shortcut help', description: 'Open the keyboard shortcut reference', group: 'Help', key: '?' },
  { action: 'voice', label: 'Voice following', description: 'Open the optional voice-follow panel', group: 'Advanced', key: 'V' },
  { action: 'exit', label: 'Exit reader', description: 'Exit fullscreen, close overlays, or leave the reader', group: 'Help', key: 'Esc' },
]);

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];

export function getShortcutMap(overrides = {}) {
  if (!isPlainObject(overrides)) return { ...DEFAULT_SHORTCUTS };
  const map = { ...DEFAULT_SHORTCUTS };
  for (const action of Object.keys(DEFAULT_SHORTCUTS)) {
    const custom = overrides[action];
    if (typeof custom === 'string' && custom.trim() && custom.length <= 40) map[action] = custom;
  }
  return map;
}

function canonicalKey(event) {
  if (event.code) return event.code;
  if (event.key === ' ') return 'Space';
  if (event.key === 'Escape') return 'Escape';
  if (event.key.startsWith('Arrow')) return event.key;
  if (event.key.length === 1) return `Key${event.key.toUpperCase()}`;
  return event.key;
}

export function shortcutFromEvent(event) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return '';
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey && !(event.code === 'ShiftLeft' || event.code === 'ShiftRight')) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  parts.push(canonicalKey(event));
  return parts.join('+');
}

export function eventMatchesShortcut(event, shortcut) {
  if (!shortcut) return false;
  const parts = String(shortcut).split('+');
  const key = parts.at(-1);
  const required = new Set(parts.slice(0, -1));
  const code = canonicalKey(event);
  const keyMatches = key === code || (key === 'Space' && event.key === ' ') || key === event.key;
  if (!keyMatches) return false;
  const hasCtrl = required.has('Ctrl');
  const hasAlt = required.has('Alt');
  const hasShift = required.has('Shift');
  const hasMeta = required.has('Meta');
  if (hasCtrl !== event.ctrlKey) return false;
  if (hasAlt !== event.altKey) return false;
  if (hasMeta !== event.metaKey) return false;
  // Requiring shift exactly avoids ambiguity between "=" and "+".
  if (hasShift !== event.shiftKey) return false;
  return true;
}

export function findActionForEvent(event, shortcutMap) {
  for (const [action, shortcut] of Object.entries(shortcutMap)) {
    if (eventMatchesShortcut(event, shortcut)) return action;
  }
  return null;
}

const DISPLAY_KEY_NAMES = {
  Space: 'Space',
  Equal: '=',
  Minus: '-',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Backquote: '`',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Escape: 'Esc',
  Enter: 'Enter',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num −',
};

export function displayShortcut(shortcut = '') {
  const parts = String(shortcut).split('+');
  const key = parts.pop();
  let label = DISPLAY_KEY_NAMES[key];
  if (!label && key?.startsWith('Key')) label = key.slice(3);
  if (!label && key?.startsWith('Digit')) label = key.slice(5);
  if (!label) label = formatShortcutLabel(key || '');
  const modifiers = parts.map((part) => (part === 'Meta' ? '⌘' : part === 'Ctrl' ? 'Ctrl' : part));
  return [...modifiers, label].join(' + ');
}

export function getShortcutGroups(overrides = {}) {
  const map = getShortcutMap(overrides);
  const groups = new Map();
  for (const action of SHORTCUT_ACTIONS) {
    if (!groups.has(action.group)) groups.set(action.group, []);
    groups.get(action.group).push({ ...action, shortcut: map[action.action] || '', display: displayShortcut(map[action.action] || action.key) });
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }));
}

/**
 * Lightweight shortcut controller used by the reader. Handlers receive the
 * original KeyboardEvent. The shouldIgnore callback lets overlays claim keys
 * before the global reader shortcuts.
 */
export class ShortcutController {
  #handler;
  #settings;
  #enabled;
  #shouldIgnore;
  #map;

  constructor({ settings, handlers = {}, shouldIgnore = null, getEnabled = () => true }) {
    this.#handler = (event) => {
      if (!this.#enabled()) return;
      if (event.defaultPrevented) return;
      if (event.target instanceof Element) {
        const tag = event.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target.isContentEditable) return;
      }
      if (isAnyModalOpen()) return;
      if (this.#shouldIgnore?.(event)) return;
      this.#map = getShortcutMap(settings.reader.shortcutOverrides);
      const action = findActionForEvent(event, this.#map);
      if (!action) return;
      const handler = handlers[action];
      if (!handler) return;
      event.preventDefault();
      event.stopPropagation();
      handler(event);
    };
    document.addEventListener('keydown', this.#handler, true);
    this.#settings = settings;
    this.#map = getShortcutMap(settings.reader.shortcutOverrides);
    this.#enabled = getEnabled;
    this.#shouldIgnore = shouldIgnore;
  }

  setSettings(settings) {
    this.#settings = settings;
    this.#map = getShortcutMap(settings.reader.shortcutOverrides);
  }

  destroy() {
    document.removeEventListener('keydown', this.#handler, true);
  }
}
