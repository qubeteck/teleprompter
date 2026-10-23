import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

let configured = false;

export function configurePdfWorker() {
  if (configured) return;
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  configured = true;
}

export function getPdfjs() {
  configurePdfWorker();
  return pdfjsLib;
}

export async function loadPdfDocument(data, { signal } = {}) {
  configurePdfWorker();
  const base = document.baseURI;
  const loadingTask = pdfjsLib.getDocument({
    data: data instanceof Uint8Array ? data : new Uint8Array(data),
    isEvalSupported: false,
    useWorkerFetch: false,
    cMapUrl: new URL('pdfjs/cmaps/', base).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('pdfjs/standard_fonts/', base).href,
  });
  const onAbort = () => loadingTask.destroy();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await loadingTask.promise;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function renderPdfPageToDataUrl(page, { scale = 2, quality = 0.92 } = {}) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport, canvas }).promise;
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  canvas.width = 1;
  canvas.height = 1;
  return dataUrl;
}
