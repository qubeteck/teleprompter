import { loadSettingsRecord, persistSettingsRecord } from './database.js';
import {
  clamp,
  deepClone,
  deepMerge,
  isPlainObject,
  nowIso,
  parseColor,
  toFiniteNumber,
} from './utils.js';

export const APP_NAME = 'Advanced Teleprompter Studio';
export const APP_VERSION = '1.0.0';
export const SETTINGS_SCHEMA_VERSION = 1;

export const FONT_STACKS = Object.freeze({
  sans: 'var(--font-sans)',
  serif: 'var(--font-serif)',
  mono: 'var(--font-mono)',
  accessible: 'Verdana, Tahoma, "Segoe UI", "Noto Sans Ethiopic", sans-serif',
});

export const READER_THEMES = Object.freeze([
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Deep blue-black with cyan accent',
    bg: '#050910',
    text: '#f2f7ff',
    accent: '#22d3ee',
  },
  {
    id: 'black',
    name: 'Studio black',
    description: 'Pure black for camera work',
    bg: '#000000',
    text: '#f8fafc',
    accent: '#facc15',
  },
  {
    id: 'paper',
    name: 'Warm paper',
    description: 'Low-glare cream for daytime',
    bg: '#f7f1e5',
    text: '#292524',
    accent: '#b45309',
  },
  {
    id: 'white',
    name: 'Bright white',
    description: 'High-brightness light theme',
    bg: '#ffffff',
    text: '#0f172a',
    accent: '#0e7490',
  },
  {
    id: 'contrast',
    name: 'High contrast',
    description: 'Black and white with yellow accent',
    bg: '#000000',
    text: '#ffffff',
    accent: '#facc15',
  },
  {
    id: 'custom',
    name: 'Custom',
    description: 'Use your own colors',
    bg: '#0b1220',
    text: '#f1f5f9',
    accent: '#22d3ee',
  },
]);

export const FONT_FAMILY_OPTIONS = Object.freeze([
  { value: 'sans', label: 'System sans (Unicode-friendly)' },
  { value: 'serif', label: 'Serif (Georgia / Ethiopic serif)' },
  { value: 'mono', label: 'Monospace' },
  { value: 'accessible', label: 'High-legibility (Verdana)' },
]);

export const DEFAULT_READER_SETTINGS = Object.freeze({
  fontSize: 56,
  fontWeight: 600,
  fontFamily: 'sans',
  lineHeight: 1.5,
  letterSpacing: 0,
  paragraphSpacing: 1,
  textAlign: 'left',
  maxWidth: 920,
  horizontalMargin: 5,
  verticalPosition: 42,
  theme: 'midnight',
  textColor: '#f2f7ff',
  bgColor: '#050910',
  accentColor: '#22d3ee',
  focusFade: true,
  focusLine: true,
  mirror: 'none',
  speed: 140,
  direction: 'forward',
  countdownEnabled: true,
  countdownSeconds: 3,
  endBehavior: 'stop',
  autoHideControls: true,
  progressVisible: true,
  timerVisible: true,
  targetDurationMinutes: 0,
  restorePosition: true,
  pauseOnManualScroll: true,
  shortcutsEnabled: true,
  shortcutOverrides: {},
  voiceLanguage: 'en-US',
  voiceSensitivity: 0.55,
  voicePauseOnSilence: true,
});

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  general: {
    revisionHistory: true,
    confirmDelete: true,
    backupReminderDays: 14,
    showWordStats: true,
    clock: '24h',
  },
  editor: {
    fontFamily: 'sans',
    fontSize: 16,
    lineHeight: 1.75,
    autosave: true,
    spellcheck: true,
    maxWidth: 900,
  },
  reader: DEFAULT_READER_SETTINGS,
  import: {
    maxFileSizeMB: 30,
    cleanupBlankLines: true,
    removePageArtifacts: true,
    ocrLanguage: 'eng',
  },
  recording: {
    videoQuality: '720p',
    includeMic: true,
    preferredMime: 'auto',
  },
});

export const TEXT_ALIGN_OPTIONS = Object.freeze([
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'justify', label: 'Justify' },
]);

export const MIRROR_OPTIONS = Object.freeze([
  { value: 'none', label: 'Normal' },
  { value: 'horizontal', label: 'Mirror horizontally' },
  { value: 'vertical', label: 'Flip vertically' },
  { value: 'both', label: 'Mirror + flip' },
]);

export const END_BEHAVIOR_OPTIONS = Object.freeze([
  { value: 'stop', label: 'Stop at end' },
  { value: 'loop', label: 'Loop continuously' },
  { value: 'return', label: 'Return to start' },
]);

