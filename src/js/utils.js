/** Shared, dependency-free utilities used across the application. */

export function uid(prefix = '') {
  if (globalThis.crypto?.randomUUID) return `${prefix}${crypto.randomUUID()}`;
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function clamp(value, min, max) {
  const number = Number(value);
  if (Number.isNaN(number)) return min;
  return Math.min(max, Math.max(min, number));
}

export function debounce(fn, wait = 250) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  wrapped.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    timer = null;
    fn(...args);
  };
  wrapped.pending = () => timer !== null;
  return wrapped;
}

export function throttle(fn, wait = 100) {
  let last = 0;
  let timer = null;
  let lastArgs = null;
  const invoke = (args) => {
    last = Date.now();
    fn(...args);
  };
  return (...args) => {
    lastArgs = args;
    const remaining = wait - (Date.now() - last);
    if (remaining <= 0) {
      clearTimeout(timer);
      timer = null;
      invoke(args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        invoke(lastArgs);
      }, remaining);
    }
  };
}

export function deepClone(value) {
  if (value == null) return value;
  if (globalThis.structuredClone) return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch ?? base;
  if (typeof base !== 'object' || base === null) return patch ?? base;
  if (typeof patch !== 'object' || patch === null) return patch ?? base;
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return result;
}

export function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function countWords(text = '') {
  const cleaned = String(text)
    .replace(/[#*_>`~[\]()]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .trim();
  if (!cleaned) return 0;
  const matches = cleaned.match(/[\p{L}\p{N}\p{M}]+(?:['’\-][\p{L}\p{N}\p{M}]+)*/gu);
  return matches ? matches.length : 0;
}

export function countCharacters(text = '') {
  return [...String(text)].length;
}

export function countParagraphs(text = '') {
  const value = String(text).trim();
  if (!value) return 0;
  return value.split(/\n\s*\n/).filter((part) => part.trim()).length;
}

export function estimateSeconds(words, wpm = 140) {
  const rate = clamp(wpm, 30, 600);
  return Math.round((words / rate) * 60);
}

export function formatDuration(totalSeconds, { compact = false, alwaysHours = false } = {}) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0 || alwaysHours) {
    return compact
      ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${h}h ${m}m ${compact ? '' : `${s}s`}`.trim();
  }
  if (compact) return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

export function formatEstimated(seconds) {
  if (seconds < 60) return '<1 min read';
  const minutes = Math.round(seconds / 60);
  return `${minutes} min read`;
}

export function formatBytes(bytes, decimals = 1) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : decimals)} ${units[index]}`;
}

export function formatDate(value, { dateStyle = 'medium', timeStyle = undefined, locale = undefined } = {}) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle, timeStyle }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

export function formatRelative(value, locale = undefined) {
  if (!value) return 'Never';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  const units = [
    [31536000000, 'year'],
    [2592000000, 'month'],
    [604800000, 'week'],
    [86400000, 'day'],
    [3600000, 'hour'],
    [60000, 'minute'],
    [1000, 'second'],
  ];
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    for (const [ms, unit] of units) {
      if (abs >= ms || unit === 'second') {
        return rtf.format(Math.round(diff / ms), unit);
      }
    }
  } catch {
    // Fall through to a basic representation.
  }
  return date.toLocaleDateString();
}

export function formatTimeOfDay(value, locale = undefined) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date);
  } catch {
    return date.toLocaleTimeString();
  }
}

export function getExtension(fileName = '') {
  const name = String(fileName);
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
}

export function stripExtension(fileName = '') {
  return String(fileName).replace(/\.[^.\\/]+$/, '');
}

export function sanitizeFileName(name = 'untitled', fallback = 'script') {
  const cleaned = String(name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

export function deriveTitleFromFileName(fileName = '') {
  const base = stripExtension(String(fileName).split(/[\\/]/).pop() || '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return base || 'Imported script';
}

export function normalizeNewlines(text = '') {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/**
 * Cleans imported text without joining paragraphs. Conservative by default.
 */
export function cleanImportedText(text, { collapseBlankLines = true, removePageArtifacts = false } = {}) {
  let value = normalizeNewlines(text)
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+\n/g, '\n');

  if (removePageArtifacts) {
    value = value
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return true;
        if (/^(page\s+)?\d+\s*(of|\/)\s*\d+$/i.test(trimmed)) return false;
        if (/^page\s+\d+$/i.test(trimmed)) return false;
        if (/^[-–—]\s*\d+\s*[-–—]$/.test(trimmed)) return false;
        return true;
      })
      .join('\n');
  }

  if (collapseBlankLines) value = value.replace(/\n{3,}/g, '\n\n');
  return value.trim();
}

export function truncate(text = '', length = 160) {
  const value = String(text).replace(/\s+/g, ' ').trim();
  if (value.length <= length) return value;
  return `${value.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}

export async function hashText(text, algorithm = 'SHA-256') {
  if (!globalThis.crypto?.subtle) {
    // Deterministic, non-cryptographic fallback for old/insecure contexts.
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h2 = Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    return `fallback-${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
  }
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest(algorithm, data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = sanitizeFileName(fileName, 'download');
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadText(text, fileName, mime = 'text/plain;charset=utf-8') {
  downloadBlob(new Blob([text], { type: mime }), fileName);
}

export function readFileAsText(file, encoding = 'utf-8') {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
    reader.readAsText(file, encoding);
  });
}

export function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
    reader.readAsArrayBuffer(file);
  });
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

export function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'CANCELLED' || error?.name === 'CancelledError';
}

