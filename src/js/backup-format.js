import {
  MAX_CONTENT_CHARACTERS,
  normalizeContentFormat,
  normalizeTitle,
  prepareScriptRecord,
  validateFolderRecord,
  validateScriptRecord,
  ValidationError,
} from './script-validation.js';
import { normalizePreset, validatePresetRecord } from './presets.js';
import { sanitizeSettings } from './settings.js';
import { deepClone, formatBytes, isPlainObject, nowIso, uid } from './utils.js';

export const BACKUP_SCHEMA = 'teleprompter-studio/backup';
export const BACKUP_SCHEMA_VERSION = 1;
export const MAX_BACKUP_BYTES = 120 * 1024 * 1024;
export const LIMITS = Object.freeze({
  scripts: 10_000,
  folders: 2_000,
  presets: 1_000,
  revisions: 50_000,
  tagsPerScript: 30,
});

export class BackupValidationError extends Error {
  constructor(message, { code = 'BACKUP_INVALID', details = [] } = {}) {
    super(message);
    this.name = 'BackupValidationError';
    this.code = code;
    this.details = details;
  }
}

export function createBackupObject(data, { includeRevisions = true, appVersion = '1.0.0' } = {}) {
  return {
    schema: BACKUP_SCHEMA,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion,
    exportedAt: nowIso(),
    summary: {
      scripts: data.scripts?.length || 0,
      folders: data.folders?.length || 0,
      presets: data.presets?.length || 0,
      revisions: includeRevisions ? data.revisions?.length || 0 : 0,
      includesSettings: Boolean(data.settings),
    },
    data: {
      scripts: data.scripts || [],
      folders: data.folders || [],
      presets: data.presets || [],
      settings: data.settings || null,
      revisions: includeRevisions ? data.revisions || [] : [],
    },
  };
}

export function serializeBackup(backup, { pretty = false } = {}) {
  return JSON.stringify(backup, null, pretty ? 2 : 0);
}

function assertUniqueIds(items, label) {
  const seen = new Set();
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== 'object') {
      throw new BackupValidationError(`${label} entry ${index + 1} is not an object.`, {
        details: [`${label}: entry ${index + 1} is not an object.`],
      });
    }
    if (typeof item.id !== 'string' || !item.id.trim()) {
      throw new BackupValidationError(`${label} entry ${index + 1} is missing an id.`, {
        details: [`${label}: entry ${index + 1} has no id.`],
      });
    }
    if (seen.has(item.id)) {
      throw new BackupValidationError(`${label} contains duplicate id "${item.id}".`, {
        code: 'DUPLICATE_ID',
        details: [`${label}: duplicate id ${item.id}`],
      });
    }
    seen.add(item.id);
  }
}

function normalizeFolderRecord(folder, index) {
  validateFolderRecord(folder, { index });
  return {
    id: folder.id.trim(),
    name: String(folder.name).replace(/\s+/g, ' ').trim().slice(0, 80),
    color: typeof folder.color === 'string' && /^#[0-9a-f]{6}$/i.test(folder.color) ? folder.color : null,
    createdAt: folder.createdAt || nowIso(),
    updatedAt: folder.updatedAt || folder.createdAt || nowIso(),
  };
}

function validateRevisionRecord(revision, index) {
  if (!revision || typeof revision !== 'object') {
    throw new BackupValidationError(`Revision ${index + 1} is invalid.`);
  }
  if (typeof revision.id !== 'string' || !revision.id) throw new BackupValidationError(`Revision ${index + 1} is missing an id.`);
  if (typeof revision.scriptId !== 'string' || !revision.scriptId) throw new BackupValidationError(`Revision ${index + 1} is missing a script id.`);
  if (typeof revision.content !== 'string') throw new BackupValidationError(`Revision ${index + 1} is missing content.`);
  if (revision.content.length > MAX_CONTENT_CHARACTERS) throw new BackupValidationError(`Revision ${index + 1} is too large.`);
  if (typeof revision.createdAt !== 'string' || Number.isNaN(new Date(revision.createdAt).getTime())) {
    throw new BackupValidationError(`Revision ${index + 1} has an invalid timestamp.`);
  }
  return {
    id: revision.id,
    scriptId: revision.scriptId,
    title: normalizeTitle(revision.title, 'Script revision'),
    content: revision.content,
    contentFormat: normalizeContentFormat(revision.contentFormat),
    createdAt: new Date(revision.createdAt).toISOString(),
    reason: typeof revision.reason === 'string' ? revision.reason.slice(0, 80) : 'backup',
  };
}