export const OCR_LANGUAGES = Object.freeze([
  { value: 'eng', label: 'English (eng)' },
  { value: 'amh', label: 'Amharic (amh)' },
]);

function numberOf(value, fallback, min, max) {
  return clamp(toFiniteNumber(value, fallback), min, max);
}

function colorOf(value, fallback) {
  return parseColor(value) ? String(value) : fallback;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function sanitizeShortcutOverrides(value) {
  if (!isPlainObject(value)) return {};
  const result = {};
  for (const [action, shortcut] of Object.entries(value)) {
    if (typeof action !== 'string' || typeof shortcut !== 'string') continue;
    if (action.length > 60 || shortcut.length > 40) continue;
    result[action] = shortcut;
  }
  return result;
}

/**
 * Validate and normalise settings. Unknown keys are dropped intentionally so a
 * malformed backup cannot inject arbitrary values into the UI.
 */
export function sanitizeSettings(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const general = isPlainObject(source.general) ? source.general : {};
  const editor = isPlainObject(source.editor) ? source.editor : {};
  const reader = isPlainObject(source.reader) ? source.reader : {};
  const importSettings = isPlainObject(source.import) ? source.import : {};
  const recording = isPlainObject(source.recording) ? source.recording : {};

  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    general: {
      revisionHistory: general.revisionHistory !== false,
      confirmDelete: general.confirmDelete !== false,
      backupReminderDays: numberOf(general.backupReminderDays, 14, 1, 365),
      showWordStats: general.showWordStats !== false,
      clock: oneOf(general.clock, ['12h', '24h'], '24h'),
    },
    editor: {
      fontFamily: oneOf(editor.fontFamily, Object.keys(FONT_STACKS), 'sans'),
      fontSize: numberOf(editor.fontSize, 16, 13, 28),
      lineHeight: numberOf(editor.lineHeight, 1.75, 1.3, 2.4),
      autosave: editor.autosave !== false,
      spellcheck: editor.spellcheck !== false,
      maxWidth: numberOf(editor.maxWidth, 900, 520, 1600),
    },
    reader: {
      fontSize: numberOf(reader.fontSize, DEFAULT_READER_SETTINGS.fontSize, 20, 160),
      fontWeight: numberOf(reader.fontWeight, 600, 300, 900),
      fontFamily: oneOf(reader.fontFamily, Object.keys(FONT_STACKS), 'sans'),
      lineHeight: numberOf(reader.lineHeight, 1.5, 1.1, 2.6),
      letterSpacing: numberOf(reader.letterSpacing, 0, -0.05, 0.25),
      paragraphSpacing: numberOf(reader.paragraphSpacing, 1, 0, 3),
      textAlign: oneOf(reader.textAlign, ['left', 'center', 'justify'], 'left'),
      maxWidth: numberOf(reader.maxWidth, 920, 360, 1600),
      horizontalMargin: numberOf(reader.horizontalMargin, 5, 0, 20),
      verticalPosition: numberOf(reader.verticalPosition, 42, 15, 75),
      theme: oneOf(reader.theme, READER_THEMES.map((theme) => theme.id), 'midnight'),
      textColor: colorOf(reader.textColor, DEFAULT_READER_SETTINGS.textColor),
      bgColor: colorOf(reader.bgColor, DEFAULT_READER_SETTINGS.bgColor),
      accentColor: colorOf(reader.accentColor, DEFAULT_READER_SETTINGS.accentColor),
      focusFade: reader.focusFade !== false,
      focusLine: reader.focusLine !== false,
      mirror: oneOf(reader.mirror, ['none', 'horizontal', 'vertical', 'both'], 'none'),
      speed: numberOf(reader.speed, 140, 40, 400),
      direction: oneOf(reader.direction, ['forward', 'reverse'], 'forward'),
      countdownEnabled: reader.countdownEnabled !== false,
      countdownSeconds: numberOf(reader.countdownSeconds, 3, 0, 10),
      endBehavior: oneOf(reader.endBehavior, ['stop', 'loop', 'return'], 'stop'),
      autoHideControls: reader.autoHideControls !== false,
      progressVisible: reader.progressVisible !== false,
      timerVisible: reader.timerVisible !== false,
      targetDurationMinutes: numberOf(reader.targetDurationMinutes, 0, 0, 600),
      restorePosition: reader.restorePosition !== false,
      pauseOnManualScroll: reader.pauseOnManualScroll !== false,
      shortcutsEnabled: reader.shortcutsEnabled !== false,
      shortcutOverrides: sanitizeShortcutOverrides(reader.shortcutOverrides),
      voiceLanguage: typeof reader.voiceLanguage === 'string' && reader.voiceLanguage.length <= 20 ? reader.voiceLanguage : 'en-US',
      voiceSensitivity: numberOf(reader.voiceSensitivity, 0.55, 0.1, 1),
      voicePauseOnSilence: reader.voicePauseOnSilence !== false,
    },
    import: {
      maxFileSizeMB: numberOf(importSettings.maxFileSizeMB, 30, 1, 200),
      cleanupBlankLines: importSettings.cleanupBlankLines !== false,
      removePageArtifacts: importSettings.removePageArtifacts !== false,
      ocrLanguage: oneOf(importSettings.ocrLanguage, ['eng', 'amh'], 'eng'),
    },
    recording: {
      videoQuality: oneOf(recording.videoQuality, ['480p', '720p', '1080p'], '720p'),
      includeMic: recording.includeMic !== false,
      preferredMime: typeof recording.preferredMime === 'string' ? recording.preferredMime : 'auto',
    },
  };
}

