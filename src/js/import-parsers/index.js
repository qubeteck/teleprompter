import { parseTxtFile } from './txt-parser.js';
import { parseMarkdownFile } from './markdown-parser.js';
import { parseHtmlFile } from './html-parser.js';
import { parseDocxFile } from './docx-parser.js';
import { parsePdfFile } from './pdf-parser.js';
import { parseRtfFile } from './rtf-parser.js';
import { parseJsonFile } from './json-parser.js';
import { parseOcrFile } from './ocr-parser.js';
import { ImportError } from './errors.js';
import { formatBytes, getExtension } from '../utils.js';

export const MAX_IMPORT_FILES = 20;

const KIND_BY_EXTENSION = {
  '.txt': 'txt',
  '.text': 'txt',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdown': 'markdown',
  '.html': 'html',
  '.htm': 'html',
  '.docx': 'docx',
  '.pdf': 'pdf',
  '.rtf': 'rtf',
  '.json': 'json',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.gif': 'image',
};

export const IMPORT_ACCEPT = Object.keys(KIND_BY_EXTENSION).join(',');
export const FILE_TYPE_LABELS = {
  txt: 'Plain text',
  markdown: 'Markdown',
  html: 'HTML',
  docx: 'Word document',
  pdf: 'PDF',
  rtf: 'Rich Text',
  json: 'JSON script',
  image: 'Image (OCR)',
};

export function getFileKind(fileName) {
  return KIND_BY_EXTENSION[getExtension(fileName)] || null;
}

export function isSupportedImportFile(fileName) {
  return Boolean(getFileKind(fileName));
}

function expectedMime(kind) {
  const sets = {
    txt: ['text/plain', 'application/octet-stream', ''],
    markdown: ['text/markdown', 'text/plain', 'text/x-markdown', 'application/octet-stream', ''],
    html: ['text/html', 'application/xhtml+xml', 'text/plain', 'application/octet-stream', ''],
    docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip', 'application/octet-stream', ''],
    pdf: ['application/pdf', 'application/octet-stream', ''],
    rtf: ['application/rtf', 'text/rtf', 'text/plain', 'application/octet-stream', ''],
    json: ['application/json', 'text/json', 'text/plain', 'application/octet-stream', ''],
    image: ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif', 'application/octet-stream', ''],
  };
  return sets[kind] || [];
}

async function sniffBytes(file, count = 16) {
  try {
    const slice = file.slice(0, count);
    return new Uint8Array(await slice.arrayBuffer());
  } catch {
    return null;
  }
}

