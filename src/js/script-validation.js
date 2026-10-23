import {
  clamp,
  countCharacters,
  countParagraphs,
  countWords,
  deepClone,
  hashText,
  nowIso,
  sanitizeFileName,
  uid,
} from './utils.js';

export const SCRIPT_SCHEMA_VERSION = 1;
export const MAX_TITLE_LENGTH = 200;
export const MAX_CONTENT_CHARACTERS = 5_000_000;
export const MAX_TAGS = 30;
export const MAX_TAG_LENGTH = 40;
export const CONTENT_FORMATS = Object.freeze(['plain', 'markdown']);

export class ValidationError extends Error {
  constructor(message, { field = null, code = 'VALIDATION_ERROR' } = {}) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.code = code;
  }
}

function cleanText(value = '') {
  return String(value ?? '')
    .replace(/\uFEFF/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export function normalizeContent(content = '') {
  return cleanText(content);
}

export function normalizeTitle(title, fallback = 'Untitled script') {
  const cleaned = cleanText(title).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
  return cleaned || fallback;
}

export function normalizeContentFormat(value, fallback = 'plain') {
  return CONTENT_FORMATS.includes(value) ? value : fallback;
}

export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const normalized = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const tag = raw.replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH);
    if (!tag) continue;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag);
    if (normalized.length >= MAX_TAGS) break;
  }
  return normalized;
}

export function normalizeLastPosition(value) {
  if (!value || typeof value !== 'object') return null;
  const progress = Number(value.progress);
  if (!Number.isFinite(progress)) return null;
  return {
    progress: clamp(progress, 0, 1),
    scrollTop: Number.isFinite(Number(value.scrollTop)) ? Math.max(0, Number(value.scrollTop)) : 0,
    updatedAt: isValidDate(value.updatedAt) ? new Date(value.updatedAt).toISOString() : nowIso(),
  };
}