/**
 * Validates and normalises a parsed backup object. Throws BackupValidationError
 * before any database write occurs.
 */
export async function validateBackup(backup, { maxBytes = MAX_BACKUP_BYTES } = {}) {
  if (!isPlainObject(backup)) {
    throw new BackupValidationError('The backup file does not contain a JSON object.', { code: 'BACKUP_SHAPE_INVALID' });
  }
  if (backup.schema !== BACKUP_SCHEMA) {
    if (backup.schema?.startsWith?.('teleprompter-studio/') && backup.schema !== BACKUP_SCHEMA) {
      throw new BackupValidationError('This JSON file is not a full studio backup. Use the appropriate import or restore action.', {
        code: 'WRONG_SCHEMA',
      });
    }
    throw new BackupValidationError('This is not an Advanced Teleprompter Studio backup file.', { code: 'WRONG_SCHEMA' });
  }
  const version = Number(backup.schemaVersion);
  if (!Number.isInteger(version) || version < 1) {
    throw new BackupValidationError('The backup has an invalid schema version.', { code: 'BACKUP_VERSION_INVALID' });
  }
  if (version > BACKUP_SCHEMA_VERSION) {
    throw new BackupValidationError(
      `This backup uses schema version ${version}, but this app supports up to version ${BACKUP_SCHEMA_VERSION}. Update the app before restoring.`,
      { code: 'BACKUP_VERSION_UNSUPPORTED' },
    );
  }
  const data = backup.data;
  if (!isPlainObject(data)) {
    throw new BackupValidationError('The backup is missing its data section.', { code: 'BACKUP_SHAPE_INVALID' });
  }

  const scripts = Array.isArray(data.scripts) ? data.scripts : [];
  const folders = Array.isArray(data.folders) ? data.folders : [];
  const presets = Array.isArray(data.presets) ? data.presets : [];
  const revisions = Array.isArray(data.revisions) ? data.revisions : [];

  if (scripts.length > LIMITS.scripts) {
    throw new BackupValidationError(`This backup contains too many scripts (${scripts.length.toLocaleString()}; maximum ${LIMITS.scripts.toLocaleString()}).`);
  }
  if (folders.length > LIMITS.folders) throw new BackupValidationError(`This backup contains too many folders (maximum ${LIMITS.folders}).`);
  if (presets.length > LIMITS.presets) throw new BackupValidationError(`This backup contains too many presets (maximum ${LIMITS.presets}).`);
  if (revisions.length > LIMITS.revisions) throw new BackupValidationError(`This backup contains too many revisions (maximum ${LIMITS.revisions}).`);

  assertUniqueIds(scripts, 'Scripts');
  assertUniqueIds(folders, 'Folders');
  assertUniqueIds(presets, 'Presets');

  // Size guard after parsing (callers also check file size before reading).
  const roughBytes = JSON.stringify(backup).length * 2;
  if (roughBytes > maxBytes * 2) {
    throw new BackupValidationError(`The backup is too large to process safely (${formatBytes(roughBytes)}).`, { code: 'BACKUP_TOO_LARGE' });
  }

  const errors = [];
  const normalizedScripts = [];
  for (const [index, raw] of scripts.entries()) {
    try {
      validateScriptRecord(raw, { index });
      const record = await prepareScriptRecord(deepClone(raw));
      normalizedScripts.push(record);
    } catch (error) {
      errors.push(`Script ${index + 1} (${raw?.title || 'untitled'}): ${error.message}`);
    }
  }
  if (errors.length) {
    throw new BackupValidationError(
      `The backup contains invalid script data. Nothing has been imported.`,
      { code: 'SCRIPTS_INVALID', details: errors.slice(0, 20) },
    );
  }

  const normalizedFolders = folders.map(normalizeFolderRecord);

  const normalizedPresets = [];
  for (const [index, preset] of presets.entries()) {
    try {
      validatePresetRecord(preset, { index });
      const normalized = normalizePreset(preset);
      if (normalized) normalizedPresets.push(normalized);
    } catch (error) {
      throw new BackupValidationError(`Preset ${index + 1} is invalid: ${error.message}`, { code: 'PRESETS_INVALID' });
    }
  }

  const scriptIds = new Set(normalizedScripts.map((script) => script.id));
  const normalizedRevisions = [];
  for (const [index, revision] of revisions.entries()) {
    const normalized = validateRevisionRecord(revision, index);
    if (!scriptIds.has(normalized.scriptId) && !scripts.some((script) => script.id === normalized.scriptId)) {
      // Orphaned revisions are not worth failing the entire restore; skip them
      // with a visible warning instead.
      continue;
    }
    normalizedRevisions.push(normalized);
  }

  const settings = data.settings == null ? null : sanitizeSettings(data.settings);

  const totalWords = normalizedScripts.reduce((sum, script) => sum + (script.wordCount || 0), 0);
  return {
    schema: BACKUP_SCHEMA,
    schemaVersion: version,
    appVersion: typeof backup.appVersion === 'string' ? backup.appVersion.slice(0, 40) : 'unknown',
    exportedAt: typeof backup.exportedAt === 'string' ? backup.exportedAt : null,
    data: {
      scripts: normalizedScripts,
      folders: normalizedFolders,
      presets: normalizedPresets,
      revisions: normalizedRevisions,
      settings,
    },
    summary: {
      scripts: normalizedScripts.length,
      folders: normalizedFolders.length,
      presets: normalizedPresets.length,
      revisions: normalizedRevisions.length,
      words: totalWords,
      activeScripts: normalizedScripts.filter((script) => !script.deletedAt).length,
      trashedScripts: normalizedScripts.filter((script) => script.deletedAt).length,
      includesSettings: Boolean(settings),
      sourceVersion: version,
      appVersion: backup.appVersion || 'unknown',
      exportedAt: backup.exportedAt || null,
    },
  };
}

