import {
  addRevision,
  bulkUpdateScripts,
  deleteScriptPermanently,
  duplicateScript,
  getAllFolders,
  getRevisionsForScript,
  getScript,
  pruneRevisions,
  restoreScript,
  saveScript,
  trashScript,
} from '../database.js';
import {
  computeContentHash,
  normalizeTags,
  prepareScriptRecord,
  scriptCounts,
} from '../script-validation.js';
import { renderScriptHtml } from '../render-content.js';
import { SCRIPT_EXPORT_FORMATS, downloadScript, printScript } from '../file-exporter.js';
import {
  badge,
  button,
  confirmDialog,
  createSelect,
  emptyState,
  h,
  iconButton,
  iconSpan,
  openMenu,
  openModal,
  promptDialog,
  setButtonBusy,
  toast,
} from '../ui.js';
import { icon } from '../icons.js';
import {
  countWords,
  debounce,
  downloadText,
  escapeHtml,
  formatDate,
  formatDuration,
  formatRelative,
  formatTimeOfDay,
  friendlyErrorMessage,
  nowIso,
  sanitizeFileName,
  truncate,
  uid,
} from '../utils.js';

function formatWordCount(value) {
  return Number(value || 0).toLocaleString();
}

function readingTime(seconds) {
  if (!seconds) return '0s';
  return formatDuration(seconds);
}

const AUTOSAVE_DELAY = 850;
const REVISION_INTERVAL_MS = 45_000;