function startsWith(bytes, signature) {
  if (!bytes || bytes.length < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes, count = 8) {
  if (!bytes) return '';
  return String.fromCharCode(...bytes.slice(0, count));
}

function verifyMagic(kind, bytes, fileName) {
  const pdf = startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
  const zip = startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
  const rtf = ascii(bytes, 5).replace(/^\s+/, '') === '{\\rtf';
  const png = startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = startsWith(bytes, [0xff, 0xd8, 0xff]);
  const gif = ascii(bytes, 6) === 'GIF87a' || ascii(bytes, 6) === 'GIF89a';
  const bmp = ascii(bytes, 2) === 'BM';
  const webp = ascii(bytes, 4) === 'RIFF' && ascii(bytes.slice(8, 12), 4) === 'WEBP';

  if (kind !== 'pdf' && pdf) {
    throw new ImportError(`"${fileName}" contains PDF data but has the wrong extension. Rename it to .pdf.`, { code: 'MIME_MISMATCH' });
  }
  if (kind === 'pdf' && !pdf) {
    throw new ImportError(`"${fileName}" is not a valid PDF file.`, { code: 'PDF_INVALID' });
  }
  if (kind === 'docx' && !zip) {
    throw new ImportError(`"${fileName}" is not a valid DOCX (ZIP) document. Legacy .doc files need to be re-saved as .docx or .txt.`, { code: 'DOCX_INVALID' });
  }
  if (kind === 'rtf' && !rtf) {
    throw new ImportError(`"${fileName}" does not look like a valid RTF document.`, { code: 'RTF_INVALID' });
  }
  if (kind === 'image') {
    const valid = png || jpeg || gif || bmp || webp;
    if (!valid) throw new ImportError(`"${fileName}" is not a supported image file.`, { code: 'IMAGE_INVALID' });
  }
  if (kind === 'docx' && pdf) {
    throw new ImportError(`"${fileName}" contains PDF data, not a DOCX document.`, { code: 'MIME_MISMATCH' });
  }
  if (['txt', 'markdown', 'html', 'json'].includes(kind)) {
    const sample = ascii(bytes, 16);
    if (sample.startsWith('%PDF-')) {
      throw new ImportError(`"${fileName}" contains PDF data. Rename it to .pdf and import again.`, { code: 'MIME_MISMATCH' });
    }
  }
}

async function parseByKind(file, kind, options) {
  switch (kind) {
    case 'txt':
      return parseTxtFile(file, options);
    case 'markdown':
      return parseMarkdownFile(file, options);
    case 'html':
      return parseHtmlFile(file, options);
    case 'docx':
      return parseDocxFile(file, options);
    case 'pdf':
      try {
        return await parsePdfFile(file, options);
      } catch (error) {
        if (options.allowOcr && error instanceof ImportError && error.canOcr) {
          return parseOcrFile(file, { ...options, pdf: true });
        }
        throw error;
      }
    case 'rtf':
      return parseRtfFile(file, options);
    case 'json':
      return parseJsonFile(file, options);
    case 'image':
      if (!options.allowOcr) {
        throw new ImportError(
          `"${file.name}" is an image. Enable OCR in the import options to recognize its text.`,
          { code: 'OCR_REQUIRED', canOcr: true },
        );
      }
      return parseOcrFile(file, options);
    default:
      throw new ImportError(`"${file.name}" is not a supported file type.`, { code: 'UNSUPPORTED_TYPE' });
  }
}

/**
 * Validate and parse a single import file. Returns normalized content and
 * metadata; never writes to the database.
 */
export async function parseImportFile(file, options = {}) {
  const {
    maxFileSizeMB = 30,
    cleanup = {},
    allowOcr = false,
    ocrLanguage = 'eng',
    signal,
    onProgress = null,
  } = options;

  const kind = getFileKind(file.name);
  if (!kind) {
    const ext = getExtension(file.name) || '(no extension)';
    if (ext === '.doc' || ext === '.odt') {
      throw new ImportError(
        `Legacy ${ext} files are not supported directly. Re-save the file as .docx, .pdf, or .txt and import again.`,
        { code: 'UNSUPPORTED_TYPE' },
      );
    }
    throw new ImportError(`Files of type ${ext} are not supported. Use TXT, Markdown, HTML, DOCX, PDF, RTF, JSON, or an image with OCR.`, {
      code: 'UNSUPPORTED_TYPE',
    });
  }

  if (!(file instanceof File)) {
    throw new ImportError('No file was provided.', { code: 'NO_FILE' });
  }
  if (file.size === 0) {
    throw new ImportError(`"${file.name}" is empty (0 bytes).`, { code: 'EMPTY_FILE' });
  }
  const maxBytes = Math.max(1, maxFileSizeMB) * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new ImportError(
      `"${file.name}" is ${formatBytes(file.size)}, larger than the ${maxFileSizeMB} MB import limit. Increase the limit in Settings → Import or split the file.`,
      { code: 'FILE_TOO_LARGE' },
    );
  }

  const mime = (file.type || '').toLowerCase();
  if (mime && !expectedMime(kind).includes(mime)) {
    // Some systems report broad or incorrect MIME types. Only reject when the
    // MIME family is clearly unrelated.
    const family = mime.split('/')[0];
    const allowedFamilies = new Set(expectedMime(kind).map((value) => value.split('/')[0]));
    if (!allowedFamilies.has(family)) {
      throw new ImportError(
        `"${file.name}" reports an unexpected file type (${mime}). It may be mislabeled. Rename it with the correct extension or re-export it.`,
        { code: 'MIME_MISMATCH' },
      );
    }
  }

  const bytes = await sniffBytes(file);
  if (!bytes || bytes.length === 0) {
    throw new ImportError(`"${file.name}" could not be read.`, { code: 'READ_FAILED' });
  }
  verifyMagic(kind, bytes, file.name);

  onProgress?.({ percent: 2, message: 'Validated file…' });
  try {
    const result = await parseByKind(file, kind, {
      cleanup,
      allowOcr,
      ocrLanguage,
      signal,
      onProgress: (progress) => onProgress?.(progress),
    });
    onProgress?.({ percent: 100, message: 'Text extracted.' });
    if (!result?.content?.trim()) {
      throw new ImportError(`"${file.name}" did not contain readable text.`, { code: 'EMPTY_FILE' });
    }
    return {
      ...result,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type || '',
      kind,
      sourceFormat: result.sourceFormat || kind,
    };
  } catch (error) {
    if (error instanceof ImportError) throw error;
    if (error?.name === 'AbortError' || signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
    throw new ImportError(`Could not import "${file.name}": ${error?.message || 'unknown error'}`, {
      detail: error?.stack,
      code: 'PARSE_FAILED',
    });
  }
}

export { ImportError } from './errors.js';