export function abortError(message = 'Operation cancelled.') {
  const error = new DOMException(message, 'AbortError');
  return error;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nextTick() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function parseColor(value) {
  const hex = String(value || '').trim();
  const match = /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(hex);
  if (!match) return null;
  let raw = match[1];
  if (raw.length === 3) raw = raw.split('').map((c) => c + c).join('');
  return {
    r: parseInt(raw.slice(0, 2), 16),
    g: parseInt(raw.slice(2, 4), 16),
    b: parseInt(raw.slice(4, 6), 16),
  };
}

export function relativeLuminance(color) {
  const rgb = typeof color === 'string' ? parseColor(color) : color;
  if (!rgb) return 0;
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

export function contrastRatio(fg, bg) {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export function isLowContrast(fg, bg, minimum = 4.5) {
  return contrastRatio(fg, bg) < minimum;
}

export function friendlyErrorMessage(error, fallback = 'Something went wrong.') {
  if (!error) return fallback;
  const name = error.name || '';
  if (name === 'QuotaExceededError') return 'Browser storage is full. Export a backup, delete unused scripts, and try again.';
  if (name === 'NotAllowedError') return 'Permission was denied. You can allow access in your browser settings and try again.';
  if (name === 'NotFoundError') return 'No matching device or file was found.';
  if (name === 'NotReadableError') return 'The device is already in use or could not be read.';
  if (name === 'SecurityError') return 'The browser blocked this action for security reasons.';
  if (name === 'AbortError') return 'The operation was cancelled.';
  if (name === 'InvalidStateError') return 'That action is not available in the current state.';
  if (name === 'VersionError') return 'This database was created by a newer version of the app.';
  if (name === 'DataError') return 'The data could not be stored because it is invalid.';
  const message = String(error.message || error);
  return message.length <= 260 ? message : `${message.slice(0, 257)}…`;
}

export function isTypingTarget(target) {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function getFocusableElements(container) {
  if (!container) return [];
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]',
  ].join(',');
  return [...container.querySelectorAll(selector)].filter(
    (element) => !element.hasAttribute('hidden') && element.offsetParent !== null,
  );
}

export function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function toPercent(value, total) {
  if (!total) return 0;
  return clamp((value / total) * 100, 0, 100);
}

export function byteLength(text = '') {
  return new Blob([String(text)]).size;
}

export function supportsFeature(name) {
  if (name === 'speech') return Boolean(globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition);
  if (name === 'mediaRecorder') return typeof globalThis.MediaRecorder !== 'undefined';
  if (name === 'mediaDevices') return Boolean(navigator.mediaDevices?.getUserMedia);
  if (name === 'fullscreen') return Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  if (name === 'share') return typeof navigator.share === 'function';
  if (name === 'storageEstimate') return Boolean(navigator.storage?.estimate);
  if (name === 'persistentStorage') return Boolean(navigator.storage?.persist);
  if (name === 'serviceWorker') return 'serviceWorker' in navigator;
  if (name === 'broadcastChannel') return typeof BroadcastChannel !== 'undefined';
  if (name === 'qrScanner') return 'BarcodeDetector' in globalThis;
  return false;
}

/**
 * Tokenize text with character offsets. Handles Unicode scripts and keeps
 * apostrophes/hyphens inside words. Used by voice-follow and reading stats.
 */
export function tokenizeWordsWithOffsets(text = '') {
  const tokens = [];
  const regex = /[\p{L}\p{N}\p{M}]+(?:['’\-][\p{L}\p{N}\p{M}]+)*/gu;
  let match;
  while ((match = regex.exec(text)) !== null) {
    tokens.push({
      word: match[0],
      normalized: normalizeWord(match[0]),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

export function normalizeWord(word = '') {
  return String(word)
    .toLocaleLowerCase()
    .normalize('NFKC')
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}\p{M}']/gu, '');
}

export function findOccurrences(haystack = '', needle = '', { caseSensitive = false } = {}) {
  if (!needle) return [];
  const source = caseSensitive ? String(haystack) : String(haystack).toLocaleLowerCase();
  const search = caseSensitive ? String(needle) : String(needle).toLocaleLowerCase();
  const results = [];
  let index = 0;
  while (index <= source.length) {
    const found = source.indexOf(search, index);
    if (found === -1) break;
    results.push({ start: found, end: found + search.length });
    index = found + Math.max(1, search.length);
    if (results.length > 5000) break;
  }
  return results;
}

export function formatShortcutLabel(shortcut = '') {
  return String(shortcut)
    .replace(/\bSpace\b/, 'Space')
    .replace(/Arrow/g, '')
    .replace(/Escape/, 'Esc')
    .replace(/Control/, 'Ctrl')
    .replace(/Meta/, '⌘');
}

export function titleFromContent(content = '', fallback = 'Untitled script') {
  const firstLine = String(content)
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((line) => line.replace(/^#{1,6}\s*/, '').replace(/[*_`>]/g, '').trim())
    .find((line) => line.length > 0);
  if (!firstLine) return fallback;
  return firstLine.length > 90 ? `${firstLine.slice(0, 87)}…` : firstLine;
}

export function classNames(...values) {
  return values.filter(Boolean).join(' ');
}

export function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function setImportantStyle(element, property, value) {
  if (!element) return;
  element.style.setProperty(property, value, 'important');
}

/** Escapes text for use inside a CSS string value. */
export function cssString(value = '') {
  return String(value).replace(/[\\"]/g, '\\$&').replace(/[\n\r]/g, ' ');
}
