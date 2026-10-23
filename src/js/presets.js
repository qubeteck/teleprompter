import { deepClone, deepMerge, isPlainObject, nowIso, sanitizeFileName, uid } from './utils.js';
import { DEFAULT_READER_SETTINGS, applyPresetToSettings, sanitizeSettings } from './settings.js';
import { ValidationError } from './script-validation.js';

const LAST_PRESET_KEY = 'atp:last-preset';

function readerWith(overrides) {
  return sanitizeSettings({ reader: deepMerge(DEFAULT_READER_SETTINGS, overrides) }).reader;
}

function builtInPreset(id, name, description, iconName, overrides) {
  return {
    id: `builtin-${id}`,
    builtIn: true,
    name,
    description,
    icon: iconName,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    settings: { reader: readerWith(overrides) },
  };
}

export const BUILT_IN_PRESETS = Object.freeze([
  builtInPreset(
    'standard',
    'Standard reading',
    'Balanced size, speed, and spacing for everyday scripts.',
    'book',
    {},
  ),
  builtInPreset(
    'youtube',
    'YouTube / video',
    'Studio black with a steady video-friendly pace and compact width.',
    'video',
    {
      theme: 'black',
      bgColor: '#000000',
      textColor: '#f8fafc',
      accentColor: '#facc15',
      fontSize: 50,
      fontWeight: 550,
      lineHeight: 1.45,
      maxWidth: 840,
      horizontalMargin: 4,
      verticalPosition: 38,
      speed: 132,
      countdownEnabled: true,
      countdownSeconds: 3,
      focusLine: true,
      focusFade: true,
      endBehavior: 'stop',
    },
  ),
  builtInPreset(
    'live',
    'Live presentation',
    'Large stage text with a calmer pace and generous margins.',
    'monitor',
    {
      fontSize: 68,
      fontWeight: 650,
      lineHeight: 1.4,
      maxWidth: 1080,
      horizontalMargin: 7,
      speed: 128,
      textAlign: 'left',
      verticalPosition: 40,
      countdownSeconds: 5,
      focusLine: true,
    },
  ),
  builtInPreset(
    'vertical',
    'Vertical / short-form',
    'Narrow, centered layout tuned for phone-style recording.',
    'smartphone',
    {
      fontSize: 44,
      lineHeight: 1.55,
      maxWidth: 620,
      horizontalMargin: 6,
      textAlign: 'center',
      speed: 118,
      verticalPosition: 36,
      countdownSeconds: 3,
    },
  ),
  builtInPreset(
    'mirror',
    'Mirror rig',
    'Horizontally mirrored, high-contrast output for beam-splitter rigs.',
    'flipHorizontal',
    {
      mirror: 'horizontal',
      theme: 'contrast',
      bgColor: '#000000',
      textColor: '#ffffff',
      accentColor: '#facc15',
      fontSize: 64,
      fontWeight: 700,
      lineHeight: 1.4,
      maxWidth: 1100,
      speed: 120,
      focusLine: false,
      focusFade: false,
    },
  ),
  builtInPreset(
    'large-text',
    'Large-text accessibility',
    'Extra-large, high-contrast text with the most legible font stack.',
    'eye',
    {
      theme: 'contrast',
      bgColor: '#000000',
      textColor: '#ffffff',
      accentColor: '#facc15',
      fontSize: 86,
      fontWeight: 700,
      fontFamily: 'accessible',
      lineHeight: 1.65,
      letterSpacing: 0.01,
      paragraphSpacing: 1.3,
      maxWidth: 1180,
      horizontalMargin: 3,
      speed: 96,
      focusLine: false,
      focusFade: false,
    },
  ),
]);

export function getBuiltInPresets() {
  return BUILT_IN_PRESETS.map((preset) => deepClone(preset));
}

export function getAllPresets(userPresets = []) {
  return [...getBuiltInPresets(), ...userPresets.map(normalizePreset)];
}

export function getPresetById(presets, id) {
  return presets.find((preset) => preset.id === id) || null;
}

export function normalizePresetName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function createUserPreset(settings, { name, description = '' } = {}) {
  const presetName = normalizePresetName(name);
  if (!presetName) throw new ValidationError('Preset name is required.', { field: 'name' });
  const sanitized = sanitizeSettings(settings);
  const now = nowIso();
  return {
    id: uid('preset-'),
    builtIn: false,
    name: presetName,
    description: String(description ?? '').trim().slice(0, 200),
    icon: 'sliders',
    createdAt: now,
    updatedAt: now,
    settings: { reader: deepClone(sanitized.reader) },
  };
}

export function normalizePreset(record) {
  if (!record || typeof record !== 'object') return null;
  if (!isPlainObject(record.settings?.reader)) return null;
  const reader = sanitizeSettings({ reader: record.settings.reader }).reader;
  return {
    id: typeof record.id === 'string' && record.id ? record.id : uid('preset-'),
    builtIn: false,
    name: normalizePresetName(record.name) || 'Imported preset',
    description: String(record.description ?? '').slice(0, 200),
    icon: typeof record.icon === 'string' ? record.icon.slice(0, 40) : 'sliders',
    createdAt: record.createdAt || nowIso(),
    updatedAt: record.updatedAt || nowIso(),
    settings: { reader },
  };
}

export function validatePresetRecord(record, { index = 0 } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new ValidationError(`Preset ${index + 1} is not an object.`);
  }
  if (typeof record.name !== 'string' || !record.name.trim()) {
    throw new ValidationError(`Preset ${index + 1} is missing a name.`);
  }
  if (record.name.length > 80) {
    throw new ValidationError(`Preset ${index + 1} has a name longer than 80 characters.`);
  }
  if (!isPlainObject(record.settings?.reader)) {
    throw new ValidationError(`Preset ${index + 1} does not contain reader settings.`);
  }
  return true;
}

export function applyPreset(settingsStore, preset) {
  const current = settingsStore.get();
  const next = applyPresetToSettings(current, preset);
  settingsStore.update(next);
  rememberLastPreset(preset.id);
  return next;
}

export function rememberLastPreset(id) {
  try {
    localStorage.setItem(LAST_PRESET_KEY, id);
  } catch {
    // Preferences are optional.
  }
}

export function getLastPresetId() {
  try {
    return localStorage.getItem(LAST_PRESET_KEY);
  } catch {
    return null;
  }
}

export function presetFileName(preset) {
  return `${sanitizeFileName(preset.name, 'teleprompter-preset')}.preset.json`;
}

export function serializePreset(preset) {
  return {
    schema: 'teleprompter-studio/preset',
    schemaVersion: 1,
    exportedAt: nowIso(),
    preset: {
      name: preset.name,
      description: preset.description || '',
      settings: { reader: deepClone(preset.settings.reader) },
    },
  };
}
