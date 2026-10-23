import { cleanImportedText, deriveTitleFromFileName, normalizeNewlines } from '../utils.js';
import { renderMarkdown } from '../render-content.js';
import { ImportError } from './errors.js';

export async function parseMarkdownFile(file, { cleanup = {}, signal } = {}) {
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
  let text = '';
  try {
    text = await file.text();
  } catch (error) {
    throw new ImportError('The Markdown file could not be read.', { detail: error.message });
  }
  text = normalizeNewlines(text).replace(/^\uFEFF/, '');
  if (!text.trim()) throw new ImportError('This Markdown file is empty.', { code: 'EMPTY_FILE' });

  const content = cleanImportedText(text, {
    collapseBlankLines: cleanup.collapseBlankLines !== false,
    removePageArtifacts: Boolean(cleanup.removePageArtifacts),
  });

  // Render once during the review step so malformed content fails early and
  // the preview can show exactly what the reader will show.
  const rendered = renderMarkdown(content);
  if (!rendered.replace(/<[^>]*>/g, '').trim()) {
    throw new ImportError('The Markdown file did not contain readable text.', { code: 'EMPTY_FILE' });
  }

  const heading = /^#{1,6}\s+(.+)$/m.exec(content)?.[1]?.replace(/[*_`]/g, '').trim();
  return {
    title: heading?.slice(0, 120) || deriveTitleFromFileName(file.name),
    content,
    contentFormat: 'markdown',
    sourceFormat: 'markdown',
    warnings: [],
  };
}
