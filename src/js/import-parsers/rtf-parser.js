import { cleanImportedText, deriveTitleFromFileName, readFileAsArrayBuffer } from '../utils.js';
import { ImportError } from './errors.js';

/**
 * A conservative RTF reader focused on visible document text.
 *
 * It supports groups, Unicode escapes (\uN), code-page hex escapes (\'hh),
 * paragraphs, line breaks, tabs, common punctuation symbols, and ignores
 * destinations such as font/color tables, pictures, metadata, and field
 * instructions. Formatting controls are intentionally discarded; the output
 * is clean readable text for the teleprompter.
 */

const SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'shppict', 'nonshppict',
  'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf',
  'footnote', 'annotation', 'listtable', 'listoverridetable', 'rsidtbl', 'generator',
  'xmlnstbl', 'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'filetbl',
  'revtbl', 'bkmkstart', 'bkmkend', 'fldinst', 'private', 'template', 'mmathPr', 'mathPr',
  'pgdsctbl', 'pnseclvl', 'fchars', 'lchars', 'xmlopen', 'xmlclose', 'mhtmltag',
  'panose', 'falt', 'fname', 'fcharset', 'fprq',
]);

const SYMBOLS = {
  par: '\n\n',
  line: '\n',
  tab: '\t',
  emdash: '—',
  endash: '–',
  bullet: '•',
  lquote: '‘',
  rquote: '’',
  ldblquote: '“',
  rdblquote: '”',
  '~': '\u00a0',
  _: '\u2011',
  '{': '{',
  '}': '}',
  '\\': '\\',
};

function bytesToLatin1(bytes) {
  let result = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    result += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return result;
}

const cp1252Decoder = new TextDecoder('windows-1252');

function decodeHexByte(hex) {
  const code = Number.parseInt(hex, 16);
  if (Number.isNaN(code)) return '';
  try {
    return cp1252Decoder.decode(Uint8Array.of(code));
  } catch {
    return String.fromCharCode(code);
  }
}

export function parseRtfString(source) {
  const text = String(source);
  const output = [];
  const stack = [];
  let skip = false;
  let skipFallback = 0;
  let ucSkip = 1;
  let i = 0;

  const pushText = (value) => {
    if (!skip && value) output.push(value);
  };

  while (i < text.length) {
    const char = text[i];

    if (char === '{') {
      stack.push({ skip, ucSkip });
      i += 1;
      continue;
    }

    if (char === '}') {
      const previous = stack.pop();
      if (previous) {
        skip = previous.skip;
        ucSkip = previous.ucSkip;
      }
      i += 1;
      continue;
    }

    if (char === '\\') {
      const next = text[i + 1];
      if (!next) break;

      // Control symbol.
      if (!/[a-zA-Z]/.test(next)) {
        i += 2;
        if (next === '*') {
          skip = true;
          continue;
        }
        if (next === "'") {
          const hex = text.slice(i, i + 2);
          i += 2;
          if (skipFallback > 0) {
            skipFallback -= 1;
            continue;
          }
          pushText(decodeHexByte(hex));
          continue;
        }
        if (next === 'u') {
          // Handled with numeric control words below; unreachable.
          continue;
        }
        if (next === '~') pushText('\u00a0');
        else if (next === '_') pushText('\u2011');
        else if (next === '\\' || next === '{' || next === '}') pushText(next);
        // Other control symbols are formatting and produce no text.
        continue;
      }

      // Control word.
      i += 1;
      let word = '';
      while (i < text.length && /[a-zA-Z]/.test(text[i])) {
        word += text[i];
        i += 1;
      }
      let sign = 1;
      if (text[i] === '-') {
        sign = -1;
        i += 1;
      }
      let digits = '';
      while (i < text.length && /\d/.test(text[i])) {
        digits += text[i];
        i += 1;
      }
      const parameter = digits ? sign * Number(digits) : null;
      // A single space is a control word delimiter.
      if (text[i] === ' ') i += 1;

      if (word === 'uc' && parameter != null) {
        ucSkip = Math.max(0, parameter);
        continue;
      }
      if (word === 'u' && parameter != null) {
        const code = parameter < 0 ? parameter + 65536 : parameter;
        if (skipFallback === 0) pushText(String.fromCharCode(code));
        skipFallback = ucSkip;
        continue;
      }
      if (word === 'bin' && parameter != null) {
        i += Math.max(0, parameter);
        continue;
      }
      if (SKIP_DESTINATIONS.has(word)) {
        skip = true;
        continue;
      }
      if (word === 'nonshppict' || word === 'shppict') {
        skip = true;
        continue;
      }

      const symbol = SYMBOLS[word];
      if (symbol != null) {
        if (word === 'par' || word === 'line') {
          if (skipFallback > 0) skipFallback = 0;
        }
        pushText(symbol);
      }
      continue;
    }

    if (char === '\r' || char === '\n') {
      i += 1;
      continue;
    }

    if (skipFallback > 0) {
      skipFallback -= 1;
      i += 1;
      continue;
    }

    pushText(char);
    i += 1;
  }

  return output.join('');
}

export async function parseRtfFile(file, { cleanup = {}, signal } = {}) {
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
  const buffer = await readFileAsArrayBuffer(file);
  const source = bytesToLatin1(new Uint8Array(buffer));
  if (!/^\s*\{\\rtf/i.test(source)) {
    throw new ImportError('This file does not look like a valid RTF document.', { code: 'RTF_INVALID' });
  }
  let raw = '';
  try {
    raw = parseRtfString(source);
  } catch (error) {
    throw new ImportError('The RTF document could not be parsed. Try re-saving it as DOCX or TXT.', {
      detail: error?.message,
      code: 'RTF_PARSE_FAILED',
    });
  }
  const content = cleanImportedText(raw.replace(/\t+/g, ' '), {
    collapseBlankLines: cleanup.collapseBlankLines !== false,
    removePageArtifacts: Boolean(cleanup.removePageArtifacts),
  });
  if (!content.trim()) {
    throw new ImportError('No readable text was found in this RTF file. It may contain only images.', {
      code: 'EMPTY_FILE',
    });
  }
  return {
    title: deriveTitleFromFileName(file.name),
    content,
    contentFormat: 'plain',
    sourceFormat: 'rtf',
    warnings: ['RTF formatting was converted to clean text. Complex layout may be simplified.'],
  };
}
