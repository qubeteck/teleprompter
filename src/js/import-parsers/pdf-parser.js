import { cleanImportedText, deriveTitleFromFileName, readFileAsArrayBuffer } from '../utils.js';
import { loadPdfDocument } from './pdf-runtime.js';
import { ImportError } from './errors.js';

function groupPageLines(textContent) {
  const lines = [];
  let current = null;
  let lastY = null;
  let lastX = null;
  let lastHeight = 10;

  const pushLine = () => {
    if (!current) return;
    const value = current.text.replace(/\s+/g, ' ').trim();
    if (value) {
      lines.push({
        text: value,
        y: current.y,
        height: current.height,
      });
    }
    current = null;
  };

  for (const item of textContent.items) {
    if (!item || typeof item.str !== 'string' || !item.str) continue;
    const x = item.transform?.[4] ?? 0;
    const y = item.transform?.[5] ?? 0;
    const height = Math.abs(item.transform?.[3] || item.transform?.[0] || 10);
    const tolerance = Math.max(1.6, height * 0.32);

    if (current && (Math.abs(y - lastY) > tolerance || item.hasEOL)) {
      pushLine();
    }
    if (!current) {
      current = { text: '', y, height };
    } else if (lastX != null && x - lastX > Math.max(2.5, lastHeight * 0.14)) {
      current.text += ' ';
    }
    current.text += item.str;
    current.y = y;
    current.height = Math.max(current.height, height);
    lastY = y;
    lastX = x + (item.width || 0);
    lastHeight = height;
    if (item.hasEOL) pushLine();
  }
  pushLine();
  return lines;
}

function linesToText(lines) {
  const paragraphs = [];
  let paragraph = [];
  let previous = null;

  for (const line of lines) {
    if (!line.text.trim()) continue;
    const verticalGap = Math.abs((previous?.y ?? 0) - line.y);
    const startsNewParagraph =
      !previous ||
      Math.abs(line.height - previous.height) > Math.max(2.5, previous.height * 0.25) ||
      verticalGap > Math.max(6, Math.max(line.height, previous.height) * 1.85) ||
      line.y > previous.y + 2;

    if (startsNewParagraph && paragraph.length) {
      paragraphs.push(paragraph.join(' '));
      paragraph = [];
    }
    paragraph.push(line.text);
    previous = line;
  }
  if (paragraph.length) paragraphs.push(paragraph.join(' '));
  return paragraphs.join('\n\n');
}

export async function parsePdfFile(file, { cleanup = {}, signal, onProgress } = {}) {
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
  const buffer = await readFileAsArrayBuffer(file);
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') {
    throw new ImportError('This file does not appear to be a valid PDF.', { code: 'PDF_INVALID' });
  }

  let pdf = null;
  try {
    pdf = await loadPdfDocument(bytes, { signal });
  } catch (error) {
    if (error?.name === 'PasswordException') {
      throw new ImportError('This PDF is password-protected. Remove the password and try again.', { code: 'PDF_PASSWORD' });
    }
    if (error?.name === 'InvalidPDFException') {
      throw new ImportError('This PDF is corrupted or unreadable.', { code: 'PDF_INVALID' });
    }
    if (error?.name === 'AbortError' || signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
    throw new ImportError('The PDF could not be opened. It may be corrupted or use an unsupported feature.', {
      detail: error?.message,
      code: 'PDF_OPEN_FAILED',
    });
  }

  try {
    let title = '';
    try {
      const metadata = await pdf.getMetadata();
      title = metadata?.info?.Title?.trim?.() || '';
    } catch {
      // PDF metadata is optional.
    }

    const pageTexts = [];
    const total = pdf.numPages;
    let characterCount = 0;

    for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
      if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
      onProgress?.({ percent: Math.round((pageNumber / total) * 100), message: `Reading page ${pageNumber} of ${total}…` });
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      const pageText = linesToText(groupPageLines(textContent));
      page.cleanup();
      if (pageText.trim()) {
        pageTexts.push(pageText.trim());
        characterCount += pageText.length;
      }
      // Yield to the event loop so long PDFs don't freeze the UI.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (!characterCount || !pageTexts.length) {
      throw new ImportError(
        'This PDF contains no selectable text. It may be a scanned document or a set of images. You can run OCR to recognize the text.',
        { code: 'PDF_NO_TEXT', canOcr: true },
      );
    }

    let content = cleanImportedText(pageTexts.join('\n\n'), {
      collapseBlankLines: cleanup.collapseBlankLines !== false,
      removePageArtifacts: Boolean(cleanup.removePageArtifacts),
    });
    if (!content.trim()) {
      throw new ImportError('No readable text was found in this PDF. OCR may be able to recognize it.', {
        code: 'PDF_NO_TEXT',
        canOcr: true,
      });
    }
    const warnings = [];
    if (!cleanup.removePageArtifacts && total > 1) {
      warnings.push('Page headers and footers may be included. Enable "Remove page artifacts" to clean them up.');
    }
    warnings.push(`Extracted text from ${total} PDF page${total === 1 ? '' : 's'}. Layout and columns may be simplified.`);

    return {
      title: title || deriveTitleFromFileName(file.name),
      content,
      contentFormat: 'plain',
      sourceFormat: 'pdf',
      warnings,
      pageCount: total,
    };
  } catch (error) {
    if (error instanceof ImportError) throw error;
    if (error?.name === 'AbortError' || signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
    throw new ImportError('The PDF text could not be extracted.', { detail: error?.message, code: 'PDF_PARSE_FAILED' });
  } finally {
    await pdf.destroy?.().catch(() => {});
  }
}
