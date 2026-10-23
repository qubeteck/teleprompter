import { cleanImportedText, deriveTitleFromFileName, normalizeNewlines } from '../utils.js';
import { ImportError } from './errors.js';

export async function parseTxtFile(file, { cleanup = {}, signal } = {}) {
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
  let text = '';
  try {
    text = await file.text();
  } catch (error) {
    throw new ImportError('The text file could not be read. It may be locked or corrupted.', { detail: error.message });
  }
  text = normalizeNewlines(text);
  if (!text.trim()) {
    throw new ImportError('This text file is empty. Add some text and try again.', { code: 'EMPTY_FILE' });
  }
  const content = cleanImportedText(text, {
    collapseBlankLines: cleanup.collapseBlankLines !== false,
    removePageArtifacts: Boolean(cleanup.removePageArtifacts),
  });
  if (!content.trim()) throw new ImportError('No readable text was found in this file.', { code: 'EMPTY_FILE' });
  return {
    title: deriveTitleFromFileName(file.name),
    content,
    contentFormat: 'plain',
    sourceFormat: 'txt',
    warnings: [],
  };
}
