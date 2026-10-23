import { normalizeImportedScript } from '../script-validation.js';
import { deriveTitleFromFileName, getExtension, safeJsonParse } from '../utils.js';
import { ImportError } from './errors.js';

export async function parseJsonFile(file, { signal } = {}) {
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
  let text = '';
  try {
    text = await file.text();
  } catch (error) {
    throw new ImportError('The JSON file could not be read.', { detail: error?.message });
  }
  const parsed = safeJsonParse(text);
  if (!parsed.ok) {
    throw new ImportError('This file is not valid JSON. Check the file and try again.', { code: 'JSON_INVALID' });
  }
  const data = parsed.value;

  if (data?.schema === 'teleprompter-studio/backup' || (Array.isArray(data?.data?.scripts) && data?.schema)) {
    throw new ImportError('This is a full studio backup. Restore it from Settings → Backup & restore so nothing is overwritten silently.', {
      code: 'BACKUP_FILE',
      backupFile: file,
    });
  }
  if (data?.schema === 'teleprompter-studio/preset' || data?.preset) {
    throw new ImportError('This is a teleprompter preset, not a script. Import it from Settings → Presets.', {
      code: 'PRESET_FILE',
    });
  }

  let record = data?.script && typeof data.script === 'object' ? data.script : data;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new ImportError('This JSON file does not contain a recognizable script.', { code: 'JSON_SHAPE_INVALID' });
  }
  if (typeof record.content !== 'string') {
    throw new ImportError('This JSON object has no script content. Expected a "content" property.', { code: 'JSON_SHAPE_INVALID' });
  }

  // Give raw JSON records sensible defaults without trusting invalid schema
  // versions. Validation below enforces ids, sizes, and dates.
  if (!record.title) record.title = deriveTitleFromFileName(file.name);
  if (!record.contentFormat) record.contentFormat = 'plain';
  if (!record.id) record.id = `script-${crypto.randomUUID?.() || Date.now()}`;
  if (!record.createdAt) record.createdAt = new Date().toISOString();
  if (!record.updatedAt) record.updatedAt = record.createdAt;

  try {
    const normalized = await normalizeImportedScript(record);
    return {
      title: normalized.title,
      content: normalized.content,
      contentFormat: normalized.contentFormat,
      sourceFormat: 'json',
      warnings: ['Imported from a JSON script export. Formatting metadata was preserved where possible.'],
      importedRecord: normalized,
    };
  } catch (error) {
    throw new ImportError(`The JSON script failed validation: ${error.message}`, { code: 'JSON_VALIDATION_FAILED' });
  }
}
