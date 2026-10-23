import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { escapeHtml, normalizeNewlines, tokenizeWordsWithOffsets, normalizeWord } from './utils.js';

/**
 * All user/imported HTML passes through DOMPurify. The Sanitizer is configured
 * to allow semantic formatting only; scripts, event handlers, styles, forms,
 * embedded media, and dangerous URLs are removed.
 */

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'mark', 'small', 'sup', 'sub',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'hr', 'span', 'div', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img',
];

const ALLOWED_ATTR = ['href', 'title', 'alt', 'src', 'rel', 'target', 'class', 'colspan', 'rowspan'];

let hookInstalled = false;
function ensureSanitizerHooks() {
  if (hookInstalled) return;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') || '';
      if (!/^(https?:|mailto:|tel:|#|\/)/i.test(href)) {
        node.removeAttribute('href');
      } else {
        node.setAttribute('rel', 'noopener noreferrer');
        if (/^https?:/i.test(href)) node.setAttribute('target', '_blank');
      }
    }
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') || '';
      // Only data images are useful for imports; remote images are blocked to
      // avoid unexpected network requests and tracking.
      if (!/^data:image\//i.test(src)) node.removeAttribute('src');
      node.removeAttribute('srcset');
    }
  });
  hookInstalled = true;
}

export function sanitizeHtml(html, { forReader = false } = {}) {
  ensureSanitizerHooks();
  const sanitized = DOMPurify.sanitize(String(html ?? ''), {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: true,
    RETURN_TRUSTED_TYPE: false,
  });
  if (!forReader) return sanitized;
  // Reader mode renders links as text to prevent accidental navigation mid-read.
  const doc = new DOMParser().parseFromString(sanitized, 'text/html');
  for (const anchor of [...doc.body.querySelectorAll('a')]) {
    const span = doc.createElement('span');
    span.className = 'reader-link';
    while (anchor.firstChild) span.append(anchor.firstChild);
    anchor.replaceWith(span);
  }
  return doc.body.innerHTML;
}

marked.setOptions({
  gfm: true,
  breaks: true,
  headerIds: false,
  mangle: false,
});

/**
 * Replaces non-Markdown speaking markers before parsing. Cue text is escaped.
 */
function injectMarkers(markdown) {
  return String(markdown)
    .replace(/\[\[pause\]\]|\[pause\]/gi, '<span class="pause" aria-hidden="true"></span>')
    .replace(/\[\[cue:\s*([^\]]+)\]\]|\[cue:\s*([^\]]+)\]/gi, (match, innerA, innerB) => {
      const value = innerA || innerB || '';
      return `<span class="cue">${escapeHtml(value.trim())}</span>`;
    });
}

export function renderMarkdown(content, { forReader = false } = {}) {
  const source = injectMarkers(normalizeNewlines(content));
  let html;
  try {
    html = marked.parse(source, { async: false });
  } catch (error) {
    console.warn('Markdown parsing failed; falling back to plain text.', error);
    return renderPlainText(content, { forReader });
  }
  return sanitizeHtml(html, { forReader });
}

function plainTextToHtml(content) {
  const escaped = escapeHtml(normalizeNewlines(content));
  const withMarkers = escaped
    .replace(/\[\[pause\]\]|\[pause\]/gi, '<span class="pause" aria-hidden="true"></span>')
    .replace(/\[\[cue:\s*([^\]]+)\]\]|\[cue:\s*([^\]]+)\]/gi, (match, a, b) => `<span class="cue">${(a || b || '').trim()}</span>`);
  const paragraphs = withMarkers.split(/\n{2,}/);
  return paragraphs
    .map((paragraph) => {
      const trimmed = paragraph.replace(/^\n+|\n+$/g, '');
      if (!trimmed) return '';
      const body = trimmed.replace(/\n/g, '<br>');
      return /^(<(span class="(?:pause|cue)")|<span)/.test(body) && !body.includes('<br>') ? body : `<p>${body}</p>`;
    })
    .filter(Boolean)
    .join('\n');
}