export function getThemePalette(themeId) {
  return READER_THEMES.find((theme) => theme.id === themeId) || READER_THEMES[0];
}

export function resolveReaderColors(reader) {
  if (reader.theme === 'custom') {
    return {
      bg: reader.bgColor,
      text: reader.textColor,
      accent: reader.accentColor,
    };
  }
  const palette = getThemePalette(reader.theme);
  return { bg: palette.bg, text: palette.text, accent: palette.accent };
}

export function getFontStack(family) {
  return FONT_STACKS[family] || FONT_STACKS.sans;
}

export function applyPresetToSettings(current, preset) {
  const presetReader = preset?.settings?.reader;
  if (!isPlainObject(presetReader)) throw new Error('This preset does not contain reader settings.');
  return sanitizeSettings({
    ...current,
    reader: deepMerge(current.reader, presetReader),
  });
}

/**
 * Observable settings store with debounced persistence. UI changes apply
 * immediately; "Saved" is only announced after IndexedDB reports success.
 */
export class SettingsStore {
  #settings;
  #listeners = new Set();
  #saveTimer = null;
  #pendingSave = false;
  #saving = null;
  #lastError = null;

  constructor(settings) {
    this.#settings = sanitizeSettings(settings);
  }

  static async load() {
    const record = await loadSettingsRecord();
    return new SettingsStore(record?.value ?? deepClone(DEFAULT_SETTINGS));
  }

  get() {
    return this.#settings;
  }

  getLastError() {
    return this.#lastError;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit() {
    for (const listener of this.#listeners) {
      try {
        listener(this.#settings);
      } catch (error) {
        console.error('Settings listener failed', error);
      }
    }
  }

  update(patchOrUpdater) {
    const patch = typeof patchOrUpdater === 'function' ? patchOrUpdater(this.#settings) : patchOrUpdater;
    if (!patch) return this.#settings;
    this.#settings = sanitizeSettings(deepMerge(this.#settings, patch));
    this.#emit();
    this.#scheduleSave();
    return this.#settings;
  }

  replaceAll(settings) {
    this.#settings = sanitizeSettings(settings);
    this.#emit();
    this.#scheduleSave();
    return this.#settings;
  }

  setReader(patch) {
    return this.update({ reader: patch });
  }

  resetSection(section) {
    if (section === 'all') {
      this.#settings = sanitizeSettings(DEFAULT_SETTINGS);
    } else if (['general', 'editor', 'reader', 'import', 'recording'].includes(section)) {
      this.#settings = sanitizeSettings({
        ...this.#settings,
        [section]: deepClone(DEFAULT_SETTINGS[section]),
      });
    } else {
      return this.#settings;
    }
    this.#emit();
    this.#scheduleSave();
    return this.#settings;
  }

  #scheduleSave() {
    this.#pendingSave = true;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.saveNow().catch((error) => {
        this.#lastError = error;
        console.error('Could not save settings', error);
      });
    }, 350);
  }

  async saveNow() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    if (this.#saving) {
      await this.#saving.catch(() => {});
    }
    if (!this.#pendingSave) return true;
    this.#pendingSave = false;
    this.#saving = persistSettingsRecord(this.#settings)
      .then(() => {
        this.#lastError = null;
        this.#saving = null;
        this.#emit();
        return true;
      })
      .catch((error) => {
        this.#pendingSave = true;
        this.#lastError = error;
        this.#saving = null;
        this.#emit();
        throw error;
      });
    return this.#saving;
  }

  get isDirty() {
    return this.#pendingSave;
  }
}

export function settingsSummary(settings) {
  return {
    updatedAt: nowIso(),
    speed: settings.reader.speed,
    fontSize: settings.reader.fontSize,
    theme: settings.reader.theme,
  };
}
