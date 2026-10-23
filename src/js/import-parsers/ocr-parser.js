import { cleanImportedText, deriveTitleFromFileName, readFileAsArrayBuffer } from '../utils.js';
import { loadPdfDocument, renderPdfPageToDataUrl } from './pdf-runtime.js';
import { ImportError } from './errors.js';

export const OCR_LANGUAGES = Object.freeze([
  { value: 'eng', label: 'English' },
  { value: 'amh', label: 'Amharic' },
]);

function assetUrl(path) {
  return new URL(path, document.baseURI).href;
}

function statusLabel(status) {
  const labels = {
    'loading tesseract core': 'Loading OCR engine…',
    'initializing tesseract': 'Initializing OCR…',
    'loading language traineddata': 'Loading language data…',
    'initializing api': 'Preparing recognizer…',
    'recognizing text': 'Recognizing text…',
  };
  return labels[status] || 'OCR working…';
}

async function createOcrWorker(language, onProgress, abortState) {
  let Tesseract;
  try {
    Tesseract = await import('tesseract.js');
  } catch (error) {
    throw new ImportError('The OCR engine could not be loaded. Check your connection and try again.', {
      detail: error?.message,
      code: 'OCR_ENGINE_FAILED',
    });
  }

  let worker = null;
  const onAbort = () => {
    abortState.aborted = true;
    worker?.terminate?.().catch(() => {});
  };
  abortState.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    worker = await Tesseract.createWorker(language, 1, {
      workerPath: assetUrl('tesseract/worker.min.js'),
      corePath: assetUrl('tesseract'),
      langPath: assetUrl('tessdata'),
      cacheMethod: 'write',
      gzip: true,
      logger: (message) => {
        if (abortState.aborted) return;
        const percent = typeof message.progress === 'number' ? Math.round(message.progress * 100) : null;
        onProgress?.({ percent, message: statusLabel(message.status) });
      },
      errorHandler: (error) => {
        console.warn('OCR worker error', error);
      },
    });
    return {
      worker,
      cleanup: async () => {
        abortState.signal?.removeEventListener('abort', onAbort);
        await worker?.terminate?.().catch(() => {});
      },
    };
  } catch (error) {
    abortState.signal?.removeEventListener('abort', onAbort);
    await worker?.terminate?.().catch(() => {});
    if (abortState.aborted) throw new DOMException('OCR cancelled.', 'AbortError');
    throw new ImportError(
      'OCR could not start. The recognition engine or local language data may be unavailable. Text files and DOCX imports still work normally.',
      { detail: error?.message, code: 'OCR_START_FAILED' },
    );
  }
}

export async function recognizeImage(fileOrDataUrl, { language = 'eng', signal, onProgress } = {}) {
  const lang = OCR_LANGUAGES.some((item) => item.value === language) ? language : 'eng';
  const abortState = { aborted: false, signal };
  if (signal?.aborted) throw new DOMException('OCR cancelled.', 'AbortError');
  const { worker, cleanup } = await createOcrWorker(lang, onProgress, abortState);
  try {
    if (abortState.aborted) throw new DOMException('OCR cancelled.', 'AbortError');
    onProgress?.({ percent: 0, message: 'Preparing image for recognition…' });
    const result = await worker.recognize(fileOrDataUrl);
    if (abortState.aborted) throw new DOMException('OCR cancelled.', 'AbortError');
    return cleanImportedText(result?.data?.text || '', { collapseBlankLines: true, removePageArtifacts: false });
  } catch (error) {
    if (abortState.aborted || error?.name === 'AbortError') throw new DOMException('OCR cancelled.', 'AbortError');
    throw new ImportError('OCR could not recognize this image. Try a sharper, higher-contrast image.', {
      detail: error?.message,
      code: 'OCR_FAILED',
    });
  } finally {
    await cleanup();
  }
}

async function recognizePdf(file, { language, signal, onProgress }) {
  const buffer = await readFileAsArrayBuffer(file);
  if (signal?.aborted) throw new DOMException('OCR cancelled.', 'AbortError');
  let pdf = null;
  try {
    pdf = await loadPdfDocument(new Uint8Array(buffer), { signal });
  } catch (error) {
    if (error?.name === 'PasswordException') {
      throw new ImportError('This PDF is password-protected and cannot be OCR processed.', { code: 'PDF_PASSWORD' });
    }
    throw new ImportError('This PDF could not be opened for OCR. It may be corrupted.', { detail: error?.message });
  }

  try {
    const pages = pdf.numPages;
    const results = [];
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      if (signal?.aborted) throw new DOMException('OCR cancelled.', 'AbortError');
      onProgress?.({ percent: 0, message: `Rendering PDF page ${pageNumber} of ${pages}…` });
      const page = await pdf.getPage(pageNumber);
      const imageUrl = await renderPdfPageToDataUrl(page, { scale: 2 });
      page.cleanup();
      const pageText = await recognizeImage(imageUrl, {
        language,
        signal,
        onProgress: ({ percent = 0, message }) => {
          const pageFraction = percent / 100;
          onProgress?.({
            percent: Math.round(((pageNumber - 1 + pageFraction) / pages) * 100),
            message: `Page ${pageNumber} of ${pages}: ${message}`,
          });
        },
      });
      if (pageText.trim()) results.push(pageText.trim());
    }
    return results.join('\n\n');
  } finally {
    await pdf.destroy?.().catch(() => {});
  }
}

export async function parseOcrFile(file, { cleanup = {}, ocrLanguage = 'eng', signal, onProgress, pdf = false } = {}) {
  if (signal?.aborted) throw new DOMException('OCR cancelled.', 'AbortError');
  const isPdf = pdf || /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  onProgress?.({ percent: 0, message: isPdf ? 'Preparing PDF for OCR…' : 'Preparing image for OCR…' });

  const text = isPdf
    ? await recognizePdf(file, { language: ocrLanguage, signal, onProgress })
    : await recognizeImage(file, { language: ocrLanguage, signal, onProgress });

  const content = cleanImportedText(text, {
    collapseBlankLines: cleanup.collapseBlankLines !== false,
    removePageArtifacts: Boolean(cleanup.removePageArtifacts),
  });
  if (!content.trim()) {
    throw new ImportError('OCR found no readable text. Try a clearer image, a different language, or enter the text manually.', {
      code: 'OCR_EMPTY',
    });
  }
  return {
    title: deriveTitleFromFileName(file.name.replace(/\.pdf$/i, '')) || 'OCR import',
    content,
    contentFormat: 'plain',
    sourceFormat: isPdf ? 'pdf-ocr' : 'image-ocr',
    warnings: [
      'OCR text may contain recognition errors. Review and correct the preview before saving.',
      'OCR processing runs locally in your browser. The language data is loaded once and cached.',
    ],
  };
}
