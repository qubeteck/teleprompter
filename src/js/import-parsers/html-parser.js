import { cleanImportedText, deriveTitleFromFileName } from '../utils.js';
import { htmlToMarkdown, sanitizeHtml } from '../render-content.js';
import { ImportError } from './errors.js';

function decodeEntities(value = '') {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${value}`, 'text/html');
  return doc.body.textContent || '';
}

export async function parseHtmlFile(file, { cleanup = {}, signal } = {}) {
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
  let text = '';
  try {
    text = await file.text();
  } catch (error) {
    throw new ImportError('The HTML file could not be read.', { detail: error.message });
  }
  if (!text.trim()) throw new ImportError('This HTML file is empty.', { code: 'EMPTY_FILE' });

  // DOMParser creates an inert document: scripts are not executed.
  const doc = new DOMParser().parseFromString(text, 'text/html');
  doc.querySelectorAll('script, style, noscript, template, iframe, object, embed, form, input, button, select, textarea, svg, canvas, link, meta').forEach((node) => node.remove());

  const documentTitle = doc.querySelector('title')?.textContent?.trim() || doc.querySelector('h1')?.textContent?.trim() || '';
  const primary =
    doc.querySelector('article') ||
    doc.querySelector('main') ||
    doc.querySelector('[role="main"]') ||
    doc.body;

  // Remove obvious navigation chrome but keep headings in article content.
  primary.querySelectorAll('nav, aside, footer, [role="navigation"], [role="banner"], [aria-hidden="true"]').forEach((node) => node.remove());

  const sanitized = sanitizeHtml(primary.innerHTML);
  const markdown = htmlToMarkdown(sanitized);
  const content = cleanImportedText(markdown, {
    collapseBlankLines: cleanup.collapseBlankLines !== false,
    removePageArtifacts: Boolean(cleanup.removePageArtifacts),
  });

  if (!content.replace(/[#>*_`\-[\]()]/g, '').trim()) {
    throw new ImportError('No readable content was found in this HTML file.', { code: 'EMPTY_FILE' });
  }

  return {
    title: decodeEntities(documentTitle).slice(0, 120) || deriveTitleFromFileName(file.name),
    content,
    contentFormat: 'markdown',
    sourceFormat: 'html',
    warnings: ['HTML was sanitized and converted to readable Markdown. Scripts, styles, and embedded media were removed.'],
  };
}
