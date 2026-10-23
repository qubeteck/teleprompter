import {
  IMPORT_ACCEPT,
  MAX_IMPORT_FILES,
  FILE_TYPE_LABELS,
  getFileKind,
  isSupportedImportFile,
  parseImportFile,
} from './import-parsers/index.js';
import { ImportError } from './import-parsers/errors.js';
import {
  computeContentHash,
  normalizeTags,
  prepareScriptRecord,
  scriptCounts,
} from './script-validation.js';
import {
  addRevision,
  findScriptsByContentHash,
  getAllFolders,
  getScript,
  saveScript,
  saveScripts,
} from './database.js';
import { renderScriptHtml, stripMarkdownToText } from './render-content.js';
import { OCR_LANGUAGES } from './settings.js';
import {
  badge,
  button,
  createSelect,
  createSwitch,
  h,
  iconSpan,
  openModal,
  setButtonBusy,
  toast,
} from './ui.js';
import {
  countWords,
  escapeHtml,
  formatBytes,
  formatDuration,
  friendlyErrorMessage,
  isAbortError,
  pluralize,
  truncate,
  uid,
} from './utils.js';

function fileIcon(kind) {
  if (kind === 'image') return 'fileImage';
  if (kind === 'json') return 'fileJson';
  if (kind === 'html' || kind === 'markdown') return 'fileCode';
  return 'fileText';
}

function extensionLabel(fileName) {
  const parts = String(fileName).split('.');
  return parts.length > 1 ? `.${parts.at(-1).toLowerCase()}` : '';
}

/**
 * Full import workflow: choose -> validate/parse with progress -> preview ->
 * confirm -> commit. Parsing never writes to the database.
 */