function isValidDate(value) {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

function toIso(value, fallback) {
  return isValidDate(value) ? new Date(value).toISOString() : fallback;
}

export function scriptCounts(content, wordRate = 140) {
  const wordCount = countWords(content);
  return {
    wordCount,
    characterCount: countCharacters(content),
    paragraphCount: countParagraphs(content),
    estimatedSeconds: Math.round((wordCount / clamp(wordRate, 30, 600)) * 60),
  };
}

export async function computeContentHash(content, contentFormat = 'plain') {
  const normalized = normalizeContent(content).trim();
  return hashText(`${normalizeContentFormat(contentFormat)}:${normalized}`);
}

/**
 * Produces a fully-normalized, validated record ready for IndexedDB.
 * Existing record fields that are not part of the editable payload are kept.
 */
export async function prepareScriptRecord(input, { existing = null, wordRate = 140 } = {}) {
  const source = existing ? { ...existing, ...input } : { ...input };
  const now = nowIso();
  const content = normalizeContent(source.content);
  if (content.length > MAX_CONTENT_CHARACTERS) {
    throw new ValidationError(
      `This script is too large (${content.length.toLocaleString()} characters). The limit is ${MAX_CONTENT_CHARACTERS.toLocaleString()} characters.`,
      { code: 'CONTENT_TOO_LARGE', field: 'content' },
    );
  }
  const contentFormat = normalizeContentFormat(source.contentFormat);
  const title = normalizeTitle(source.title);
  const createdAt = toIso(source.createdAt, now);
  const updatedAt = toIso(source.updatedAt, now);
  const lastOpenedAt = isValidDate(source.lastOpenedAt) ? new Date(source.lastOpenedAt).toISOString() : null;
  const deletedAt = isValidDate(source.deletedAt) ? new Date(source.deletedAt).toISOString() : null;
  const counts = scriptCounts(content, wordRate);
  const contentHash = await computeContentHash(content, contentFormat);

  const record = {
    id: typeof source.id === 'string' && source.id.trim() ? source.id.trim() : uid('script-'),
    schemaVersion: SCRIPT_SCHEMA_VERSION,
    title,
    content,
    contentFormat,
    folderId: typeof source.folderId === 'string' && source.folderId ? source.folderId : null,
    tags: normalizeTags(source.tags),
    isFavorite: Boolean(source.isFavorite),
    createdAt,
    updatedAt,
    lastOpenedAt,
    deletedAt,
    wordCount: counts.wordCount,
    characterCount: counts.characterCount,
    paragraphCount: counts.paragraphCount,
    contentHash,
    sourceFileName: source.sourceFileName ? sanitizeFileName(source.sourceFileName, 'imported-file') : null,
    sourceFormat: source.sourceFormat ? String(source.sourceFormat).slice(0, 40) : null,
    lastPosition: normalizeLastPosition(source.lastPosition),
  };

  // Reject a deleted timestamp older than creation only by normalizing rather
  // than throwing; imported records from other time zones are common.
  return record;
}

export function validateScriptRecord(record, { index = 0, strict = true } = {}) {
  const label = `Script ${index + 1}`;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new ValidationError(`${label} is not an object.`);
  }
  if (typeof record.id !== 'string' || !record.id.trim()) {
    throw new ValidationError(`${label} is missing an id.`);
  }
  if (typeof record.title !== 'string' || !record.title.trim()) {
    throw new ValidationError(`${label} is missing a title.`);
  }
  if (record.title.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(`${label} has a title longer than ${MAX_TITLE_LENGTH} characters.`);
  }
  if (typeof record.content !== 'string') {
    throw new ValidationError(`${label} is missing content.`);
  }
  if (record.content.length > MAX_CONTENT_CHARACTERS) {
    throw new ValidationError(`${label} is too large to import safely.`);
  }
  if (record.contentFormat && !CONTENT_FORMATS.includes(record.contentFormat)) {
    throw new ValidationError(`${label} uses an unsupported content format.`);
  }
  if (record.tags != null && !Array.isArray(record.tags)) {
    throw new ValidationError(`${label} has invalid tags.`);
  }
  if (strict && record.createdAt && !isValidDate(record.createdAt)) {
    throw new ValidationError(`${label} has an invalid creation date.`);
  }
  if (strict && record.updatedAt && !isValidDate(record.updatedAt)) {
    throw new ValidationError(`${label} has an invalid update date.`);
  }
  return true;
}

export async function normalizeImportedScript(record, options = {}) {
  validateScriptRecord(record, options);
  return prepareScriptRecord(deepClone(record), options);
}

export function createBlankScript(overrides = {}) {
  const now = nowIso();
  return {
    id: uid('script-'),
    schemaVersion: SCRIPT_SCHEMA_VERSION,
    title: 'Untitled script',
    content: '',
    contentFormat: 'plain',
    folderId: null,
    tags: [],
    isFavorite: false,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: null,
    deletedAt: null,
    wordCount: 0,
    characterCount: 0,
    paragraphCount: 0,
    contentHash: '',
    sourceFileName: null,
    sourceFormat: null,
    lastPosition: null,
    ...overrides,
  };
}

export function normalizeFolderName(name) {
  const value = cleanText(name).replace(/\s+/g, ' ').trim().slice(0, 80);
  return value;
}

export function createFolderRecord({ name, color = null } = {}) {
  const normalized = normalizeFolderName(name);
  if (!normalized) throw new ValidationError('Folder name is required.', { field: 'name' });
  const now = nowIso();
  return {
    id: uid('folder-'),
    name: normalized,
    color: color || null,
    createdAt: now,
    updatedAt: now,
  };
}

export function validateFolderRecord(folder, { index = 0 } = {}) {
  if (!folder || typeof folder !== 'object') {
    throw new ValidationError(`Folder ${index + 1} is invalid.`);
  }
  if (typeof folder.id !== 'string' || !folder.id.trim()) throw new ValidationError(`Folder ${index + 1} is missing an id.`);
  if (typeof folder.name !== 'string' || !folder.name.trim()) throw new ValidationError(`Folder ${index + 1} is missing a name.`);
  if (folder.name.length > 80) throw new ValidationError(`Folder ${index + 1} has an overly long name.`);
  return true;
}