export function renderPlainText(content, { forReader = false } = {}) {
  return sanitizeHtml(plainTextToHtml(content), { forReader });
}

export function renderScriptHtml(content, contentFormat = 'plain', options = {}) {
  return contentFormat === 'markdown'
    ? renderMarkdown(content, options)
    : renderPlainText(content, options);
}

/* ============================================================
   HTML -> text / Markdown conversion for imports
   ============================================================ */

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE',
  'TABLE', 'TR', 'FIGURE', 'FIGCAPTION', 'ADDRESS', 'DL', 'DT', 'DD',
]);

export function htmlToPlainText(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  doc.querySelectorAll('script, style, noscript, template, svg, iframe, object, embed, form, input, button, select, textarea').forEach((node) => node.remove());
  const chunks = [];

  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      chunks.push(node.nodeValue.replace(/[ \t\r\n]+/g, ' '));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.tagName === 'BR') {
      chunks.push('\n');
      return;
    }
    const isBlock = BLOCK_TAGS.has(node.tagName);
    if (isBlock) chunks.push('\n');
    if (node.tagName === 'LI') chunks.push('• ');
    if (node.tagName === 'IMG') {
      const alt = node.getAttribute('alt');
      if (alt) chunks.push(alt);
      return;
    }
    for (const child of node.childNodes) walk(child);
    if (isBlock) chunks.push('\n');
    if (node.tagName === 'TD' || node.tagName === 'TH') chunks.push('\t');
  };

  walk(doc.body);
  return chunks
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function safeHref(href) {
  return /^(https?:|mailto:|tel:)/i.test(href || '') ? href : '';
}

/**
 * Converts sanitized semantic HTML into Markdown. It is deliberately
 * conservative: unsupported constructs become readable text, not raw HTML.
 */