export function openImportDialog({
  settingsStore,
  currentScript = null,
  defaultFolderId = null,
  onImported = null,
  onAppliedToCurrent = null,
} = {}) {
  const settings = settingsStore.get();
  const importSettings = settings.import;
  const modal = openModal({
    title: 'Import documents',
    description: 'TXT, Markdown, HTML, DOCX, PDF, RTF, JSON script exports, and images with optional OCR.',
    icon: 'upload',
    size: 'xl',
    closeOnBackdrop: false,
  });
  const state = {
    files: [],
    folders: [],
    activeId: null,
    allowOcr: false,
    ocrLanguage: importSettings.ocrLanguage,
    cleanupBlankLines: importSettings.cleanupBlankLines,
    removePageArtifacts: importSettings.removePageArtifacts,
    targetMode: 'new',
    folderId: defaultFolderId || '',
    skipDuplicates: true,
    parsing: false,
    parsed: false,
    stale: false,
    controller: null,
    titles: new Map(),
    duplicateMap: new Map(),
    overallPercent: 0,
  };

  const body = h('div', { class: 'stack', style: { gap: '14px' } });
  const dropZone = buildDropZone();
  const optionsPanel = h('div');
  const filesPanel = h('div');
  const previewPanel = h('div');
  body.append(dropZone, optionsPanel, filesPanel, previewPanel);
  modal.body.append(body);

  const footer = h('div', { class: 'modal__footer--split', style: { display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' } });
  const statusText = h('div', { class: 'field-hint', text: 'Select one or more documents to begin.' });
  const actions = h('div', { class: 'btn-row' });
  const cancelImport = button('Cancel', { variant: 'ghost', onClick: () => modal.close() });
  const parseButton = button('Parse files', { iconName: 'sparkles', disabled: true });
  const importButton = button('Import', { iconName: 'download', variant: 'primary', disabled: true });
  actions.append(cancelImport, parseButton, importButton);
  footer.append(statusText, actions);
  modal.footer.append(footer);

  parseButton.addEventListener('click', () => parseFiles());
  importButton.addEventListener('click', () => commitImport());

  getAllFolders()
    .then((folders) => {
      state.folders = folders;
      renderOptions();
    })
    .catch(() => renderOptions());
  renderOptions();
  renderFiles();
  renderPreview();

  async function handleFiles(fileList) {
    if (state.parsing) {
      toast('Wait for the current parse to finish or cancel it before adding files.', { type: 'warning' });
      return;
    }
    const incoming = [...fileList].slice(0, MAX_IMPORT_FILES);
    if (fileList.length > MAX_IMPORT_FILES) {
      toast(`Only the first ${MAX_IMPORT_FILES} files were added.`, { type: 'warning' });
    }
    for (const file of incoming) {
      const kind = getFileKind(file.name);
      const id = uid('import-');
      const entry = {
        id,
        file,
        kind,
        status: isSupportedImportFile(file.name) ? 'pending' : 'error',
        result: null,
        error: !isSupportedImportFile(file.name)
          ? `Unsupported file type ${extensionLabel(file.name) || '(none)'}. Use TXT, MD, HTML, DOCX, PDF, RTF, JSON, or an image.`
          : null,
        progress: 0,
        progressMessage: '',
        canOcr: false,
      };
      state.files.push(entry);
      state.titles.set(id, '');
    }
    if (!state.activeId && state.files.length) state.activeId = state.files[0].id;
    state.parsed = false;
    state.stale = false;
    state.duplicateMap.clear();
    renderFiles();
    renderPreview();
    updateFooter();
  }

  function buildDropZone() {
    const zone = h('div', { class: 'import-drop', role: 'button', tabindex: '0', 'aria-label': 'Choose documents to import' });
    const iconBox = h('div', { class: 'import-drop__icon' });
    iconBox.append(iconSpan('upload', { size: 23 }));
    zone.append(
      iconBox,
      h('h3', { text: 'Drop documents here or click to browse' }),
      h('p', { text: `Up to ${MAX_IMPORT_FILES} files at once. Maximum ${importSettings.maxFileSizeMB} MB per file.` }),
    );
    const input = h('input', {
      type: 'file',
      accept: IMPORT_ACCEPT,
      multiple: true,
      hidden: true,
    });
    const openPicker = () => input.click();
    zone.addEventListener('click', openPicker);
    zone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openPicker();
      }
    });
    dropZoneDrop(zone, (files) => handleFiles(files));
    input.addEventListener('change', () => {
      if (input.files?.length) handleFiles(input.files);
      input.value = '';
    });
    zone.append(input);
    return zone;
  }

  function renderOptions() {
    optionsPanel.replaceChildren();
    const card = h('div', { class: 'settings-card', style: { margin: '0' } });
    const head = h('div', { class: 'settings-card__head' });
    head.append(h('h2', { text: 'Import options' }), h('p', { text: 'Changing options after parsing requires parsing the files again.' }));
    const cardBody = h('div', { class: 'settings-card__body' });
    const grid = h('div', { class: 'import-options' });

    const ocrSwitch = createSwitch({
      checked: state.allowOcr,
      label: 'OCR scanned PDFs and images',
      description: 'Runs Tesseract locally. Slower, and recognition can make mistakes. Review the preview.',
      onChange: (checked) => {
        state.allowOcr = checked;
        markOptionsChanged();
        renderOptions();
      },
    });
    grid.append(ocrSwitch);

    const language = createSelect({
      label: 'OCR language',
      value: state.ocrLanguage,
      options: OCR_LANGUAGES.map((item) => ({ value: item.value, label: item.label })),
      onChange: (value) => {
        state.ocrLanguage = value;
        markOptionsChanged();
      },
      help: 'English and Amharic language data are bundled locally.',
    });
    language.style.opacity = state.allowOcr ? '1' : '0.55';
    grid.append(language);

    grid.append(
      createSwitch({
        checked: state.cleanupBlankLines,
        label: 'Collapse excessive blank lines',
        description: 'Keeps paragraph breaks while removing runs of empty lines.',
        onChange: (checked) => {
          state.cleanupBlankLines = checked;
          markOptionsChanged();
        },
      }),
      createSwitch({
        checked: state.removePageArtifacts,
        label: 'Remove page headers, footers, and numbers',
        description: 'Best-effort cleanup for PDFs and exported documents.',
        onChange: (checked) => {
          state.removePageArtifacts = checked;
          markOptionsChanged();
        },
      }),
    );
    cardBody.append(grid);

    const targetWrap = h('div', { class: 'form-grid', style: { marginTop: '14px' } });
    if (currentScript) {
      const target = createSelect({
        label: 'Destination',
        value: state.targetMode,
        options: [
          { value: 'new', label: 'Create new script' },
          { value: 'append', label: `Append to “${truncate(currentScript.title, 42)}”` },
          { value: 'replace', label: `Replace content of “${truncate(currentScript.title, 42)}”` },
        ],
        onChange: (value) => {
          state.targetMode = value;
          renderOptions();
          updateFooter();
        },
        help: 'Append and replace require exactly one successfully parsed file.',
      });
      targetWrap.append(target);
    }

    const folder = createSelect({
      label: 'Folder for new scripts',
      value: state.folderId,
      options: [{ value: '', label: 'Unfiled' }, ...state.folders.map((item) => ({ value: item.id, label: item.name }))],
      onChange: (value) => {
        state.folderId = value;
      },
    });
    folder.style.display = state.targetMode === 'new' ? '' : 'none';
    targetWrap.append(folder);
    cardBody.append(targetWrap);

    const duplicateSwitch = createSwitch({
      checked: state.skipDuplicates,
      label: 'Skip exact duplicates',
      description: 'Compares a content fingerprint against existing scripts. You can turn this off to import a deliberate copy.',
      onChange: (checked) => {
        state.skipDuplicates = checked;
      },
    });
    cardBody.append(duplicateSwitch);

    card.append(head, cardBody);
    optionsPanel.append(card);
  }

  function markOptionsChanged() {
    if (!state.parsed) return;
    state.stale = true;
    renderFiles();
    renderPreview();
    updateFooter();
  }

  function renderFiles() {
    filesPanel.replaceChildren();
    if (!state.files.length) {
      filesPanel.append(h('div', { class: 'empty-inline', text: 'No files selected yet. Choose documents above.' }));
      return;
    }
    const head = h('div', { class: 'section-head' });
    const results = state.files.filter((entry) => entry.status === 'success').length;
    const errors = state.files.filter((entry) => entry.status === 'error').length;
    head.append(
      h('h2', { text: `${pluralize(state.files.length, 'file')} selected` }),
      h('span', { class: 'field-hint', text: `${results} ready${errors ? ` · ${errors} failed` : ''}` }),
    );
    filesPanel.append(head);

    const list = h('div', { class: 'import-files' });
    for (const entry of state.files) {
      const row = h('div', { class: 'import-file' });
      const top = h('div', { class: 'import-file__row' });
      const iconBox = h('div', { class: 'import-file__icon' });
      iconBox.append(iconSpan(fileIcon(entry.kind), { size: 16 }));
      const name = h('div', { class: 'import-file__name', title: entry.file.name, text: entry.file.name });
      const size = h('span', { class: 'import-file__status', text: formatBytes(entry.file.size) });
      const status = h('span', {
        class: `badge ${
          entry.status === 'success'
            ? 'badge--success'
            : entry.status === 'error'
              ? 'badge--danger'
              : entry.status === 'parsing'
                ? 'badge--warning'
                : 'badge--accent'
        }`,
        text:
          entry.status === 'parsing'
            ? 'Parsing…'
            : entry.status === 'success'
              ? 'Ready'
              : entry.status === 'error'
                ? 'Failed'
                : 'Queued',
      });
      top.append(iconBox, name, size, status);
      const remove = h('button', {
        type: 'button',
        class: 'btn btn--icon btn--sm btn--ghost',
        'aria-label': `Remove ${entry.file.name}`,
        title: 'Remove file',
        html: iconSpan('x', { size: 14 }).innerHTML,
      });
      remove.addEventListener('click', () => {
        if (state.parsing) return;
        state.files = state.files.filter((item) => item.id !== entry.id);
        state.titles.delete(entry.id);
        state.duplicateMap.delete(entry.id);
        if (state.activeId === entry.id) state.activeId = state.files[0]?.id || null;
        state.parsed = state.files.some((item) => item.status === 'success');
        renderFiles();
        renderPreview();
        updateFooter();
      });
      top.append(remove);
      row.append(top);
      if (entry.status === 'parsing') {
        const track = h('div', { class: 'progress-track' });
        const fill = h('div', { class: 'progress-track__fill', style: { width: `${Math.max(2, entry.progress || 0)}%` } });
        track.append(fill);
        row.append(track, h('div', { class: 'field-hint', style: { marginTop: '3px' }, text: entry.progressMessage || 'Reading file…' }));
      }
      if (entry.error) {
        const errorRow = h('div', { class: 'import-file__error' });
        errorRow.append(document.createTextNode(entry.error));
        if (entry.canOcr && !state.allowOcr) {
          errorRow.append(document.createTextNode(' '));
          const retry = button('Enable OCR and retry', { size: 'sm', iconName: 'scan' });
          retry.addEventListener('click', () => {
            state.allowOcr = true;
            state.ocrLanguage = importSettings.ocrLanguage;
            state.duplicateMap.clear();
            renderOptions();
            parseFiles([entry.id]);
          });
          errorRow.append(retry);
        }
        row.append(errorRow);
      }
      if (entry.status === 'success' && state.duplicateMap.get(entry.id)?.length) {
        row.append(
          h('div', { class: 'import-file__warning', text: `This content already exists as “${state.duplicateMap.get(entry.id)[0].title}”. ${state.skipDuplicates ? 'It will be skipped.' : 'A copy will be imported.'}` }),
        );
      }
      list.append(row);
    }
    filesPanel.append(list);

    if (state.parsing) {
      const track = h('div', { class: 'progress-track', style: { marginTop: '10px' } });
      track.append(h('div', { class: 'progress-track__fill', style: { width: `${state.overallPercent}%` } }));
      filesPanel.append(track);
    }
    if (state.stale && !state.parsing) {
      const warning = h('div', { class: 'backup-banner', style: { marginTop: '10px' } });
      warning.append(iconSpan('warning', { size: 16 }), h('span', { text: 'Import options changed. Parse the files again before importing.' }));
      filesPanel.append(warning);
    }
  }

  function activeEntry() {
    return state.files.find((entry) => entry.id === state.activeId && entry.status === 'success') || state.files.find((entry) => entry.status === 'success') || null;
  }

  function renderPreview() {
    previewPanel.replaceChildren();
    const ready = state.files.filter((entry) => entry.status === 'success');
    if (!ready.length) {
      if (state.files.some((entry) => entry.status === 'error') && !state.parsing) {
        previewPanel.append(h('div', { class: 'empty-inline', text: 'No files were parsed successfully. Fix or remove the failed files and try again.' }));
      }
      return;
    }
    if (!state.files.some((entry) => entry.id === state.activeId)) state.activeId = ready[0].id;
    const entry = activeEntry();
    if (!entry) return;

    const card = h('div', { class: 'settings-card', style: { margin: '0' } });
    const head = h('div', { class: 'settings-card__head' });
    head.append(h('h2', { text: 'Preview before saving' }), h('p', { text: 'Review the text, correct the title, and confirm that the formatting is acceptable.' }));
    const cardBody = h('div', { class: 'settings-card__body' });

    const tabs = h('div', { class: 'preview-tabs', role: 'tablist' });
    for (const item of ready) {
      const tab = h('button', {
        type: 'button',
        class: 'preview-tab',
        role: 'tab',
        'aria-selected': String(item.id === entry.id),
        title: item.file.name,
        text: truncate(item.result.title || item.file.name, 34),
      });
      tab.addEventListener('click', () => {
        state.activeId = item.id;
        renderPreview();
      });
      tabs.append(tab);
    }
    cardBody.append(tabs);

    const titleField = h('div', { class: 'field' });
    titleField.append(h('label', { class: 'label', for: `import-title-${entry.id}`, text: 'Script title' }));
    const titleInput = h('input', {
      class: 'input',
      id: `import-title-${entry.id}`,
      maxlength: '200',
      value: state.titles.get(entry.id) || entry.result.title || entry.file.name,
    });
    titleInput.addEventListener('input', () => {
      state.titles.set(entry.id, titleInput.value);
    });
    titleField.append(titleInput);
    cardBody.append(titleField);

    const stats = h('div', { class: 'review-meta' });
    const words = countWords(entry.result.content);
    stats.append(
      badge(FILE_TYPE_LABELS[entry.kind] || entry.kind, 'accent'),
      badge(entry.result.contentFormat === 'markdown' ? 'Markdown' : 'Plain text', 'violet'),
      h('span', { text: `${words.toLocaleString()} words` }),
      h('span', { text: `≈ ${formatDuration((words / 140) * 60)} at 140 WPM` }),
      h('span', { text: formatBytes(entry.file.size) }),
    );
    cardBody.append(stats);

    if (entry.result.warnings?.length) {
      for (const warning of entry.result.warnings) {
        const note = h('div', { class: 'import-file__warning' });
        note.append(iconSpan('info', { size: 14 }), document.createTextNode(` ${warning}`));
        note.style.display = 'flex';
        note.style.gap = '5px';
        note.style.alignItems = 'flex-start';
        cardBody.append(note);
      }
    }

    const preview = h('div', { class: 'import-preview', tabindex: '0' });
    preview.innerHTML = renderScriptHtml(entry.result.content, entry.result.contentFormat);
    cardBody.append(preview);
    card.append(head, cardBody);
    previewPanel.append(card);
  }

  function updateFooter() {
    const readyCount = state.files.filter((entry) => entry.status === 'success').length;
    const duplicates = state.files.filter((entry) => entry.status === 'success' && state.duplicateMap.get(entry.id)?.length).length;
    const actionable = state.skipDuplicates && state.targetMode === 'new' ? readyCount - duplicates : readyCount;
    const canImport =
      !state.parsing &&
      !state.stale &&
      state.parsed &&
      readyCount > 0 &&
      (state.targetMode === 'new' ? actionable > 0 : readyCount === 1);
    importButton.disabled = !canImport;
    parseButton.disabled = !state.files.length || state.parsing;
    parseButton.textContent = state.parsed || state.stale ? 'Parse again' : 'Parse files';
    cancelImport.textContent = state.parsing ? 'Cancel parsing' : 'Close';
    if (state.parsing) {
      statusText.textContent = `Parsing ${state.files.filter((entry) => entry.status === 'success' || entry.status === 'error').length} of ${state.files.length}…`;
    } else if (!state.files.length) {
      statusText.textContent = 'Select one or more documents to begin.';
    } else if (state.stale) {
      statusText.textContent = 'Options changed — parse again before importing.';
    } else if (!state.parsed) {
      statusText.textContent = `${pluralize(state.files.length, 'file')} ready to parse.`;
    } else {
      statusText.textContent = `${readyCount} of ${pluralize(state.files.length, 'file')} ready${duplicates && state.skipDuplicates ? ` · ${duplicates} duplicate${duplicates === 1 ? '' : 's'} will be skipped` : ''}.`;
    }
    if (state.targetMode !== 'new' && readyCount > 1) {
      statusText.textContent = 'Append/Replace requires exactly one successfully parsed file.';
      importButton.disabled = true;
    }
  }

  async function parseFiles(onlyIds = null) {
    if (state.parsing) return;
    const targets = onlyIds
      ? state.files.filter((entry) => onlyIds.includes(entry.id))
      : state.files.filter((entry) => entry.status !== 'error' || entry.canOcr || true);
    if (!targets.length) return;
    state.controller?.abort();
    state.controller = new AbortController();
    const signal = state.controller.signal;
    state.parsing = true;
    state.parsed = false;
    state.stale = false;
    state.overallPercent = 0;
    state.duplicateMap.clear();
    for (const entry of targets) {
      if (!isSupportedImportFile(entry.file.name)) {
        entry.status = 'error';
        entry.error = `Unsupported file type ${extensionLabel(entry.file.name) || '(none)'}.`;
        continue;
      }
      entry.status = 'pending';
      entry.result = null;
      entry.error = null;
      entry.canOcr = false;
      entry.progress = 0;
      entry.progressMessage = '';
    }
    renderFiles();
    renderPreview();
    updateFooter();

    const maxFileSizeMB = settingsStore.get().import.maxFileSizeMB;
    let completed = 0;
    for (const entry of targets) {
      if (signal.aborted) break;
      if (!isSupportedImportFile(entry.file.name)) {
        completed += 1;
        continue;
      }
      entry.status = 'parsing';
      entry.progress = 2;
      entry.progressMessage = 'Validating file…';
      renderFiles();
      try {
        const result = await parseImportFile(entry.file, {
          maxFileSizeMB,
          cleanup: {
            collapseBlankLines: state.cleanupBlankLines,
            removePageArtifacts: state.removePageArtifacts,
          },
          allowOcr: state.allowOcr,
          ocrLanguage: state.ocrLanguage,
          signal,
          onProgress: (progress) => {
            entry.progress = typeof progress.percent === 'number' ? progress.percent : entry.progress;
            entry.progressMessage = progress.message || entry.progressMessage;
            state.overallPercent = Math.round(((completed + entry.progress / 100) / targets.length) * 100);
            renderFiles();
          },
        });
        entry.result = result;
        entry.status = 'success';
        entry.progress = 100;
        if (!state.titles.get(entry.id)) state.titles.set(entry.id, result.title || entry.file.name);
        const hash = await computeContentHash(result.content, result.contentFormat);
        const matches = await findScriptsByContentHash(hash);
        if (matches.length) state.duplicateMap.set(entry.id, matches);
      } catch (error) {
        if (isAbortError(error) || signal.aborted) {
          entry.status = 'pending';
          entry.progressMessage = 'Cancelled';
          break;
        }
        entry.status = 'error';
        entry.error = friendlyErrorMessage(error, 'This file could not be parsed.');
        entry.canOcr = Boolean(error?.canOcr);
        if (error instanceof ImportError && error.detail) console.warn(`Import detail for ${entry.file.name}:`, error.detail);
      }
      completed += 1;
      state.overallPercent = Math.round((completed / targets.length) * 100);
      renderFiles();
      renderPreview();
      updateFooter();
    }

    state.parsing = false;
    state.parsed = state.files.some((entry) => entry.status === 'success');
    if (signal.aborted) {
      state.parsed = state.files.some((entry) => entry.status === 'success');
      toast('Parsing was cancelled. Successfully parsed files were kept for review.', { type: 'info' });
    }
    renderFiles();
    renderPreview();
    updateFooter();
  }

  async function commitImport() {
    if (importButton.disabled) return;
    importButton.disabled = true;
    setButtonBusy(importButton, true, 'Importing…');
    try {
      const successful = state.files.filter((entry) => entry.status === 'success');
      const now = new Date().toISOString();
      if (state.targetMode === 'append' || state.targetMode === 'replace') {
        if (successful.length !== 1) throw new Error('Append and replace require exactly one parsed file.');
        const entry = successful[0];
        const live = await getScript(currentScript.id);
        if (!live) throw new Error('The target script no longer exists. It may have been deleted in another tab.');
        let content;
        let contentFormat;
        if (state.targetMode === 'append') {
          contentFormat = live.contentFormat;
          const addition =
            live.contentFormat === 'plain' && entry.result.contentFormat === 'markdown'
              ? stripMarkdownToText(entry.result.content).trim()
              : entry.result.content;
          content = `${live.content.replace(/\s+$/, '')}\n\n${addition}`.trim();
        } else {
          content = entry.result.content;
          contentFormat = entry.result.contentFormat;
        }
        if (settingsStore.get().general.revisionHistory) {
          await addRevision({
            id: uid('revision-'),
            scriptId: live.id,
            title: live.title,
            content: live.content,
            contentFormat: live.contentFormat,
            createdAt: now,
            reason: 'before-import',
          });
        }
        const updated = await prepareScriptRecord(
          {
            ...live,
            title: state.titles.get(entry.id)?.trim() || live.title,
            content,
            contentFormat,
            updatedAt: now,
            sourceFileName: entry.file.name,
            sourceFormat: entry.result.sourceFormat,
          },
          { existing: live },
        );
        await saveScript(updated);
        toast(`${state.targetMode === 'append' ? 'Appended' : 'Replaced'} content from ${entry.file.name}.`, {
          type: 'success',
          title: 'Import complete',
        });
        modal.close({ records: [updated], target: state.targetMode });
        onAppliedToCurrent?.(updated);
        onImported?.([updated]);
        return;
      }

      let skipped = 0;
      let toImport = successful;
      if (state.skipDuplicates) {
        toImport = successful.filter((entry) => !state.duplicateMap.get(entry.id)?.length);
        skipped = successful.length - toImport.length;
      }
      if (!toImport.length) {
        toast('Every selected file duplicates an existing script. Nothing was imported.', { type: 'info', title: 'No changes' });
        modal.close({ records: [], skipped });
        return;
      }
      const batchHashes = new Set();
      const prepared = [];
      for (const entry of toImport) {
        const title = (state.titles.get(entry.id) || entry.result.title || entry.file.name).trim();
        const record = await prepareScriptRecord({
          id: uid('script-'),
          title: title || 'Imported script',
          content: entry.result.content,
          contentFormat: entry.result.contentFormat,
          folderId: state.folderId || null,
          tags: normalizeTags(entry.result.tags || []),
          isFavorite: false,
          createdAt: now,
          updatedAt: now,
          sourceFileName: entry.file.name,
          sourceFormat: entry.result.sourceFormat,
        });
        if (batchHashes.has(record.contentHash)) {
          skipped += 1;
          continue;
        }
        batchHashes.add(record.contentHash);
        prepared.push(record);
      }
      await saveScripts(prepared);
      toast(
        `Created ${pluralize(prepared.length, 'script')}${skipped ? ` and skipped ${pluralize(skipped, 'duplicate')}.` : '.'}`,
        { type: 'success', title: 'Import complete' },
      );
      modal.close({ records: prepared, skipped });
      onImported?.(prepared);
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The imported content could not be saved.'), { type: 'error', title: 'Import failed' });
      setButtonBusy(importButton, false);
      updateFooter();
    }
  }

  const onHeaderClose = () => {
    if (state.parsing) state.controller?.abort();
    state.controller?.abort();
  };
  // The modal close button is part of the shared header; intercept pointerdown
  // so an in-progress parse is cancelled before the dialog disappears.
  modal.header.querySelector('.modal__close')?.addEventListener('click', onHeaderClose, { capture: true });
  cancelImport.addEventListener('click', () => {
    if (state.parsing) {
      state.controller?.abort();
      state.parsing = false;
      updateFooter();
      renderFiles();
      return;
    }
    modal.close();
  });

  updateFooter();
  return modal;
}

function dropZoneDrop(zone, onFiles) {
  const activate = () => {
    zone.dataset.drag = 'true';
  };
  const deactivate = () => {
    delete zone.dataset.drag;
  };
  zone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    activate();
  });
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    activate();
  });
  zone.addEventListener('dragleave', (event) => {
    if (!zone.contains(event.relatedTarget)) deactivate();
  });
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    deactivate();
    const files = event.dataTransfer?.files;
    if (files?.length) onFiles(files);
  });
}
