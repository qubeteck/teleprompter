import { cleanImportedText, deriveTitleFromFileName, readFileAsArrayBuffer } from '../utils.js';
import { htmlToMarkdown, sanitizeHtml } from '../render-content.js';
import { ImportError } from './errors.js';

let mammothPromise = null;
async function getMammoth() {
  if (!mammothPromise) {
    mammothPromise = import('mammoth').then((module) => module.default || module);
  }
  return mammothPromise;
}

export async function parseDocxFile(file, { cleanup = {}, signal } = {}) {
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
  const mammoth = await getMammoth();
  const buffer = await readFileAsArrayBuffer(file);
  try {
    const result = await mammoth.convertToHtml(
      { arrayBuffer: buffer },
      {
        convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
        ignoreEmptyParagraphs: true,
      },
    );
    if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
    const html = sanitizeHtml(result.value || '');
    const markdown = htmlToMarkdown(html);
    const content = cleanImportedText(markdown, {
      collapseBlankLines: cleanup.collapseBlankLines !== false,
      removePageArtifacts: Boolean(cleanup.removePageArtifacts),
    });
    if (!content.replace(/[#>*_`\-[\]()]/g, '').trim()) {
      throw new ImportError('This Word document contains no readable text. It may contain only images.', {
        code: 'EMPTY_FILE',
        canOcr: false,
      });
    }
    const warnings = [];
    const messages = result.messages || [];
    const important = messages.filter((message) => message.type === 'error');
    if (important.length) warnings.push(`Some Word content could not be converted: ${important[0].message}`);
    else if (messages.length) warnings.push(`${messages.length} Word formatting element(s) were simplified for compatibility.`);
    warnings.push('DOCX formatting was converted to readable Markdown. Complex layouts may be simplified.');

    const heading = /^#{1,6}\s+(.+)$/m.exec(content)?.[1]?.replace(/[*_`]/g, '').trim();
    return {
      title: heading?.slice(0, 120) || deriveTitleFromFileName(file.name),
      content,
      contentFormat: 'markdown',
      sourceFormat: 'docx',
      warnings,
    };
  } catch (error) {
    if (error instanceof ImportError) throw error;
    if (/password|encrypt/i.test(error?.message || '')) {
      throw new ImportError('This Word document appears to be encrypted or password-protected. Remove the password and try again.', {
        code: 'DOCUMENT_ENCRYPTED',
      });
    }
    throw new ImportError(
      'This DOCX file could not be read. It may be corrupted or created by an unsupported Word variant. Try opening and re-saving it in Word or LibreOffice.',
      { detail: error?.message, code: 'DOCX_PARSE_FAILED' },
    );
  }
}