function uniqueName(base, usedNames) {
  let candidate = base;
  let counter = 2;
  while (usedNames.has(candidate.toLocaleLowerCase())) {
    candidate = `${base} (${counter})`;
    counter += 1;
  }
  usedNames.add(candidate.toLocaleLowerCase());
  return candidate;
}

function stableScriptContent(record) {
  return `${record.contentFormat}:${record.content}`;
}

/**
 * Pure merge planner. Returns records to write plus human-readable stats.
 * Existing records are never modified or overwritten.
 */
export function planMerge(existing, incoming, { includeFolders = true, includePresets = true } = {}) {
  const existingScripts = existing.scripts || [];
  const existingFolders = existing.folders || [];
  const existingPresets = existing.presets || [];
  const incomingScripts = incoming.scripts || [];
  const incomingFolders = incoming.folders || [];
  const incomingPresets = incoming.presets || [];

  const usedFolderNames = new Set(existingFolders.map((folder) => folder.name.toLocaleLowerCase()));
  const folderById = new Map(existingFolders.map((folder) => [folder.id, folder]));
  const incomingFolderIdToExisting = new Map();
  const foldersToPut = [];

  if (includeFolders) {
    for (const folder of incomingFolders) {
      const sameId = folderById.get(folder.id);
      if (sameId) {
        incomingFolderIdToExisting.set(folder.id, sameId.id);
        continue;
      }
      const sameName = existingFolders.find((item) => item.name.toLocaleLowerCase() === folder.name.toLocaleLowerCase());
      if (sameName) {
        incomingFolderIdToExisting.set(folder.id, sameName.id);
        continue;
      }
      const clone = { ...folder };
      if (!clone.name) clone.name = 'Imported folder';
      const normalizedName = uniqueName(clone.name, usedFolderNames);
      if (normalizedName !== clone.name) clone.name = normalizedName;
      foldersToPut.push(clone);
      incomingFolderIdToExisting.set(folder.id, clone.id);
      folderById.set(clone.id, clone);
    }
  }

  const existingScriptById = new Map(existingScripts.map((script) => [script.id, script]));
  const scriptsToPut = [];
  const scriptIdMap = new Map();
  const stats = {
    scriptsAdded: 0,
    scriptsRenamed: 0,
    scriptsSkipped: 0,
    foldersAdded: 0,
    foldersMerged: 0,
    presetsAdded: 0,
    presetsRenamed: 0,
    presetsSkipped: 0,
    revisionsAdded: 0,
  };
  const warnings = [];

  for (const incomingScript of incomingScripts) {
    const folderId = incomingScript.folderId ? incomingFolderIdToExisting.get(incomingScript.folderId) || null : null;
    const candidate = { ...incomingScript, folderId };
    const match = existingScriptById.get(incomingScript.id);
    if (!match) {
      scriptsToPut.push(candidate);
      scriptIdMap.set(incomingScript.id, candidate.id);
      stats.scriptsAdded += 1;
      continue;
    }
    if (stableScriptContent(match) === stableScriptContent(incomingScript)) {
      stats.scriptsSkipped += 1;
      continue;
    }
    const clone = {
      ...candidate,
      id: uid('script-'),
      title: normalizeTitle(`${incomingScript.title} (imported)`),
      lastOpenedAt: null,
      lastPosition: null,
      isFavorite: incomingScript.isFavorite,
      updatedAt: nowIso(),
    };
    scriptsToPut.push(clone);
    scriptIdMap.set(incomingScript.id, clone.id);
    stats.scriptsRenamed += 1;
    warnings.push(`"${incomingScript.title}" had an id conflict and was imported as "${clone.title}".`);
  }

  // Add revisions only for imported scripts whose content was actually added.
  const revisionsToPut = [];
  for (const revision of incoming.revisions || []) {
    const mappedScriptId = scriptIdMap.get(revision.scriptId);
    if (!mappedScriptId) continue;
    revisionsToPut.push({ ...revision, id: uid('revision-'), scriptId: mappedScriptId });
    stats.revisionsAdded += 1;
  }

  const usedPresetNames = new Set(existingPresets.map((preset) => preset.name.toLocaleLowerCase()));
  const presetsToPut = [];
  if (includePresets) {
    const existingPresetById = new Map(existingPresets.map((preset) => [preset.id, preset]));
    for (const preset of incomingPresets) {
      const sameId = existingPresetById.get(preset.id);
      if (sameId) {
        stats.presetsSkipped += 1;
        continue;
      }
      const clone = { ...preset, id: uid('preset-') };
      const unique = uniqueName(preset.name, usedPresetNames);
      if (unique !== preset.name) {
        clone.name = unique;
        stats.presetsRenamed += 1;
        warnings.push(`Preset "${preset.name}" was imported as "${clone.name}" to avoid a name conflict.`);
      } else {
        stats.presetsAdded += 1;
      }
      presetsToPut.push(clone);
    }
  }

  stats.foldersAdded = foldersToPut.length;
  stats.foldersMerged = incomingFolderIdToExisting.size - foldersToPut.length;

  return {
    folders: includeFolders ? foldersToPut : [],
    scripts: scriptsToPut,
    presets: presetsToPut,
    revisions: revisionsToPut,
    stats,
    warnings: warnings.slice(0, 50),
  };
}

