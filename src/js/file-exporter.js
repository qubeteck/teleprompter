import { renderScriptHtml, stripMarkdownToText } from './render-content.js';
import { escapeHtml, downloadBlob, sanitizeFileName, formatDate, formatDuration, countWords } from './utils.js';
import { APP_NAME, APP_VERSION, resolveReaderColors, getFontStack } from './settings.js';

export const SCRIPT_EXPORT_FORMATS = Object.freeze([
  { id: 'txt', label: 'Plain text (.txt)', extension: 'txt', mime: 'text/plain;charset=utf-8', description: 'Readable text for any teleprompter or editor.' },
  { id: 'md', label: 'Markdown (.md)', extension: 'md', mime: 'text/markdown;charset=utf-8', description: 'Preserves headings, lists, and emphasis.' },
  { id: 'html', label: 'HTML document (.html)', extension: 'html', mime: 'text/html;charset=utf-8', description: 'Self-contained, sanitized, print-friendly document.' },
  { id: 'json', label: 'Script JSON (.json)', extension: 'json', mime: 'application/json;charset=utf-8', description: 'Complete script data for re-import.' },
]);

export function exportFileName(script, extension) {
  return `${sanitizeFileName(script.title || 'script', 'script')}.${extension}`;
}

function scriptToTxt(script) {
  if (script.contentFormat === 'markdown') return stripMarkdownToText(script.content).trim();
  return script.content.replace(/\r\n?/g, '\n').trim();
}

function scriptToMarkdown(script) {
  return script.content.replace(/\r\n?/g, '\n');
}