export function htmlToMarkdown(html) {
  if (!html) return '';
  const sanitized = sanitizeHtml(html);
  const doc = new DOMParser().parseFromString(sanitized, 'text/html');

  const normalizeBlock = (text) => text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  const renderChildren = (node) => [...node.childNodes].map((child) => renderNode(child)).join('');

  const renderNode = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName;
    if (tag === 'BR') return '  \n';
    if (tag === 'P') return `${normalizeBlock(renderChildren(node))}\n\n`;
    if (/^H[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      return `${'#'.repeat(level)} ${normalizeBlock(renderChildren(node))}\n\n`;
    }
    if (tag === 'STRONG' || tag === 'B') {
      const inner = normalizeBlock(renderChildren(node));
      return inner ? `**${inner}**` : '';
    }
    if (tag === 'EM' || tag === 'I') {
      const inner = normalizeBlock(renderChildren(node));
      return inner ? `*${inner}*` : '';
    }
    if (tag === 'U') {
      const inner = normalizeBlock(renderChildren(node));
      return inner ? `<u>${inner}</u>` : '';
    }
    if (tag === 'S' || tag === 'DEL') {
      const inner = normalizeBlock(renderChildren(node));
      return inner ? `~~${inner}~~` : '';
    }
    if (tag === 'MARK') {
      const inner = normalizeBlock(renderChildren(node));
      return inner ? `==${inner}==` : '';
    }
    if (tag === 'CODE') {
      return node.closest('pre') ? node.textContent : `\`${node.textContent.replace(/`/g, '\\`')}\``;
    }
    if (tag === 'PRE') {
      return `\n\`\`\`\n${node.textContent.replace(/\n+$/, '')}\n\`\`\`\n\n`;
    }
    if (tag === 'BLOCKQUOTE') {
      const inner = normalizeBlock(renderChildren(node));
      return `${inner.split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
    }
    if (tag === 'UL' || tag === 'OL') {
      const items = [...node.children].filter((child) => child.tagName === 'LI');
      const lines = items.map((item, index) => {
        const marker = tag === 'OL' ? `${index + 1}. ` : '- ';
        const content = normalizeBlock(renderChildren(item)).split('\n').join('\n  ');
        return `${marker}${content}`;
      });
      return `${lines.join('\n')}\n\n`;
    }
    if (tag === 'A') {
      const label = normalizeBlock(renderChildren(node));
      const href = safeHref(node.getAttribute('href'));
      return href ? `[${label}](${href})` : label;
    }
    if (tag === 'IMG') {
      const alt = node.getAttribute('alt') || '';
      return alt ? `[Image: ${alt}]` : '';
    }
    if (tag === 'HR') return '\n---\n\n';
    if (tag === 'TABLE') {
      const rows = [...node.querySelectorAll('tr')];
      if (!rows.length) return '';
      const cells = rows.map((row) =>
        [...row.children].filter((cell) => cell.tagName === 'TD' || cell.tagName === 'TH')
          .map((cell) => normalizeBlock(renderChildren(cell)).replace(/\n/g, ' ')),
      );
      const width = Math.max(...cells.map((row) => row.length));
      const lines = cells.map((row) => `| ${Array.from({ length: width }, (_, i) => row[i] || '').join(' | ')} |`);
      if (lines.length) lines.splice(1, 0, `| ${Array.from({ length: width }, () => '---').join(' | ')} |`);
      return `${lines.join('\n')}\n\n`;
    }
    if (BLOCK_TAGS.has(tag)) return `${normalizeBlock(renderChildren(node))}\n\n`;
    return renderChildren(node);
  };

  return normalizeBlock(renderChildren(doc.body));
}

export function markdownToPlainText(markdown) {
  return htmlToPlainText(renderMarkdown(markdown));
}

/* ============================================================
   Text index for voice-follow and reading position
   ============================================================ */

/**
 * Builds a rendered-text index with Word tokens and the DOM text nodes they
 * belong to. This allows voice-follow to scroll to a spoken word without
 * injecting spans into the user's script.
 */
export function buildRenderedTextIndex(root) {
  if (!root) return { text: '', tokens: [], segments: [] };
  const segments = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('script, style, template, [aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walker.nextNode())) {
    // Add a separating space between blocks by checking rendered whitespace.
    if (text && !text.endsWith(' ') && !/^\s/.test(node.nodeValue)) text += ' ';
    const start = text.length;
    const value = node.nodeValue.replace(/\s+/g, ' ');
    text += value;
    segments.push({ node, start, end: start + value.length });
  }
  const tokens = tokenizeWordsWithOffsets(text);
  return { text, tokens, segments, normalizedTokens: tokens.map((token) => normalizeWord(token.word)) };
}

export function rangeForToken(index, token) {
  if (!index || !token) return null;
  const segment = index.segments.find((entry) => token.start >= entry.start && token.start <= entry.end);
  if (!segment) return null;
  const original = segment.node.nodeValue;
  const offsetInNormalized = token.start - segment.start;
  // Normalised whitespace can shift offsets. Locate the word within the text
  // node; if the exact offset fails, use the first case-insensitive match.
  let localStart = Math.min(offsetInNormalized, original.length);
  let localEnd = Math.min(localStart + token.word.length, original.length);
  const candidate = original.slice(localStart, localEnd);
  if (normalizeWord(candidate) !== token.normalized) {
    const regex = new RegExp(`\\b${token.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const match = regex.exec(original);
    if (!match) return null;
    localStart = match.index;
    localEnd = localStart + match[0].length;
  }
  const range = document.createRange();
  try {
    range.setStart(segment.node, localStart);
    range.setEnd(segment.node, localEnd);
  } catch {
    return null;
  }
  return range;
}

export function stripMarkdownToText(content) {
  return htmlToPlainText(renderScriptHtml(content, 'markdown'));
}

export function contentPreviewText(content, contentFormat = 'plain', length = 180) {
  const plain = htmlToPlainText(renderScriptHtml(content, contentFormat));
  const flat = plain.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}