/**
 * Prepares a replace-style restore without writing. The caller must confirm
 * before invoking replaceAllData().
 */
export function planReplace(incoming, { includeFolders = true, includePresets = true } = {}) {
  return {
    folders: includeFolders ? incoming.folders || [] : [],
    scripts: (incoming.scripts || []).map((script) => (includeFolders ? script : { ...script, folderId: null })),
    presets: includePresets ? incoming.presets || [] : [],
    revisions: incoming.revisions || [],
    stats: {
      scriptsAdded: incoming.scripts?.length || 0,
      scriptsRenamed: 0,
      scriptsSkipped: 0,
      foldersAdded: includeFolders ? incoming.folders?.length || 0 : 0,
      foldersMerged: 0,
      presetsAdded: includePresets ? incoming.presets?.length || 0 : 0,
      presetsRenamed: 0,
      presetsSkipped: 0,
      revisionsAdded: incoming.revisions?.length || 0,
    },
    warnings: [],
  };
}

export function backupSummaryText(summary) {
  return `${summary.scripts} script${summary.scripts === 1 ? '' : 's'}, ${summary.folders} folder${summary.folders === 1 ? '' : 's'}, ${summary.presets} preset${summary.presets === 1 ? '' : 's'}${summary.includesSettings ? ', settings' : ''}`;
}

export function validatePresetImport(data) {
  if (!isPlainObject(data) || data.schema !== 'teleprompter-studio/preset') {
    throw new BackupValidationError('This is not a valid teleprompter preset file.', { code: 'PRESET_INVALID' });
  }
  if (Number(data.schemaVersion) > 1) {
    throw new BackupValidationError('This preset was created by a newer app version.', { code: 'BACKUP_VERSION_UNSUPPORTED' });
  }
  validatePresetRecord({ ...data.preset, id: 'imported' }, { index: 0 });
  const normalized = normalizePreset({ ...data.preset, id: uid('preset-') });
  if (!normalized) throw new BackupValidationError('The preset contains no usable settings.', { code: 'PRESET_INVALID' });
  return normalized;
}

export { ValidationError };