function buildHtmlDocument(script, readerSettings = null) {
  const colors = readerSettings
    ? resolveReaderColors(readerSettings)
    : { bg: '#ffffff', text: '#111827', accent: '#0e7490' };
  const fontFamily = readerSettings ? getFontStack(readerSettings.fontFamily) : 'Georgia, serif';
  const body = renderScriptHtml(script.content, script.contentFormat);
  const words = countWords(script.content);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${escapeHtml(APP_NAME)} ${escapeHtml(APP_VERSION)}">
<title>${escapeHtml(script.title)}</title>
<style>
  :root { color-scheme: ${readerSettings?.theme === 'paper' || readerSettings?.theme === 'white' ? 'light' : 'dark'}; }
  * { box-sizing: border-box; }
  body { margin: 0; background: ${escapeHtml(colors.bg)}; color: ${escapeHtml(colors.text)}; font-family: ${escapeHtml(fontFamily)}; line-height: 1.65; }
  main { max-width: 850px; margin: 0 auto; padding: 56px 28px 100px; }
  header { padding-bottom: 22px; margin-bottom: 32px; border-bottom: 1px solid color-mix(in srgb, ${escapeHtml(colors.text)} 18%, transparent); }
  h1 { font-size: clamp(30px, 5vw, 48px); line-height: 1.1; letter-spacing: -0.035em; margin: 0; }
  .meta { margin-top: 10px; font-family: system-ui, sans-serif; font-size: 12px; opacity: 0.6; }
  article { font-size: 1.24rem; overflow-wrap: break-word; }
  article h1, article h2, article h3 { letter-spacing: -0.02em; line-height: 1.2; margin: 1.2em 0 0.5em; }
  article p, article ul, article ol, article blockquote { margin: 0 0 1em; }
  article ul, article ol { padding-left: 1.4em; }
  article a { color: ${escapeHtml(colors.accent)}; }
  article blockquote { border-left: 4px solid ${escapeHtml(colors.accent)}; padding-left: 1em; opacity: 0.85; }
  article code { font-family: ui-monospace, Consolas, monospace; font-size: 0.85em; }
  article hr { border: 0; border-top: 1px solid color-mix(in srgb, ${escapeHtml(colors.text)} 20%, transparent); margin: 1.5em 0; }
  .cue { color: ${escapeHtml(colors.accent)}; font-weight: 700; text-transform: uppercase; font-size: 0.75em; letter-spacing: 0.05em; }
  .pause { display: inline-block; width: 0.8em; height: 0.8em; border: 0.1em solid ${escapeHtml(colors.accent)}; border-radius: 50%; opacity: 0.7; }
  footer { margin-top: 48px; padding-top: 18px; border-top: 1px solid color-mix(in srgb, ${escapeHtml(colors.text)} 14%, transparent); font-family: system-ui, sans-serif; font-size: 11px; opacity: 0.45; }
  @media print {
    body { background: #fff !important; color: #111 !important; }
    main { max-width: none; padding: 0; }
    header { border-color: #ccc; }
    article a { color: inherit; }
    footer { display: none; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>${escapeHtml(script.title)}</h1>
    <div class="meta">${words.toLocaleString()} words · ${formatDate(new Date(), { dateStyle: 'medium' })} · Exported from ${escapeHtml(APP_NAME)}</div>
  </header>
  <article>${body}</article>
  <footer>Local-first script export. No scripts or active content are embedded.</footer>
</main>
</body>
</html>`;
}

export function generateScriptExport(script, format, { readerSettings = null } = {}) {
  switch (format) {
    case 'txt':
      return { text: scriptToTxt(script), mime: 'text/plain;charset=utf-8', extension: 'txt' };
    case 'md':
      return { text: scriptToMarkdown(script), mime: 'text/markdown;charset=utf-8', extension: 'md' };
    case 'html':
      return { text: buildHtmlDocument(script, readerSettings), mime: 'text/html;charset=utf-8', extension: 'html' };
    case 'json': {
      const payload = {
        schema: 'teleprompter-studio/script',
        schemaVersion: 1,
        appVersion: APP_VERSION,
        exportedAt: new Date().toISOString(),
        script: {
          id: script.id,
          title: script.title,
          content: script.content,
          contentFormat: script.contentFormat,
          folderId: script.folderId || null,
          tags: script.tags || [],
          isFavorite: Boolean(script.isFavorite),
          createdAt: script.createdAt,
          updatedAt: script.updatedAt,
          wordCount: script.wordCount,
          characterCount: script.characterCount,
          sourceFileName: script.sourceFileName || null,
          sourceFormat: script.sourceFormat || null,
        },
      };
      return { text: JSON.stringify(payload, null, 2), mime: 'application/json;charset=utf-8', extension: 'json' };
    }
    default:
      throw new Error(`Unsupported export format: ${format}`);
  }
}

export function downloadScript(script, format, options = {}) {
  const output = generateScriptExport(script, format, options);
  const fileName = exportFileName(script, output.extension);
  downloadBlob(new Blob([output.text], { type: output.mime }), fileName);
  return fileName;
}

export function printScript(script, { includeDate = true } = {}) {
  const printRoot = document.getElementById('print-root');
  if (!printRoot) throw new Error('The print area is unavailable.');
  const words = countWords(script.content);
  const body = renderScriptHtml(script.content, script.contentFormat);
  printRoot.replaceChildren();
  const title = document.createElement('h1');
  title.textContent = script.title;
  const meta = document.createElement('div');
  meta.className = 'print-meta';
  const parts = [`${words.toLocaleString()} words`, `≈ ${formatDuration((words / 140) * 60)} at 140 WPM`];
  if (includeDate) parts.push(formatDate(new Date(), { dateStyle: 'long' }));
  meta.textContent = parts.join(' · ');
  const content = document.createElement('div');
  content.className = 'print-body';
  content.innerHTML = body; // Sanitised by renderScriptHtml.
  const footer = document.createElement('div');
  footer.className = 'print-date';
  footer.textContent = `Printed from ${APP_NAME} · local-first script studio`;
  printRoot.append(title, meta, content, footer);
  printRoot.setAttribute('aria-hidden', 'false');

  const cleanup = () => {
    printRoot.replaceChildren();
    printRoot.setAttribute('aria-hidden', 'true');
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
  setTimeout(cleanup, 60000);
}

export function printHtmlDocument(html, title = 'Script') {
  const printRoot = document.getElementById('print-root');
  if (!printRoot) return;
  printRoot.replaceChildren();
  const heading = document.createElement('h1');
  heading.textContent = title;
  const content = document.createElement('div');
  content.className = 'print-body';
  content.innerHTML = html; // Caller must provide sanitised HTML.
  printRoot.append(heading, content);
  printRoot.setAttribute('aria-hidden', 'false');
  window.print();
  setTimeout(() => {
    printRoot.replaceChildren();
    printRoot.setAttribute('aria-hidden', 'true');
  }, 1000);
}