export async function editorView(ctx, routeContext) {
  const scriptId = routeContext.params.id;
  let script;
  try {
    script = await getScript(scriptId);
  } catch (error) {
    return {
      element: emptyState({
        iconName: 'warning',
        title: 'The script could not be opened',
        description: friendlyErrorMessage(error),
        actions: [{ label: 'Back to library', icon: 'arrowLeft', primary: true, onClick: () => ctx.navigate('/library') }],
      }),
    };
  }

  if (!script) {
    return {
      element: emptyState({
        iconName: 'fileText',
        title: 'Script not found',
        description: 'It may have been deleted in another tab, or the link may be incomplete. Open the library to choose another script.',
        actions: [{ label: 'Browse library', icon: 'library', primary: true, onClick: () => ctx.navigate('/library') }],
      }),
    };
  }

  if (script.deletedAt) {
    return deletedScriptView(ctx, script);
  }

  const settings = ctx.settingsStore.get();
  const tabId = uid('tab-');
  const state = {
    base: { ...script },
    title: script.title,
    content: script.content,
    contentFormat: script.contentFormat,
    folderId: script.folderId,
    tags: [...(script.tags || [])],
    isFavorite: script.isFavorite,
    dirty: false,
    editVersion: 0,
    savingPromise: null,
    saveTimer: null,
    conflict: null,
    revisions: [],
    lastRevisionAt: 0,
    folders: [],
    previewOpen: false,
    findOpen: false,
    findIndex: 0,
    caseSensitive: false,
    lastContentValue: script.content,
    undoStack: [],
    redoStack: [],
    destroyed: false,
    saveStatus: 'saved',
    saveMessage: 'Saved',
  };
  let channel = null;
  let searchDebounce = null;

  const element = h('div', { class: 'stack' });
  const pageHead = h('div', { class: 'page-head' });
  const headText = h('div');
  const headTitle = h('h1', { text: 'Script editor' });
  const headCopy = h('p', { text: 'Write in plain text or Markdown. Autosave is debounced, and a conflict is never overwritten silently.' });
  headText.append(headTitle, headCopy);
  const headActions = h('div', { class: 'page-actions' });
  const readButton = button('Read', { iconName: 'play', variant: 'violet', onClick: () => openReader() });
  const saveButton = button('Save', { iconName: 'save', onClick: () => manualSave() });
  const moreButton = iconButton('more', 'More script actions', { onClick: () => openMoreMenu(moreButton) });
  headActions.append(readButton, saveButton, moreButton);
  pageHead.append(headText, headActions);
  element.append(pageHead);

  const shell = h('div', { class: 'editor-shell' });
  const main = h('div', { class: 'editor-main' });
  const titleRow = h('div', { class: 'editor-title-row' });
  const titleInput = h('input', {
    class: 'editor-title-input',
    type: 'text',
    value: state.title,
    maxlength: '200',
    placeholder: 'Untitled script',
    'aria-label': 'Script title',
    autofocus: true,
    spellcheck: 'false',
  });
  const metaRow = h('div', { class: 'editor-meta-row' });
  const metaBadges = h('span', { style: { display: 'contents' } });
  metaRow.append(metaBadges);
  titleRow.append(titleInput, metaRow);

  const toolbar = h('div', { class: 'editor-toolbar', role: 'toolbar', 'aria-label': 'Formatting toolbar' });
  const findBar = h('div', { class: 'find-bar', 'data-open': 'false' });
  const conflictBanner = h('div', { class: 'conflict-banner', hidden: true });
  const preview = h('div', { class: 'import-preview', hidden: true, style: { minHeight: '62vh', maxHeight: 'none' } });
  const textareaWrap = h('div', { class: 'editor-textarea-wrap' });
  const textarea = h('textarea', {
    class: 'editor-textarea',
    spellcheck: String(settings.editor.spellcheck),
    placeholder: 'Start writing your script…\n\nUse blank lines between paragraphs. In Markdown mode, add [[pause]] or [[cue: look up]] to guide your delivery.',
    'aria-label': 'Script content',
  });
  textarea.value = state.content;
  textarea.style.fontFamily = settings.editor.fontFamily === 'mono' ? 'var(--font-mono)' : settings.editor.fontFamily === 'serif' ? 'var(--font-serif)' : 'var(--font-sans)';
  textarea.style.fontSize = `${settings.editor.fontSize}px`;
  textarea.style.lineHeight = String(settings.editor.lineHeight);
  textarea.style.maxWidth = `${settings.editor.maxWidth}px`;
  textarea.style.margin = '0 auto';
  textareaWrap.append(textarea, preview);

  const statusBar = h('div', { class: 'editor-statusbar' });
  const statusLeft = h('div', { class: 'editor-statusbar__group' });
  const saveStatus = h('span', { class: 'save-status', 'data-state': 'saved' });
  const saveDot = h('span', { class: 'save-status__dot' });
  const saveLabel = h('span', { text: 'Saved' });
  saveStatus.append(saveDot, saveLabel);
  const saveRetry = button('Retry', { size: 'sm', variant: 'ghost', iconName: 'refresh', onClick: () => manualSave() });
  saveRetry.hidden = true;
  const formatStatus = h('span', { text: '' });
  statusLeft.append(saveStatus, saveRetry, formatStatus);
  const statsLine = h('div', { class: 'editor-statusbar__group' });
  const statWords = h('span');
  const statChars = h('span');
  const statTime = h('span');
  statsLine.append(statWords, statChars, statTime);
  statusBar.append(statusLeft, statsLine);
  main.append(titleRow, toolbar, findBar, conflictBanner, textareaWrap, statusBar);
  shell.append(main);

  const side = h('aside', { class: 'editor-sidebar', 'aria-label': 'Script details' });

  /* Stats card */
  const statsCard = h('div', { class: 'side-card' });
  statsCard.append(h('h2', { class: 'side-card__title', text: 'Script stats' }));
  const statsGrid = h('div', { class: 'side-stat-grid' });
  const statRefs = {};
  for (const [key, label] of [['words', 'Words'], ['chars', 'Characters'], ['paras', 'Paragraphs'], ['time', 'Est. reading']]) {
    const box = h('div', { class: 'side-stat' });
    const value = h('div', { class: 'side-stat__value', text: '0' });
    box.append(value, h('div', { class: 'side-stat__label', text: label }));
    statRefs[key] = value;
    statsGrid.append(box);
  }
  statsCard.append(statsGrid);
  side.append(statsCard);

  /* Organization card */
  const orgCard = h('div', { class: 'side-card' });
  orgCard.append(h('h2', { class: 'side-card__title', text: 'Organize' }));
  const folderField = h('div', { class: 'field' });
  folderField.append(h('label', { class: 'label', text: 'Folder' }));
  const folderSelect = h('select', { class: 'select', 'aria-label': 'Folder' });
  folderField.append(folderSelect);
  const favoriteToggle = button('Favorite', { iconName: 'star', size: 'sm' });
  favoriteToggle.addEventListener('click', () => {
    state.isFavorite = !state.isFavorite;
    syncFavoriteUi();
    markDirty();
  });
  const tagsField = h('div', { class: 'field' });
  tagsField.append(h('label', { class: 'label', text: 'Tags' }));
  const tagList = h('div', { class: 'tag-list' });
  const tagInput = h('input', { class: 'input', placeholder: 'Add tag, press Enter', maxlength: '40', 'aria-label': 'Add a tag', style: { minHeight: '30px', fontSize: '11px' } });
  tagInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addTag(tagInput.value);
    tagInput.value = '';
  });
  tagsField.append(tagList, tagInput);
  const orgActions = h('div', { class: 'btn-row', style: { marginTop: '10px' } });
  orgActions.append(favoriteToggle);
  orgCard.append(folderField, tagsField, orgActions);
  side.append(orgCard);

  /* Reading card */
  const readCard = h('div', { class: 'side-card' });
  readCard.append(h('h2', { class: 'side-card__title', text: 'Rehearsal' }));
  const readCopy = h('div', { class: 'field-hint', text: 'Save and open the distraction-free teleprompter with your current reader preset.' });
  const readNow = button('Open teleprompter', { iconName: 'play', variant: 'primary', className: 'w-full' });
  readNow.style.width = '100%';
  readNow.style.marginTop = '9px';
  readNow.addEventListener('click', () => openReader());
  const printButton = button('Print script', { iconName: 'printer', size: 'sm' });
  printButton.style.marginTop = '6px';
  printButton.style.width = '100%';
  printButton.addEventListener('click', () => printCurrent());
  readCard.append(readCopy, readNow, printButton);
  side.append(readCard);

  /* History card */
  const historyCard = h('div', { class: 'side-card' });
  const historyHead = h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } });
  historyHead.append(h('h2', { class: 'side-card__title', text: 'Revision history', style: { margin: '0' } }));
  const historyAll = h('button', { type: 'button', class: 'btn btn--sm btn--ghost', text: 'View all' });
  historyAll.addEventListener('click', () => openHistoryDialog());
  historyHead.append(historyAll);
  const historyList = h('div', { class: 'history-list' });
  historyCard.append(historyHead, historyList);
  side.append(historyCard);

  const hintCard = h('div', { class: 'side-card' });
  hintCard.append(
    h('h2', { class: 'side-card__title', text: 'Writing hints' }),
    h('div', { class: 'editor-hint', text: 'Blank lines separate paragraphs. In Markdown mode: **bold**, *italic*, # heading, - list, > quote. [[pause]] inserts a pause dot; [[cue: look up]] adds a stage cue. Imported HTML never executes.' }),
  );
  side.append(hintCard);

  shell.append(side);
  element.append(shell);

  const bottomNote = h('div', { class: 'editor-hint', style: { marginTop: '2px' } });
  element.append(bottomNote);

  function setSaveStatus(status, message) {
    state.saveStatus = status;
    saveStatus.dataset.state = status;
    saveLabel.textContent = message;
    saveRetry.hidden = status !== 'error';
    if (status === 'saved') {
      saveStatus.title = state.base?.updatedAt ? `Last saved ${formatDate(state.base.updatedAt, { timeStyle: 'medium' })}` : 'Saved locally';
    }
  }

  function updateStats() {
    const counts = scriptCounts(state.content, 140);
    const words = counts.wordCount;
    statRefs.words.textContent = words.toLocaleString();
    statRefs.chars.textContent = counts.characterCount.toLocaleString();
    statRefs.paras.textContent = counts.paragraphCount.toLocaleString();
    statRefs.time.textContent = readingTime(counts.estimatedSeconds);
    statWords.textContent = `${formatWordCount(words)} words`;
    statChars.textContent = `${counts.characterCount.toLocaleString()} chars`;
    statTime.textContent = `≈ ${readingTime(counts.estimatedSeconds)} at 140 WPM`;
    formatStatus.textContent = state.contentFormat === 'markdown' ? 'Markdown' : 'Plain text';
    metaBadges.replaceChildren(
      badge(state.contentFormat === 'markdown' ? 'Markdown' : 'Plain text', 'accent'),
      badge(state.dirty ? 'Unsaved' : 'Saved locally', state.dirty ? 'warning' : 'success'),
    );
    if (state.isFavorite) metaBadges.append(badge('Favorite', 'violet'));
    metaRow.append(); // No-op; keep layout stable.
  }

  function syncFavoriteUi() {
    favoriteToggle.innerHTML = '';
    favoriteToggle.append(iconSpan('star', { size: 14 }), h('span', { text: state.isFavorite ? 'Favorited' : 'Favorite' }));
    favoriteToggle.setAttribute('aria-pressed', String(state.isFavorite));
    favoriteToggle.classList.toggle('btn--violet', state.isFavorite);
    updateStats();
  }

  function renderTags() {
    tagList.replaceChildren();
    if (!state.tags.length) tagList.append(h('span', { class: 'field-hint', text: 'No tags yet.' }));
    for (const tag of state.tags) {
      const chip = h('span', { class: 'tag-chip' });
      chip.append(document.createTextNode(tag));
      const remove = h('button', {
        type: 'button',
        'aria-label': `Remove tag ${tag}`,
        html: icon('x', { size: 10 }),
      });
      remove.addEventListener('click', () => {
        state.tags = state.tags.filter((item) => item !== tag);
        renderTags();
        markDirty();
      });
      chip.append(remove);
      tagList.append(chip);
    }
  }

  function addTag(raw) {
    const [tag] = normalizeTags([raw]);
    if (!tag) return false;
    if (state.tags.length >= 30) {
      toast('A script can have at most 30 tags.', { type: 'warning' });
      return false;
    }
    if (state.tags.some((item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase())) {
      toast('That tag is already on this script.', { type: 'info', duration: 2000 });
      return false;
    }
    state.tags.push(tag);
    renderTags();
    markDirty();
    return true;
  }

  function renderFolderSelect() {
    folderSelect.replaceChildren(h('option', { value: '', text: 'Unfiled' }));
    for (const folder of state.folders) {
      const option = h('option', { value: folder.id, text: folder.name });
      if (folder.id === state.folderId) option.selected = true;
      folderSelect.append(option);
    }
  }

  function updateMetaRow() {
    metaBadges.replaceChildren(
      badge(state.contentFormat === 'markdown' ? 'Markdown' : 'Plain text', 'accent'),
      badge(state.dirty ? 'Unsaved' : 'Saved locally', state.dirty ? 'warning' : 'success'),
    );
    if (state.isFavorite) metaBadges.append(badge('Favorite', 'violet'));
    const updated = h('span', { text: state.base?.updatedAt ? `Updated ${formatRelative(state.base.updatedAt)}` : 'New script' });
    metaBadges.append(updated);
  }

  function markDirty() {
    state.dirty = true;
    state.editVersion += 1;
    updateStats();
    updateMetaRow();
    updatePreview();
    if (state.conflict) {
      setSaveStatus('conflict', 'Conflict — review');
      return;
    }
    setSaveStatus('unsaved', settings.editor.autosave ? 'Unsaved changes · saving soon' : 'Unsaved changes');
    if (settings.editor.autosave) scheduleAutosave();
  }

  function scheduleAutosave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      saveNow({ reason: 'autosave' }).catch(() => {});
    }, AUTOSAVE_DELAY);
  }

  async function conflictFromLatest(latest) {
    state.conflict = { latest };
    setSaveStatus('conflict', 'Conflict — review');
    showConflictBanner();
    if (latest) {
      ctx.setTopbarTitle(state.title, 'Editor');
    }
  }

  function showConflictBanner() {
    conflictBanner.hidden = false;
    conflictBanner.replaceChildren();
    const latest = state.conflict?.latest;
    const deleted = latest?.deletedAt;
    const message = deleted
      ? 'This script was moved to trash in another tab. Saving here would fail or resurrect deleted content.'
      : `This script changed in another tab${latest?.updatedAt ? ` (${formatRelative(latest.updatedAt)})` : ''}. Your unsaved edits have not been overwritten.`;
    conflictBanner.append(iconSpan('warning', { size: 17 }));
    const copy = h('div', { style: { minWidth: '0', flex: '1' } });
    copy.append(h('strong', { text: deleted ? 'Script deleted elsewhere' : 'Edit conflict detected' }), h('div', { text: message }));
    const actions = h('div', { class: 'btn-row', style: { marginLeft: 'auto' } });
    if (!deleted) {
      actions.append(
        button('Load latest', {
          size: 'sm',
          iconName: 'refresh',
          onClick: async () => {
            try {
              const fresh = await getScript(scriptId);
              if (!fresh) throw new Error('The latest copy no longer exists.');
              applyExternalRecord(fresh);
              state.conflict = null;
              conflictBanner.hidden = true;
              setSaveStatus('saved', 'Saved');
              toast('Loaded the latest saved version. Your conflicting edits were discarded by this action.', { type: 'info' });
            } catch (error) {
              toast(friendlyErrorMessage(error, 'The latest version could not be loaded.'), { type: 'error' });
            }
          },
        }),
        button('Keep mine', {
          size: 'sm',
          iconName: 'save',
          variant: 'primary',
          onClick: async () => {
            state.conflict = null;
            conflictBanner.hidden = true;
            const ok = await saveNow({ force: true, reason: 'conflict-resolution' });
            if (!ok) showConflictBanner();
          },
        }),
      );
    }
    actions.append(
      button('Save as copy', {
        size: 'sm',
        iconName: 'copy',
        onClick: async () => {
          const copy = await saveDraftAsCopy();
          if (copy) ctx.navigate(`/editor/${encodeURIComponent(copy.id)}`);
        },
      }),
    );
    copy.append(actions);
    conflictBanner.append(copy);
  }

  function applyExternalRecord(record) {
    state.base = { ...record };
    state.title = record.title;
    state.content = record.content;
    state.contentFormat = record.contentFormat;
    state.folderId = record.folderId;
    state.tags = [...(record.tags || [])];
    state.isFavorite = record.isFavorite;
    state.dirty = false;
    state.editVersion += 1;
    state.lastContentValue = record.content;
    state.undoStack = [];
    state.redoStack = [];
    titleInput.value = record.title;
    textarea.value = record.content;
    renderFolderSelect();
    renderTags();
    syncFavoriteUi();
    updateStats();
    updateMetaRow();
    updatePreview();
    setSaveStatus('saved', 'Saved');
    ctx.setTopbarTitle(record.title, 'Editor');
  }

  async function saveNow({ force = false, reason = 'manual' } = {}) {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    if (state.savingPromise) {
      try {
        await state.savingPromise;
      } catch {
        // The new attempt below reports its own error.
      }
    }
    if (state.destroyed) return false;
    if (!state.dirty && !force) return true;
    if (state.conflict && !force) {
      setSaveStatus('conflict', 'Conflict — review');
      return false;
    }

    const snapshot = {
      title: titleInput.value.trim() || 'Untitled script',
      content: textarea.value,
      contentFormat: state.contentFormat,
      folderId: state.folderId,
      tags: normalizeTags(state.tags),
      isFavorite: state.isFavorite,
    };
    const editVersionAtStart = state.editVersion;
    setSaveStatus('saving', 'Saving…');
    updateMetaRow();

    state.savingPromise = (async () => {
      const draftHash = await computeContentHash(snapshot.content, snapshot.contentFormat);
      const latest = await getScript(scriptId);
      if (!latest) {
        const error = new Error('This script no longer exists in the local database. Save your work as a copy.');
        error.code = 'SCRIPT_MISSING';
        throw error;
      }
      if (latest.deletedAt) {
        state.conflict = { latest };
        showConflictBanner();
        setSaveStatus('conflict', 'Script deleted elsewhere');
        return false;
      }
      const externalChange =
        latest.updatedAt !== state.base.updatedAt &&
        latest.contentHash !== draftHash &&
        latest.contentHash !== state.base.contentHash;
      if (externalChange && !force) {
        await conflictFromLatest(latest);
        return false;
      }
      const now = nowIso();
      const record = await prepareScriptRecord(
        {
          ...latest,
          ...snapshot,
          updatedAt: now,
        },
        { existing: latest },
      );
      if (record.content !== state.base.content && settings.general.revisionHistory) {
        const shouldAddRevision = Date.now() - state.lastRevisionAt > REVISION_INTERVAL_MS || reason === 'manual' || reason === 'before-import';
        if (shouldAddRevision) {
          try {
            await addRevision({
              id: uid('revision-'),
              scriptId,
              title: state.base.title,
              content: state.base.content,
              contentFormat: state.base.contentFormat,
              createdAt: now,
              reason,
            });
            state.lastRevisionAt = Date.now();
            await pruneRevisions(scriptId, 30);
          } catch (revisionError) {
            console.warn('Revision could not be stored', revisionError);
            toast('The script saved, but its revision snapshot could not be stored. Browser storage may be nearly full.', {
              type: 'warning',
              duration: 6500,
            });
          }
        }
      }
      await saveScript(record);
      state.base = { ...record };
      if (state.editVersion === editVersionAtStart) {
        state.dirty = false;
      } else {
        state.dirty = true;
      }
      if (state.conflict) state.conflict = null;
      conflictBanner.hidden = true;
      if (state.dirty) {
        setSaveStatus('unsaved', 'Unsaved changes · saving soon');
        if (settings.editor.autosave) scheduleAutosave();
      } else {
        setSaveStatus('saved', `Saved ${formatTimeOfDay(record.updatedAt)}`);
      }
      updateMetaRow();
      ctx.setTopbarTitle(record.title, 'Editor');
      channel?.postMessage({ type: 'script-updated', scriptId, updatedAt: record.updatedAt, senderId: tabId });
      refreshHistory();
      return true;
    })();

    try {
      const result = await state.savingPromise;
      if (result === false) {
        updateMetaRow();
        return false;
      }
      return true;
    } catch (error) {
      console.error('Save failed', error);
      setSaveStatus('error', 'Save failed — retry');
      updateMetaRow();
      if (error?.code === 'SCRIPT_MISSING') {
        showConflictBanner();
        state.conflict = { latest: null };
      }
      toast(friendlyErrorMessage(error, 'The script could not be saved. Your edits are still in the editor.'), {
        type: 'error',
        title: 'Save failed',
        duration: 8000,
        actions: [
          {
            label: 'Retry',
            onClick: () => saveNow({ force, reason: 'retry' }),
          },
        ],
      });
      return false;
    } finally {
      state.savingPromise = null;
    }
  }

  async function manualSave() {
    saveButton.disabled = true;
    setButtonBusy(saveButton, true, 'Saving…');
    try {
      const ok = await saveNow({ reason: 'manual' });
      if (ok) toast('Script saved locally.', { type: 'success', duration: 2500 });
    } finally {
      setButtonBusy(saveButton, false);
      saveButton.disabled = false;
    }
  }

  async function saveDraftAsCopy() {
    try {
      const now = nowIso();
      const record = await prepareScriptRecord({
        title: `${(titleInput.value || 'Script').slice(0, 184)} (conflicted copy)`,
        content: textarea.value,
        contentFormat: state.contentFormat,
        folderId: state.folderId,
        tags: normalizeTags(state.tags),
        isFavorite: state.isFavorite,
        createdAt: now,
        updatedAt: now,
      });
      await saveScript(record);
      state.base = { ...record };
      state.conflict = null;
      state.dirty = false;
      conflictBanner.hidden = true;
      setSaveStatus('saved', `Saved copy ${formatTimeOfDay(record.updatedAt)}`);
      toast('Your draft was saved as a new script. The other version was left untouched.', { type: 'success' });
      ctx.refreshSidebar();
      return record;
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The copy could not be saved.'), { type: 'error' });
      return null;
    }
  }

  async function fetchFolders() {
    try {
      state.folders = await getAllFolders();
      renderFolderSelect();
    } catch {
      state.folders = [];
      renderFolderSelect();
    }
  }

  async function refreshHistory() {
    try {
      state.revisions = await getRevisionsForScript(scriptId);
      if (!state.lastRevisionAt && state.revisions[0]?.createdAt) {
        state.lastRevisionAt = new Date(state.revisions[0].createdAt).getTime();
      }
      renderHistory();
    } catch {
      historyList.replaceChildren(h('div', { class: 'field-hint', text: 'Revision history is unavailable.' }));
    }
  }

  function renderHistory() {
    historyList.replaceChildren();
    if (!state.revisions.length) {
      historyList.append(h('div', { class: 'field-hint', text: 'No revisions yet. Saves with content changes create snapshots.' }));
      return;
    }
    for (const revision of state.revisions.slice(0, 5)) {
      const item = h('button', { type: 'button', class: 'history-item' });
      item.append(iconSpan('history', { size: 13 }), h('span', { class: 'truncate', text: formatRelative(revision.createdAt) }), h('span', { class: 'faint', text: `· ${(revision.content || '').split(/\s+/).filter(Boolean).length} words` }));
      item.addEventListener('click', () => openRevision(revision));
      historyList.append(item);
    }
  }

  function openHistoryDialog() {
    const modal = openModal({
      title: 'Revision history',
      description: 'Snapshots are stored locally. Restoring one replaces the editor content; save or undo if you change your mind.',
      icon: 'history',
      size: 'lg',
    });
    const body = h('div', { class: 'stack', style: { gap: '8px' } });
    if (!state.revisions.length) {
      body.append(h('div', { class: 'empty-inline', text: 'No revisions yet.' }));
    }
    for (const revision of state.revisions) {
      const row = h('div', { class: 'setting-row', style: { alignItems: 'center', padding: '9px 0', borderBottom: '1px solid var(--line)' } });
      const info = h('div', {});
      info.append(
        h('div', { class: 'setting-row__label', text: `${formatDate(revision.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}` }),
        h('div', { class: 'setting-row__desc', text: `${truncate(revision.title || 'Untitled', 70)} · ${(revision.content || '').split(/\s+/).filter(Boolean).length.toLocaleString()} words` }),
      );
      const actions = h('div', { class: 'btn-row' });
      actions.append(
        button('Preview', { size: 'sm', iconName: 'eye', onClick: () => openRevision(revision) }),
        button('Restore', { size: 'sm', iconName: 'restart', onClick: () => restoreRevision(revision, modal) }),
      );
      row.append(info, actions);
      body.append(row);
    }
    modal.body.append(body);
    modal.footer.append(h('div', { class: 'btn-row' }, button('Close', { variant: 'ghost', onClick: () => modal.close() })));
  }

  function openRevision(revision) {
    const modal = openModal({
      title: 'Revision preview',
      description: `${formatDate(revision.createdAt, { dateStyle: 'long', timeStyle: 'short' })} · ${revision.reason || 'autosave'}`,
      icon: 'history',
      size: 'lg',
    });
    const previewEl = h('div', { class: 'import-preview', style: { maxHeight: '48vh' } });
    previewEl.innerHTML = renderScriptHtml(revision.content, revision.contentFormat);
    modal.body.append(previewEl);
    const footer = h('div', { class: 'btn-row' });
    footer.append(
      button('Close', { variant: 'ghost', onClick: () => modal.close() }),
      button('Restore this revision', {
        iconName: 'restart',
        variant: 'primary',
        onClick: () => restoreRevision(revision, modal),
      }),
    );
    modal.footer.append(footer);
  }

  async function restoreRevision(revision, parentModal = null) {
    const ok = await confirmDialog({
      title: 'Restore this revision?',
      message: 'The current editor content will be replaced. The current version is saved as a revision first so you can recover it.',
      confirmLabel: 'Restore revision',
      details: [`Revision from ${formatDate(revision.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}`],
    });
    if (!ok) return;
    try {
      if (settings.general.revisionHistory) {
        await addRevision({
          id: uid('revision-'),
          scriptId,
          title: state.title,
          content: textarea.value,
          contentFormat: state.contentFormat,
          createdAt: nowIso(),
          reason: 'before-restore',
        });
        await pruneRevisions(scriptId, 30);
      }
      state.title = revision.title || state.title;
      state.content = revision.content || '';
      state.contentFormat = revision.contentFormat || 'plain';
      titleInput.value = state.title;
      textarea.value = state.content;
      state.lastContentValue = state.content;
      state.undoStack = [];
      state.redoStack = [];
      setFormatUi();
      markDirty();
      parentModal?.close();
      toast('Revision restored into the editor. Save to keep it.', { type: 'success' });
      refreshHistory();
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The revision could not be restored.'), { type: 'error' });
    }
  }

  /* ============================================================
     Formatting and editing
     ============================================================ */

  function pushHistory(previous) {
    if (state.undoStack.at(-1) === previous) return;
    state.undoStack.push(previous);
    if (state.undoStack.length > 150) state.undoStack.shift();
    state.redoStack = [];
  }

  function applyContent(next, selectionStart = null, selectionEnd = null) {
    pushHistory(textarea.value);
    state.content = next;
    textarea.value = next;
    state.lastContentValue = next;
    if (selectionStart != null) {
      textarea.focus();
      textarea.setSelectionRange(selectionStart, selectionEnd ?? selectionStart);
    }
    markDirty();
    updateFindCount();
  }

  function undo() {
    if (!state.undoStack.length) {
      toast('Nothing to undo.', { type: 'info', duration: 1600 });
      return;
    }
    const current = textarea.value;
    const previous = state.undoStack.pop();
    state.redoStack.push(current);
    state.content = previous;
    textarea.value = previous;
    state.lastContentValue = previous;
    markDirty();
    textarea.focus();
  }

  function redo() {
    if (!state.redoStack.length) return;
    const current = textarea.value;
    const next = state.redoStack.pop();
    state.undoStack.push(current);
    state.content = next;
    textarea.value = next;
    state.lastContentValue = next;
    markDirty();
    textarea.focus();
  }

  function wrapSelection(before, after, placeholder = 'text') {
    if (state.contentFormat !== 'markdown') {
      toast('Switch to Markdown mode to use formatting.', { type: 'info' });
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;
    const selected = value.slice(start, end) || placeholder;
    const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
    const selectionStart = start + before.length;
    applyContent(next, selectionStart, selectionStart + selected.length);
  }

  function prefixLines(prefix, { removeHeadings = false } = {}) {
    if (state.contentFormat !== 'markdown') {
      toast('Switch to Markdown mode to use formatting.', { type: 'info' });
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = value.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = value.length;
    const block = value.slice(lineStart, lineEnd);
    const lines = block.split('\n').map((line) => {
      const cleaned = removeHeadings ? line.replace(/^#{1,6}\s+/, '') : line;
      return `${prefix}${cleaned}`;
    });
    const replacement = lines.join('\n');
    const next = `${value.slice(0, lineStart)}${replacement}${value.slice(lineEnd)}`;
    applyContent(next, lineStart, lineStart + replacement.length);
  }

  function insertText(text, selectOffset = null) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;
    const next = `${value.slice(0, start)}${text}${value.slice(end)}`;
    applyContent(next, start + (selectOffset ?? text.length));
  }

  async function insertCue() {
    const cue = await promptDialog({
      title: 'Insert a stage cue',
      label: 'Cue text',
      placeholder: 'e.g. smile, look at camera 2',
      help: 'Cues are rendered in the accent colour as uppercase stage directions. They remain in your script text.',
      confirmLabel: 'Insert cue',
      iconName: 'sparkles',
      maxLength: 80,
    });
    if (!cue) return;
    if (state.contentFormat === 'markdown') insertText(` [[cue: ${cue}]] `);
    else insertText(` [[cue: ${cue}]] `);
  }

  function setFormatUi() {
    const isMarkdown = state.contentFormat === 'markdown';
    for (const buttonEl of toolbar.querySelectorAll('[data-requires-markdown="true"]')) {
      buttonEl.disabled = !isMarkdown;
      buttonEl.title = isMarkdown ? buttonEl.dataset.title || buttonEl.getAttribute('aria-label') || '' : 'Switch to Markdown mode to use formatting';
    }
    for (const buttonEl of toolbar.querySelectorAll('.segmented[aria-label="Editing format"] button')) {
      buttonEl.setAttribute('aria-pressed', String(buttonEl.dataset.format === state.contentFormat));
    }
    updateStats();
    updatePreview();
  }

  function setFormat(format) {
    if (format === state.contentFormat) return;
    state.contentFormat = format;
    state.editVersion += 1;
    state.dirty = true;
    updateMetaRow();
    updateStats();
    setFormatUi();
    setSaveStatus('unsaved', settings.editor.autosave ? 'Unsaved changes · saving soon' : 'Unsaved changes');
    if (settings.editor.autosave) scheduleAutosave();
  }

  function buildToolbar() {
    toolbar.replaceChildren();
    const addButton = (iconName, label, onClick, { wide = null, requiresMarkdown = false, pressed = null } = {}) => {
      const btn = h('button', {
        type: 'button',
        class: `editor-toolbar__btn${wide ? ' editor-toolbar__btn--wide' : ''}`,
        'aria-label': label,
        title: label,
        dataset: { requiresMarkdown: String(requiresMarkdown), title: label },
      });
      btn.innerHTML = icon(iconName, { size: 15 });
      if (wide) btn.append(h('span', { text: wide }));
      if (pressed != null) btn.setAttribute('aria-pressed', String(pressed));
      btn.addEventListener('click', onClick);
      toolbar.append(btn);
      return btn;
    };
    const sep = () => toolbar.append(h('div', { class: 'toolbar-sep' }));
    addButton('undo', 'Undo (Ctrl+Z)', undo);
    addButton('redo', 'Redo (Ctrl+Y)', redo);
    sep();
    addButton('bold', 'Bold (Ctrl+B)', () => wrapSelection('**', '**', 'bold'), { requiresMarkdown: true });
    addButton('italic', 'Italic (Ctrl+I)', () => wrapSelection('*', '*', 'italic'), { requiresMarkdown: true });
    addButton('underline', 'Underline (Ctrl+U)', () => wrapSelection('<u>', '</u>', 'underlined'), { requiresMarkdown: true });
    addButton('heading1', 'Heading 1', () => prefixLines('# ', { removeHeadings: true }), { requiresMarkdown: true });
    addButton('heading2', 'Heading 2', () => prefixLines('## ', { removeHeadings: true }), { requiresMarkdown: true });
    addButton('list', 'Bulleted list', () => prefixLines('- '), { requiresMarkdown: true });
    addButton('listOrdered', 'Numbered list', () => prefixLines('1. '), { requiresMarkdown: true });
    addButton('quote', 'Quote', () => prefixLines('> '), { requiresMarkdown: true });
    sep();
    addButton('pauseCircle', 'Insert pause marker', () => insertText(' [[pause]] '), { wide: 'Pause' });
    addButton('closedCaption', 'Insert stage cue', () => insertCue(), { wide: 'Cue' });
    sep();
    addButton('search', 'Find (Ctrl+F)', () => toggleFind('find'));
    addButton('replace', 'Find and replace (Ctrl+H)', () => toggleFind('replace'));
    addButton('eye', 'Preview rendered script', () => togglePreview(), { pressed: state.previewOpen });
    sep();

    const formatControl = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Editing format', style: { marginLeft: 'auto' } });
    for (const option of [{ value: 'plain', label: 'Plain text' }, { value: 'markdown', label: 'Markdown' }]) {
      const btn = h('button', {
        type: 'button',
        text: option.label,
        'aria-pressed': String(state.contentFormat === option.value),
        dataset: { format: option.value },
        title: option.value === 'markdown' ? 'Markdown with safe preview and formatting' : 'Plain text: line breaks and pause/cue markers only',
      });
      btn.addEventListener('click', () => setFormat(option.value));
      formatControl.append(btn);
    }
    toolbar.append(formatControl);
    formatControlRef = formatControl;
    setFormatUi();
  }

  let formatControlRef = null;
  Object.defineProperty(buildToolbar, 'formatControl', { get: () => formatControlRef });

  // Build find bar controls before toolbar references them.
  const findInput = h('input', { class: 'input', type: 'search', placeholder: 'Find in script…', 'aria-label': 'Find text' });
  const replaceInput = h('input', { class: 'input', type: 'search', placeholder: 'Replace with…', 'aria-label': 'Replacement text' });
  const findCountLabel = h('span', { class: 'find-count', text: '0 matches' });
  const caseButton = button('Aa', { size: 'sm', variant: 'ghost', title: 'Match case' });
  caseButton.addEventListener('click', () => {
    state.caseSensitive = !state.caseSensitive;
    caseButton.setAttribute('aria-pressed', String(state.caseSensitive));
    caseButton.classList.toggle('btn--primary', state.caseSensitive);
    updateFindCount();
  });
  const prevMatch = iconButton('chevronUp', 'Previous match', { size: 'sm', onClick: () => navigateMatch(-1) });
  const nextMatch = iconButton('chevronDown', 'Next match', { size: 'sm', onClick: () => navigateMatch(1) });
  const replaceOne = button('Replace', { size: 'sm', onClick: () => replaceCurrent() });
  const replaceAll = button('Replace all', { size: 'sm', onClick: () => replaceEveryMatch() });
  const closeFind = iconButton('x', 'Close find bar', { size: 'sm', onClick: () => toggleFind(false) });
  const replaceWrap = h('div', { style: { display: 'flex', gap: '6px', flex: '1 1 240px' } }, replaceInput, replaceOne, replaceAll);
  findBar.append(findInput, caseButton, prevMatch, nextMatch, findCountLabel, replaceWrap, closeFind);
  findInput.addEventListener('input', () => {
    state.findIndex = 0;
    updateFindCount();
    selectCurrentMatch();
  });
  findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) navigateMatch(-1);
      else navigateMatch(1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      toggleFind(false);
    }
  });
  replaceInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      replaceCurrent();
    }
  });
  function replaceVisible() {
    replaceWrap.style.display = findBar.dataset.mode === 'replace' ? 'flex' : 'none';
  }
  new MutationObserver(replaceVisible).observe(findBar, { attributes: true, attributeFilter: ['data-mode'] });
  findBar.dataset.mode = 'find';

  function matchesForFind() {
    const query = findInput.value;
    if (!query) return [];
    const source = state.caseSensitive ? state.content : state.content.toLocaleLowerCase();
    const needle = state.caseSensitive ? query : query.toLocaleLowerCase();
    const results = [];
    let index = 0;
    while (index <= source.length) {
      const found = source.indexOf(needle, index);
      if (found === -1) break;
      results.push({ start: found, end: found + needle.length });
      index = found + Math.max(1, needle.length);
      if (results.length >= 5000) break;
    }
    return results;
  }

  let currentMatches = [];

  function updateFindCount() {
    currentMatches = matchesForFind();
    if (state.findIndex >= currentMatches.length) state.findIndex = Math.max(0, currentMatches.length - 1);
    findCountLabel.textContent = currentMatches.length
      ? `${state.findIndex + 1} of ${currentMatches.length}`
      : findInput.value
        ? 'No matches'
        : '0 matches';
  }

  function selectCurrentMatch() {
    updateFindCount();
    const match = currentMatches[state.findIndex];
    if (!match) return;
    textarea.focus();
    textarea.setSelectionRange(match.start, match.end);
    // Bring the selection into view in the textarea without disturbing scroll
    // for users who are reading.
    const before = state.content.slice(0, match.start);
    const lineCount = before.split('\n').length;
    textarea.scrollTop = Math.max(0, lineCount * parseFloat(getComputedStyle(textarea).lineHeight) - textarea.clientHeight / 2);
  }

  function navigateMatch(direction) {
    if (!currentMatches.length) updateFindCount();
    if (!currentMatches.length) return;
    state.findIndex = (state.findIndex + direction + currentMatches.length) % currentMatches.length;
    selectCurrentMatch();
  }

  function toggleFind(mode = 'find') {
    if (!mode) {
      findBar.dataset.open = 'false';
      state.findOpen = false;
      textarea.focus();
      return;
    }
    findBar.dataset.open = 'true';
    findBar.dataset.mode = mode;
    state.findOpen = true;
    findBar.querySelector('.find-bar .input')?.focus();
    if (mode === 'replace') replaceInput.focus();
    else findInput.focus();
    updateFindCount();
  }

  function replaceCurrent() {
    const match = currentMatches[state.findIndex];
    if (!match) {
      toast('No match to replace.', { type: 'info', duration: 1800 });
      return;
    }
    const next = `${state.content.slice(0, match.start)}${replaceInput.value}${state.content.slice(match.end)}`;
    applyContent(next, match.start + replaceInput.value.length);
    updateFindCount();
    selectCurrentMatch();
  }

  function replaceEveryMatch() {
    if (!currentMatches.length) {
      updateFindCount();
      if (!currentMatches.length) return;
    }
    const replacement = replaceInput.value;
    let next = '';
    let cursor = 0;
    for (const match of currentMatches) {
      next += state.content.slice(cursor, match.start) + replacement;
      cursor = match.end;
    }
    next += state.content.slice(cursor);
    const count = currentMatches.length;
    applyContent(next);
    updateFindCount();
    toast(`Replaced ${count.toLocaleString()} ${count === 1 ? 'match' : 'matches'}.`, { type: 'success', duration: 2500 });
  }

  function togglePreview(force = null) {
    state.previewOpen = force == null ? !state.previewOpen : Boolean(force);
    preview.hidden = !state.previewOpen;
    textarea.hidden = state.previewOpen;
    updatePreview();
    const button = toolbar.querySelector('[aria-label="Preview rendered script"]');
    button?.setAttribute('aria-pressed', String(state.previewOpen));
  }

  function updatePreview() {
    if (!state.previewOpen || state.destroyed) return;
    try {
      preview.innerHTML = renderScriptHtml(state.content, state.contentFormat);
    } catch {
      preview.textContent = state.content;
    }
  }

  /* ============================================================
     Wire up events
     ============================================================ */

  buildToolbar();
  const formatControl = buildToolbar.formatControl;

  titleInput.addEventListener('input', () => {
    state.title = titleInput.value;
    state.editVersion += 1;
    state.dirty = true;
    ctx.setTopbarTitle(state.title || 'Untitled script', 'Editor');
    updateStats();
    updateMetaRow();
    setSaveStatus('unsaved', settings.editor.autosave ? 'Unsaved changes · saving soon' : 'Unsaved changes');
    if (settings.editor.autosave) scheduleAutosave();
  });

  textarea.addEventListener('input', () => {
    pushHistory(state.lastContentValue);
    state.content = textarea.value;
    state.lastContentValue = state.content;
    state.dirty = true;
    state.editVersion += 1;
    updateStats();
    updateMetaRow();
    updatePreview();
    if (state.findOpen) updateFindCount();
    if (state.conflict) {
      setSaveStatus('conflict', 'Conflict — review');
      return;
    }
    setSaveStatus('unsaved', settings.editor.autosave ? 'Unsaved changes · saving soon' : 'Unsaved changes');
    if (settings.editor.autosave) scheduleAutosave();
  });
  textarea.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) {
      if (event.target === textarea) {
        event.preventDefault();
        undo();
      }
    } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
      if (event.target === textarea) {
        event.preventDefault();
        redo();
      }
    } else if (key === 'b' || key === 'i' || key === 'u') {
      if (state.contentFormat !== 'markdown') return;
      event.preventDefault();
      if (key === 'b') wrapSelection('**', '**', 'bold');
      if (key === 'i') wrapSelection('*', '*', 'italic');
      if (key === 'u') wrapSelection('<u>', '</u>', 'underlined');
    }
  });

  folderSelect.addEventListener('change', () => {
    state.folderId = folderSelect.value || null;
    markDirty();
  });

  const onDocumentKeydown = (event) => {
    if (event.defaultPrevented) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      manualSave();
    } else if (mod && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      toggleFind('find');
    } else if (mod && event.key.toLowerCase() === 'h') {
      event.preventDefault();
      toggleFind('replace');
    } else if (event.key === 'Escape' && state.findOpen) {
      event.preventDefault();
      toggleFind(false);
    }
  };
  document.addEventListener('keydown', onDocumentKeydown, true);

  const onBeforeUnload = (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  function openReader() {
    saveNow({ reason: 'manual' })
      .then((ok) => {
        if (!ok) {
          toast('Resolve the save conflict before opening the teleprompter, so you read the version you see.', { type: 'warning' });
          return;
        }
        ctx.navigate(`/read/${encodeURIComponent(scriptId)}`);
      })
      .catch(() => {});
  }

  function openMoreMenu(anchor) {
    openMenu(anchor, [
      { label: 'Save now', icon: 'save', shortcut: 'Ctrl S', onSelect: () => manualSave() },
      { label: 'Open teleprompter', icon: 'play', onSelect: () => openReader() },
      { label: 'Import into this script…', icon: 'upload', onSelect: () => openImportIntoCurrent() },
      { separator: true },
      ...SCRIPT_EXPORT_FORMATS.map((format) => ({
        label: `Export ${format.label.replace(/\s*\(.+\)$/, '')}`,
        icon: format.id === 'json' ? 'fileJson' : format.id === 'html' ? 'fileCode' : format.id === 'md' ? 'fileText' : 'download',
        onSelect: () => exportCurrent(format.id),
      })),
      { label: 'Print…', icon: 'printer', onSelect: () => printCurrent() },
      { label: 'Duplicate', icon: 'copy', onSelect: () => duplicateCurrent() },
      { separator: true },
      { label: 'Help & shortcuts', icon: 'help', onSelect: () => ctx.openHelp() },
      { label: 'Move to trash', icon: 'trash', danger: true, onSelect: () => moveToTrash() },
    ]);
  }

  function currentSnapshot() {
    return {
      ...state.base,
      id: scriptId,
      title: titleInput.value.trim() || 'Untitled script',
      content: textarea.value,
      contentFormat: state.contentFormat,
      folderId: state.folderId,
      tags: [...state.tags],
      isFavorite: state.isFavorite,
      wordCount: countWords(textarea.value),
    };
  }

  function exportCurrent(format) {
    try {
      const fileName = downloadScript(currentSnapshot(), format, { readerSettings: ctx.settingsStore.get().reader });
      toast(`Exported ${fileName}.`, { type: 'success' });
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The script could not be exported.'), { type: 'error' });
    }
  }

  function printCurrent() {
    try {
      printScript(currentSnapshot());
    } catch (error) {
      toast(friendlyErrorMessage(error, 'Printing is not available in this browser.'), { type: 'error' });
    }
  }

  async function duplicateCurrent() {
    const ok = await saveNow({ reason: 'manual' });
    if (!ok) {
      toast('Resolve the save conflict before duplicating, or use Save as copy from the conflict banner.', { type: 'warning' });
      return;
    }
    try {
      const copy = await duplicateScript(scriptId);
      toast(`Duplicated as “${copy.title}”.`, { type: 'success' });
      ctx.refreshSidebar();
      ctx.navigate(`/editor/${encodeURIComponent(copy.id)}`);
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The script could not be duplicated.'), { type: 'error' });
    }
  }

  function openImportIntoCurrent() {
    const target = { ...currentSnapshot() };
    ctx.openImport({
      currentScript: target,
      onAppliedToCurrent: (updated) => {
        applyExternalRecord(updated);
        state.lastRevisionAt = Date.now();
        refreshHistory();
        setSaveStatus('saved', 'Import saved');
        toast('Imported content was applied to this script.', { type: 'success' });
      },
      onImported: (records) => {
        if (records?.[0]) ctx.navigate(`/editor/${encodeURIComponent(records[0].id)}`);
      },
    });
  }

  async function moveToTrash() {
    if (ctx.settingsStore.get().general.confirmDelete) {
      const ok = await confirmDialog({
        title: 'Move this script to trash?',
        message: 'You can restore it from Trash. Any unsaved edits in the editor will be saved first.',
        confirmLabel: 'Move to trash',
        danger: true,
      });
      if (!ok) return;
    }
    const saved = await saveNow({ reason: 'trash' });
    if (!saved) {
      toast('The script has unsaved changes that could not be saved, so it was not moved to trash.', { type: 'error' });
      return;
    }
    try {
      await trashScript(scriptId);
      state.dirty = false;
      toast('Script moved to trash.', {
        type: 'success',
        actions: [
          {
            label: 'Undo',
            onClick: async () => {
              await restoreScript(scriptId);
              ctx.refreshSidebar();
              ctx.navigate(`/editor/${encodeURIComponent(scriptId)}`);
            },
          },
        ],
      });
      ctx.refreshSidebar();
      ctx.navigate('/library');
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The script could not be moved to trash.'), { type: 'error' });
    }
  }

  function askLeaveDialog({ conflict = false } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        modal.close();
        resolve(value);
      };
      const body = h('div', { class: 'stack', style: { gap: '10px' } });
      body.append(
        h('p', { class: 'muted', style: { margin: '0', lineHeight: '1.6', fontSize: '12.5px' }, text: conflict ? 'Another tab changed this script, and this tab still has unsaved edits. Choose deliberately how to leave.' : 'This tab has unsaved edits. Saving is the safest way to leave without losing content.' }),
      );
      body.append(
        h('div', { class: 'field-hint', text: 'Export draft downloads the current editor text so you can recover it elsewhere even if saving fails.' }),
      );
      const footer = h('div', { class: 'btn-row' });
      const stay = button('Stay here', { variant: 'ghost', onClick: () => finish(false) });
      const exportDraft = button('Export draft', {
        iconName: 'download',
        onClick: () => {
          downloadText(textarea.value, `${sanitizeFileName(titleInput.value || 'draft')}-draft.txt`);
        },
      });
      const discard = button('Discard edits & leave', {
        variant: 'danger',
        onClick: () => finish(true),
      });
      const primary = conflict
        ? button('Save a copy & leave', {
            iconName: 'copy',
            variant: 'primary',
            onClick: async () => {
              const copy = await saveDraftAsCopy();
              if (copy) finish(true);
            },
          })
        : button('Retry save', {
            iconName: 'save',
            variant: 'primary',
            onClick: async () => {
              const ok = await saveNow({ reason: 'leave' });
              if (ok) finish(true);
            },
          });
      footer.append(stay, exportDraft, discard, primary);
      const modal = openModal({
        title: conflict ? 'Unsaved edits and a conflict' : 'Unsaved changes',
        description: `“${titleInput.value || 'Untitled script'}” has changes that are not saved.`,
        icon: 'warning',
        iconTone: 'warning',
        body,
        footer,
        closeOnBackdrop: false,
        onClose: () => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        },
      });
    });
  }

  async function leaveGuard() {
    if (state.savingPromise) {
      try {
        await state.savingPromise;
      } catch {
        // The status and dialog below handle the failure.
      }
    }
    if (!state.dirty) return true;
    if (state.conflict) return askLeaveDialog({ conflict: true });
    const ok = await saveNow({ reason: 'leave' });
    if (ok && !state.dirty) return true;
    return askLeaveDialog({ conflict: Boolean(state.conflict) });
  }

  function deletedHandler() {
    // Existing listener is removed in cleanup; the handler is kept for
    // symmetry with the view lifecycle.
  }

  /* Async setup */
  fetchFolders();
  renderTags();
  syncFavoriteUi();
  updateStats();
  updateMetaRow();
  setFormatUi();
  updateStatusFromBase();
  setSaveStatus('saved', 'Saved');
  refreshHistory();
  bottomNote.textContent = `Last saved ${formatRelative(script.updatedAt)} · Autosave ${settings.editor.autosave ? 'on' : 'off'} · Local database`;
  ctx.setTopbarTitle(script.title, 'Editor');

  function updateStatusFromBase() {
    setSaveStatus('saved', state.base.updatedAt ? `Saved ${formatTimeOfDay(state.base.updatedAt)}` : 'Saved');
  }

  if ('BroadcastChannel' in globalThis) {
    try {
      channel = new BroadcastChannel('atp-script-events');
      channel.addEventListener('message', async (event) => {
        if (event.data?.type !== 'script-updated' || event.data.scriptId !== scriptId || event.data.senderId === tabId) return;
        if (state.destroyed) return;
        if (event.data.updatedAt === state.base.updatedAt) return;
        try {
          const fresh = await getScript(scriptId);
          if (!fresh || fresh.updatedAt === state.base.updatedAt) return;
          state.conflict = { latest: fresh };
          state.dirty = state.dirty || fresh.contentHash !== state.base.contentHash;
          setSaveStatus('conflict', 'Updated in another tab');
          showConflictBanner();
          if (!state.dirty) {
            toast('This script changed in another tab. Review the conflict banner; your open copy is unchanged.', {
              type: 'warning',
              title: 'External change detected',
              duration: 9000,
              actions: [{ label: 'Review', onClick: () => showConflictBanner() }],
            });
          }
        } catch {
          // A transient read failure should not block editing.
        }
      });
    } catch {
      channel = null;
    }
  }

  return {
    element,
    pageTitle: script.title,
    guard: leaveGuard,
    cleanup: () => {
      state.destroyed = true;
      clearTimeout(state.saveTimer);
      clearTimeout(searchDebounce);
      document.removeEventListener('keydown', onDocumentKeydown, true);
      window.removeEventListener('beforeunload', onBeforeUnload);
      channel?.close();
      channel = null;
      if (state.dirty) {
        // Best-effort last save. The navigation guard normally saves first.
        saveNow({ reason: 'view-cleanup' }).catch(() => {});
      }
    },
  };
}

function deletedScriptView(ctx, script) {
  const wrap = h('div', { class: 'stack' });
  const head = h('div', { class: 'page-head' });
  const text = h('div');
  text.append(h('h1', { text: 'Script in trash' }), h('p', { text: `“${script.title}” was moved to trash ${formatRelative(script.deletedAt)}. Restore it to edit or read.` }));
  const actions = h('div', { class: 'page-actions' });
  actions.append(
    button('Back to library', { iconName: 'arrowLeft', onClick: () => ctx.navigate('/library') }),
    button('Open trash', { iconName: 'trash', onClick: () => ctx.navigate('/trash') }),
  );
  head.append(text, actions);
  const empty = emptyState({
    iconName: 'trash',
    title: 'This script is in the trash',
    description: 'Deleted scripts are kept until trash is emptied. Restore this one to continue where you left off, or delete it permanently from the trash screen.',
    actions: [
      {
        label: 'Restore script',
        icon: 'restart',
        primary: true,
        onClick: async () => {
          try {
            await restoreScript(script.id);
            toast('Script restored.', { type: 'success' });
            ctx.refreshSidebar();
            ctx.navigate(`/editor/${encodeURIComponent(script.id)}`);
          } catch (error) {
            toast(friendlyErrorMessage(error, 'The script could not be restored.'), { type: 'error' });
          }
        },
      },
    ],
  });
  wrap.append(head, empty);
  return { element: wrap, pageTitle: 'Script in trash' };
}
