import {
  bulkUpdateScripts,
  deleteFolder,
  deleteScriptPermanently,
  duplicateScript,
  emptyTrash,
  getAllFolders,
  getAllScripts,
  getScript,
  restoreScript,
  saveFolder,
  trashScript,
} from '../database.js';
import {
  badge,
  button,
  confirmDialog,
  emptyState,
  h,
  iconButton,
  iconSpan,
  openMenu,
  openModal,
  promptDialog,
  toast,
} from '../ui.js';
import { icon } from '../icons.js';
import {
  formatDuration,
  formatRelative,
  friendlyErrorMessage,
  pluralize,
  truncate,
  formatDate,
} from '../utils.js';
import { createFolderRecord, normalizeTags, normalizeTitle, prepareScriptRecord, normalizeFolderName } from '../script-validation.js';
import { downloadScript, printScript } from '../file-exporter.js';
import { contentPreviewText } from '../render-content.js';

const PAGE_SIZE = 25;
const SORTS = [
  { value: 'updated-desc', label: 'Recently updated' },
  { value: 'opened-desc', label: 'Recently opened' },
  { value: 'created-desc', label: 'Newest first' },
  { value: 'title-asc', label: 'Title A → Z' },
  { value: 'words-desc', label: 'Longest first' },
  { value: 'deleted-desc', label: 'Recently deleted' },
];

function sortScripts(scripts, sort) {
  const list = [...scripts];
  switch (sort) {
    case 'title-asc':
      return list.sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base', numeric: true }));
    case 'created-desc':
      return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    case 'opened-desc':
      return list.sort((a, b) => new Date(b.lastOpenedAt || b.updatedAt).getTime() - new Date(a.lastOpenedAt || a.updatedAt).getTime());
    case 'words-desc':
      return list.sort((a, b) => (b.wordCount || 0) - (a.wordCount || 0));
    case 'deleted-desc':
      return list.sort((a, b) => new Date(b.deletedAt || 0).getTime() - new Date(a.deletedAt || 0).getTime());
    case 'updated-desc':
    default:
      return list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }
}

function matchesQuery(script, query) {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = [script.title, script.content, (script.tags || []).join(' '), script.sourceFileName || '']
    .join('\n')
    .toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function folderNameFor(foldersById, folderId) {
  if (!folderId) return 'Unfiled';
  return foldersById.get(folderId)?.name || 'Unfiled';
}

function estimateRead(script) {
  const words = script.wordCount || 0;
  return formatDuration((words / 140) * 60);
}

export async function libraryView(ctx, routeContext, { mode = 'library' } = {}) {
  const isTrash = mode === 'trash';
  const isFavorites = mode === 'favorites';
  const query = routeContext.query || {};
  const state = {
    q: query.q || '',
    folder: query.folder || '',
    tag: query.tag || '',
    sort: query.sort || (isTrash ? 'deleted-desc' : 'updated-desc'),
    recent: query.recent === '1',
    page: Math.max(1, Number(query.page) || 1),
    selected: new Set(),
    scripts: [],
    folders: [],
    ready: false,
    error: null,
  };
  const foldersById = new Map();
  let filtered = [];
  let searchInput = null;
  let searchTimer = null;

  const element = h('div', { class: 'stack' });
  const header = h('div', { class: 'page-head' });
  const headerText = h('div');
  const heading = h('h1', {
    text: isTrash ? 'Trash' : isFavorites ? 'Favorites' : 'Script library',
  });
  const sub = h('p', {
    text: isTrash
      ? 'Deleted scripts stay here until you restore them or remove them permanently.'
      : isFavorites
        ? 'Scripts you starred for fast access before a shoot or presentation.'
        : 'Every script on this device. Search, organize, rehearse, and export without an account.',
  });
  headerText.append(heading, sub);
  const headerActions = h('div', { class: 'page-actions' });
  if (isTrash) {
    headerActions.append(
      button('Empty trash', { iconName: 'trash', variant: 'danger', onClick: () => handleEmptyTrash() }),
      button('Back to library', { iconName: 'arrowLeft', onClick: () => ctx.navigate('/library') }),
    );
  } else {
    headerActions.append(
      button('Manage folders', { iconName: 'folder', onClick: () => openFolderManager() }),
      button('Import', { iconName: 'upload', onClick: () => ctx.openImport() }),
      button('New script', { iconName: 'plus', variant: 'primary', onClick: () => ctx.createScript() }),
    );
  }
  header.append(headerText, headerActions);
  element.append(header);

  const loading = h('div', { class: 'loading-block' }, h('span', { class: 'spinner' }), h('span', { text: 'Reading your library…' }));
  element.append(loading);

  const layout = h('div', { class: 'library-layout', hidden: true });
  const folderPanel = h('aside', { class: 'folder-panel', 'aria-label': 'Folders' });
  const main = h('div', { style: { minWidth: '0' } });
  layout.append(folderPanel, main);
  element.append(layout);

  const toolbar = h('div', { class: 'library-toolbar' });
  const searchWrap = h('div', { class: 'library-toolbar__search' });
  searchWrap.append(iconSpan('search', { size: 15 }));
  searchInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search titles, content, tags…',
    'aria-label': 'Search scripts',
    value: state.q,
    autocomplete: 'off',
  });
  searchInput.addEventListener('input', () => {
    state.q = searchInput.value;
    state.page = 1;
    state.selected.clear();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => updateResults(), 180);
  });
  searchWrap.append(searchInput);

  const sortSelect = h('select', { class: 'select', 'aria-label': 'Sort scripts', style: { width: 'auto', minWidth: '170px' } });
  for (const sortOption of SORTS.filter((item) => (isTrash ? true : item.value !== 'deleted-desc'))) {
    const optionEl = h('option', { value: sortOption.value, text: sortOption.label });
    if (sortOption.value === state.sort) optionEl.selected = true;
    sortSelect.append(optionEl);
  }
  sortSelect.addEventListener('change', () => {
    state.sort = sortSelect.value;
    state.page = 1;
    updateResults();
  });
  toolbar.append(searchWrap, sortSelect);

  const filterRow = h('div', { class: 'filter-row' });
  main.append(toolbar, filterRow);

  const bulkBar = h('div', { class: 'bulk-bar', hidden: true });
  main.append(bulkBar);

  const results = h('div');
  main.append(results);

  const pagination = h('div', { class: 'pagination' });
  main.append(pagination);

  folderPanel.append(h('div', { class: 'folder-panel__title', text: 'Folders' }));

  loadData();

  async function loadData({ preserveSelection = true } = {}) {
    try {
      const [allScripts, folders] = await Promise.all([getAllScripts({ includeDeleted: true }), getAllFolders()]);
      state.folders = folders;
      state.scripts = isTrash ? allScripts.filter((script) => script.deletedAt) : allScripts.filter((script) => !script.deletedAt);
      foldersById.clear();
      for (const folder of folders) foldersById.set(folder.id, folder);
      if (!preserveSelection) state.selected.clear();
      else {
        const ids = new Set(state.scripts.map((script) => script.id));
        for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
      }
      state.ready = true;
      state.error = null;
    } catch (error) {
      state.error = error;
      state.ready = true;
    }
    loading?.remove();
    layout.hidden = false;
    renderFolderPanel();
    renderFilters();
    updateResults();
  }

  function renderFolderPanel() {
    folderPanel.replaceChildren();
    folderPanel.append(h('div', { class: 'folder-panel__title', text: 'Folders' }));
    const activeScripts = state.scripts.filter((script) => !script.deletedAt);
    const allButton = h('button', {
      type: 'button',
      class: 'folder-link',
      'aria-current': !state.folder ? 'true' : null,
    });
    allButton.append(iconSpan('library', { size: 14 }), h('span', { text: isTrash ? 'All deleted' : 'All scripts' }), h('span', { class: 'folder-link__count', text: String(state.scripts.length) }));
    allButton.addEventListener('click', () => {
      state.folder = '';
      state.page = 1;
      updateResults();
      renderFolderPanel();
      updateRouteQuery();
    });
    folderPanel.append(allButton);

    if (!isTrash) {
      const unfiled = activeScripts.filter((script) => !script.folderId).length;
      const unfiledButton = h('button', {
        type: 'button',
        class: 'folder-link',
        'aria-current': state.folder === '__unfiled' ? 'true' : null,
      });
      unfiledButton.append(iconSpan('folderOpen', { size: 14 }), h('span', { text: 'Unfiled' }), h('span', { class: 'folder-link__count', text: String(unfiled) }));
      unfiledButton.addEventListener('click', () => {
        state.folder = '__unfiled';
        state.page = 1;
        updateResults();
        renderFolderPanel();
        updateRouteQuery();
      });
      folderPanel.append(unfiledButton);
    }

    for (const folder of state.folders) {
      const count = isTrash
        ? state.scripts.filter((script) => script.folderId === folder.id).length
        : activeScripts.filter((script) => script.folderId === folder.id).length;
      const row = h('div', { style: { display: 'flex', alignItems: 'center' } });
      const link = h('button', {
        type: 'button',
        class: 'folder-link',
        'aria-current': state.folder === folder.id ? 'true' : null,
        style: { flex: '1' },
      });
      link.append(iconSpan('folder', { size: 14 }), h('span', { class: 'truncate', text: folder.name }), h('span', { class: 'folder-link__count', text: String(count) }));
      link.addEventListener('click', () => {
        state.folder = folder.id;
        state.page = 1;
        updateResults();
        renderFolderPanel();
        updateRouteQuery();
      });
      const actions = h('div', { class: 'folder-link__actions' });
      actions.append(
        iconButton('pencil', `Rename ${folder.name}`, { size: 'sm', onClick: () => renameFolder(folder) }),
        iconButton('trash', `Delete ${folder.name}`, { size: 'sm', onClick: () => removeFolder(folder) }),
      );
      row.append(link, actions);
      folderPanel.append(row);
    }

    const add = button('New folder', { iconName: 'folderPlus', size: 'sm', className: 'mt-1' });
    add.style.marginTop = '4px';
    add.addEventListener('click', () => createFolder());
    folderPanel.append(add);
  }

  function renderFilters() {
    filterRow.replaceChildren();
    if (isTrash) return;

    const allTags = new Map();
    for (const script of state.scripts) {
      for (const tag of script.tags || []) {
        allTags.set(tag.toLocaleLowerCase(), (allTags.get(tag.toLocaleLowerCase()) || 0) + 1);
      }
    }
    const tagEntries = [...allTags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

    if (!isFavorites) {
      const favChip = h('button', {
        type: 'button',
        class: `chip chip--button${state.tag === '__favorites' ? ' chip--active' : ''}`,
        'aria-pressed': String(state.tag === '__favorites'),
      });
      favChip.append(iconSpan('star', { size: 13 }), h('span', { text: 'Favorites' }));
      favChip.addEventListener('click', () => {
        state.tag = state.tag === '__favorites' ? '' : '__favorites';
        state.page = 1;
        renderFilters();
        updateResults();
      });
      filterRow.append(favChip);
    }

    const recentChip = h('button', {
      type: 'button',
      class: `chip chip--button${state.recent ? ' chip--active' : ''}`,
      'aria-pressed': String(state.recent),
    });
    recentChip.append(iconSpan('clock', { size: 13 }), h('span', { text: 'Recent' }));
    recentChip.addEventListener('click', () => {
      state.recent = !state.recent;
      state.page = 1;
      renderFilters();
      updateResults();
    });
    filterRow.append(recentChip);

    for (const [tag, count] of tagEntries) {
      const chip = h('button', {
        type: 'button',
        class: `chip chip--button${state.tag === tag ? ' chip--active' : ''}`,
        'aria-pressed': String(state.tag === tag),
        text: `#${tag}${count > 1 ? ` ${count}` : ''}`,
      });
      chip.addEventListener('click', () => {
        state.tag = state.tag === tag ? '' : tag;
        state.page = 1;
        renderFilters();
        updateResults();
      });
      filterRow.append(chip);
    }

    if (state.folder || state.tag || state.q || state.recent) {
      const clear = button('Clear filters', { variant: 'ghost', size: 'sm', iconName: 'x' });
      clear.addEventListener('click', () => {
        state.folder = '';
        state.tag = '';
        state.q = '';
        state.recent = false;
        state.page = 1;
        if (searchInput) searchInput.value = '';
        renderFolderPanel();
        renderFilters();
        updateResults();
        updateRouteQuery();
      });
      filterRow.append(clear);
    }
  }

  function computeFiltered() {
    let list = [...state.scripts];
    if (isFavorites) list = list.filter((script) => script.isFavorite);
    if (!isTrash) {
      if (state.tag === '__favorites') list = list.filter((script) => script.isFavorite);
      else if (state.tag) list = list.filter((script) => (script.tags || []).some((tag) => tag.toLocaleLowerCase() === state.tag));
    }
    if (state.folder === '__unfiled') list = list.filter((script) => !script.folderId);
    else if (state.folder) list = list.filter((script) => script.folderId === state.folder);
    if (state.recent) {
      const cutoff = Date.now() - 7 * 86400000;
      list = list.filter((script) => new Date(script.lastOpenedAt || script.updatedAt).getTime() >= cutoff);
    }
    if (state.q.trim()) list = list.filter((script) => matchesQuery(script, state.q.trim()));
    return sortScripts(list, state.sort);
  }

  function updateResults() {
    if (!state.ready) return;
    if (state.error) {
      results.replaceChildren(
        emptyState({
          iconName: 'warning',
          title: 'The library could not be read',
          description: friendlyErrorMessage(state.error),
          actions: [{ label: 'Try again', icon: 'refresh', primary: true, onClick: () => loadData() }],
        }),
      );
      pagination.replaceChildren();
      return;
    }
    filtered = computeFiltered();
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (state.page > totalPages) state.page = totalPages;
    const start = (state.page - 1) * PAGE_SIZE;
    const pageItems = filtered.slice(start, start + PAGE_SIZE);

    renderBulkBar();

    if (!filtered.length) {
      results.replaceChildren(emptyResults());
      pagination.replaceChildren();
      return;
    }

    const table = h('div', { class: 'script-table', role: 'table', 'aria-label': isTrash ? 'Deleted scripts' : 'Scripts' });
    const head = h('div', { class: 'script-table__head', role: 'row' });
    const selectAllWrap = h('div', { style: { display: 'flex', alignItems: 'center' } });
    const selectAll = h('input', {
      type: 'checkbox',
      class: 'script-row__check',
      'aria-label': 'Select all scripts on this page',
      title: 'Select all on this page',
    });
    selectAll.checked = pageItems.every((script) => state.selected.has(script.id));
    selectAll.indeterminate = !selectAll.checked && pageItems.some((script) => state.selected.has(script.id));
    selectAll.addEventListener('change', () => {
      for (const script of pageItems) {
        if (selectAll.checked) state.selected.add(script.id);
        else state.selected.delete(script.id);
      }
      updateResults();
    });
    selectAllWrap.append(selectAll);
    head.append(
      selectAllWrap,
      h('div', { role: 'columnheader', text: 'Title' }),
      h('div', { role: 'columnheader', text: 'Words / length' }),
      h('div', { role: 'columnheader', text: 'Folder' }),
      h('div', { role: 'columnheader', text: isTrash ? 'Deleted' : 'Updated' }),
      h('div', { role: 'columnheader', text: '' }),
    );
    table.append(head);

    for (const script of pageItems) {
      table.append(buildRow(script));
    }
    results.replaceChildren(table);

    pagination.replaceChildren();
    const range = h('span', { text: `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length.toLocaleString()}` });
    const buttons = h('div', { class: 'pagination__buttons' });
    const prev = button('Previous', { iconName: 'chevronLeft', size: 'sm', disabled: state.page <= 1 });
    prev.addEventListener('click', () => {
      state.page -= 1;
      updateResults();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    const next = button('Next', { iconName: 'chevronRight', size: 'sm', disabled: state.page >= totalPages });
    next.addEventListener('click', () => {
      state.page += 1;
      updateResults();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    buttons.append(prev, next);
    pagination.append(range, buttons);
  }

  function emptyResults() {
    if (isTrash && !state.scripts.length) {
      return emptyState({
        iconName: 'trash',
        title: 'Trash is empty',
        description: 'Deleted scripts appear here so an accidental deletion is recoverable. Emptying trash removes them permanently.',
        actions: [{ label: 'Back to library', icon: 'arrowLeft', onClick: () => ctx.navigate('/library') }],
      });
    }
    if (isFavorites && !state.scripts.length) {
      return emptyState({
        iconName: 'star',
        title: 'No favorites yet',
        description: 'Star a script in the library or editor to pin it here for fast access before a session.',
        actions: [{ label: 'Browse library', icon: 'library', primary: true, onClick: () => ctx.navigate('/library') }],
      });
    }
    const hasFilters = Boolean(state.q || state.tag || state.folder || state.recent);
    return emptyState({
      iconName: hasFilters ? 'search' : 'fileText',
      title: hasFilters ? 'No scripts match these filters' : 'Your library is empty',
      description: hasFilters
        ? 'Try a shorter search, a different folder, or clear the active filters. Search looks at titles, content, and tags.'
        : 'Create a blank script or import an existing document. Imports are previewed before anything is saved.',
      actions: hasFilters
        ? [
            {
              label: 'Clear filters',
              icon: 'x',
              primary: true,
              onClick: () => {
                state.q = '';
                state.tag = '';
                state.folder = '';
                state.recent = false;
                state.page = 1;
                if (searchInput) searchInput.value = '';
                renderFolderPanel();
                renderFilters();
                updateResults();
              },
            },
          ]
        : [
            { label: 'New script', icon: 'plus', primary: true, onClick: () => ctx.createScript() },
            { label: 'Import document', icon: 'upload', onClick: () => ctx.openImport() },
          ],
    });
  }

  function buildRow(script) {
    const row = h('div', {
      class: 'script-row',
      role: 'row',
      dataset: { selected: String(state.selected.has(script.id)) },
    });

    const check = h('input', {
      type: 'checkbox',
      class: 'script-row__check',
      'aria-label': `Select ${script.title}`,
    });
    check.checked = state.selected.has(script.id);
    check.addEventListener('change', () => {
      if (check.checked) state.selected.add(script.id);
      else state.selected.delete(script.id);
      row.dataset.selected = String(check.checked);
      renderBulkBar();
      const selectAll = results.querySelector('.script-table__head input');
      if (selectAll) {
        const pageItems = filtered.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
        selectAll.checked = pageItems.length > 0 && pageItems.every((item) => state.selected.has(item.id));
        selectAll.indeterminate = !selectAll.checked && pageItems.some((item) => state.selected.has(item.id));
      }
    });
    const checkWrap = h('div', { style: { display: 'flex', alignItems: 'center' } }, check);

    const mainCell = h('div', { class: 'script-row__main', role: 'cell' });
    const titleLine = h('div', { style: { display: 'flex', alignItems: 'center', gap: '4px', minWidth: '0' } });
    if (!isTrash) {
      const titleLink = h('a', { class: 'script-row__title', href: `#/editor/${encodeURIComponent(script.id)}` });
      titleLink.append(h('span', { text: script.title }));
      titleLine.append(titleLink);
    } else {
      titleLine.append(h('span', { class: 'script-row__title' }, h('span', { text: script.title })));
    }
    const favButton = h('button', {
      type: 'button',
      class: 'btn btn--icon btn--sm btn--ghost',
      'aria-label': script.isFavorite ? `Remove ${script.title} from favorites` : `Add ${script.title} to favorites`,
      title: script.isFavorite ? 'Remove from favorites' : 'Add to favorites',
      style: { width: '22px', minHeight: '22px', padding: '0' },
    });
    favButton.innerHTML = icon('star', { size: 13, className: script.isFavorite ? 'favorite-star' : 'favorite-star favorite-star--off' });
    favButton.addEventListener('click', () => toggleFavorite(script));
    titleLine.append(favButton);
    mainCell.append(titleLine);

    const meta = h('div', { class: 'script-row__meta' });
    meta.append(h('span', { text: script.contentFormat === 'markdown' ? 'Markdown' : 'Plain text' }));
    if (script.folderId) {
      meta.append(h('span', { class: 'dot' }), h('span', { text: folderNameFor(foldersById, script.folderId) }));
    }
    if (script.tags?.length) {
      meta.append(h('span', { class: 'dot' }));
      const tagWrap = h('span', { class: 'script-row__tags' });
      for (const tag of script.tags.slice(0, 3)) tagWrap.append(h('span', { class: 'badge badge--violet', text: `#${tag}` }));
      if (script.tags.length > 3) tagWrap.append(h('span', { class: 'faint', text: `+${script.tags.length - 3}` }));
      meta.append(tagWrap);
    }
    if (isTrash) {
      meta.append(h('span', { class: 'dot' }), h('span', { class: 'text-warning', text: `Deleted ${formatRelative(script.deletedAt)}` }));
    }
    const preview = contentPreviewText(script.content, script.contentFormat, 110);
    if (preview) meta.append(h('span', { class: 'dot' }), h('span', { class: 'truncate', style: { maxWidth: '300px' }, text: preview }));
    mainCell.append(meta);

    const stat = h('div', { class: 'script-row__stat', role: 'cell' });
    stat.append(h('div', { text: `${(script.wordCount || 0).toLocaleString()} words` }), h('div', { class: 'faint', text: `≈ ${estimateRead(script)}` }));

    const folderCell = h('div', { class: 'script-row__stat', role: 'cell' });
    folderCell.append(h('div', { class: 'truncate', style: { maxWidth: '100px' }, text: folderNameFor(foldersById, script.folderId) }));

    const dateCell = h('div', { class: 'script-row__date', role: 'cell' });
    if (isTrash) {
      dateCell.textContent = formatDate(script.deletedAt, { dateStyle: 'medium' });
    } else {
      dateCell.textContent = formatRelative(script.updatedAt);
      dateCell.title = formatDate(script.updatedAt, { dateStyle: 'medium', timeStyle: 'short' });
    }

    const actionsCell = h('div', { class: 'script-row__actions', role: 'cell' });
    if (isTrash) {
      const restore = iconButton('restart', 'Restore script', { size: 'sm', onClick: () => handleRestore(script) });
      const remove = iconButton('trash', 'Delete permanently', { size: 'sm', onClick: () => handlePermanentDelete([script.id]) });
      actionsCell.append(restore, remove);
    } else {
      const read = iconButton('play', 'Read script', { size: 'sm', className: 'script-row__action-read', onClick: () => ctx.navigate(`/read/${encodeURIComponent(script.id)}`) });
      const menu = iconButton('more', 'More actions', { size: 'sm', className: 'script-row__menu-btn', onClick: () => openScriptMenu(script, menu) });
      actionsCell.append(read, menu);
    }

    row.append(checkWrap, mainCell, stat, folderCell, dateCell, actionsCell);
    return row;
  }

  function renderBulkBar() {
    bulkBar.replaceChildren();
    if (!state.selected.size) {
      bulkBar.hidden = true;
      return;
    }
    bulkBar.hidden = false;
    bulkBar.append(iconSpan('check', { size: 14 }), h('strong', { text: pluralize(state.selected.size, 'script') }), h('span', { class: 'faint', text: 'selected' }));
    const actions = h('div', { class: 'btn-row', style: { marginLeft: 'auto' } });
    const add = (label, opts) => actions.append(button(label, { ...opts, size: 'sm' }));
    if (isTrash) {
      add('Restore', { iconName: 'restart', onClick: () => bulkRestore() });
      add('Delete permanently', { iconName: 'trash', variant: 'danger', onClick: () => handlePermanentDelete([...state.selected]) });
    } else {
      add('Favorite', { iconName: 'star', onClick: () => bulkPatch((script) => ({ ...script, isFavorite: true }), 'favorites') });
      add('Move', { iconName: 'moveFolder', onClick: () => openMoveDialog([...state.selected]) });
      add('Add tag', { iconName: 'tag', onClick: () => bulkAddTag() });
      add('Duplicate', { iconName: 'copy', onClick: () => bulkDuplicate() });
      add('Move to trash', { iconName: 'trash', variant: 'danger', onClick: () => bulkTrash() });
    }
    const clear = iconButton('x', 'Clear selection', {
      size: 'sm',
      onClick: () => {
        state.selected.clear();
        updateResults();
      },
    });
    actions.append(clear);
    bulkBar.append(actions);
  }

  async function refreshAfterChange({ keepPage = true } = {}) {
    await loadData();
    if (!keepPage) state.page = 1;
    ctx.refreshSidebar();
  }

  async function toggleFavorite(script) {
    try {
      await bulkUpdateScripts([script.id], (record) => ({
        ...record,
        isFavorite: !record.isFavorite,
        updatedAt: new Date().toISOString(),
      }));
      await refreshAfterChange();
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The favorite could not be changed.'), { type: 'error' });
    }
  }

  async function bulkPatch(patchFn, label) {
    if (!state.selected.size) return;
    try {
      await bulkUpdateScripts([...state.selected], patchFn);
      toast(`${pluralize(state.selected.size, 'script')} updated (${label}).`, { type: 'success' });
      state.selected.clear();
      await refreshAfterChange();
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The scripts could not be updated.'), { type: 'error' });
    }
  }

  async function bulkDuplicate() {
    const ids = [...state.selected];
    if (!ids.length) return;
    try {
      let failed = 0;
      for (const id of ids) {
        try {
          await duplicateScript(id);
        } catch {
          failed += 1;
        }
      }
      toast(`Duplicated ${pluralize(ids.length - failed, 'script')}${failed ? `; ${failed} failed` : ''}.`, { type: failed ? 'warning' : 'success' });
      state.selected.clear();
      await refreshAfterChange();
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The scripts could not be duplicated.'), { type: 'error' });
    }
  }

  async function bulkTrash() {
    const ids = [...state.selected];
    if (!ids.length) return;
    if (ctx.settingsStore.get().general.confirmDelete) {
      const ok = await confirmDialog({
        title: `Move ${pluralize(ids.length, 'script')} to trash?`,
        message: 'You can restore them from Trash. Nothing is deleted permanently until you empty the trash.',
        confirmLabel: 'Move to trash',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await bulkUpdateScripts(ids, (script) => {
        const now = new Date().toISOString();
        return { ...script, deletedAt: now, updatedAt: now };
      });
      toast(`Moved ${pluralize(ids.length, 'script')} to trash.`, {
        type: 'success',
        actions: [{ label: 'Undo', onClick: () => handleRestoreIds(ids) }],
      });
      state.selected.clear();
      await refreshAfterChange();
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The scripts could not be moved to trash.'), { type: 'error' });
    }
  }

  async function handleTrashOne(script) {
    if (ctx.settingsStore.get().general.confirmDelete) {
      const ok = await confirmDialog({
        title: `Move “${truncate(script.title, 60)}” to trash?`,
        message: 'The script can be restored from Trash.',
        confirmLabel: 'Move to trash',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await trashScript(script.id);
      toast('Script moved to trash.', {
        type: 'success',
        actions: [{ label: 'Undo', onClick: () => handleRestoreIds([script.id]) }],
      });
      await refreshAfterChange();
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The script could not be moved to trash.'), { type: 'error' });
    }
  }

  async function handleRestore(script) {
    return handleRestoreIds([script.id]);
  }

  async function handleRestoreIds(ids) {
    let restored = 0;
    for (const id of ids) {
      try {
        await restoreScript(id);
        restored += 1;
      } catch {
        // Continue restoring the rest.
      }
    }
    toast(`Restored ${pluralize(restored, 'script')}${restored < ids.length ? ` (${ids.length - restored} failed)` : ''}.`, {
      type: restored ? 'success' : 'error',
    });
    await refreshAfterChange();
  }

  async function bulkRestore() {
    return handleRestoreIds([...state.selected]);
  }

  async function handlePermanentDelete(ids) {
    if (!ids.length) return;
    const ok = await confirmDialog({
      title: `Permanently delete ${pluralize(ids.length, 'script')}?`,
      message: 'This cannot be undone. Revisions for these scripts are deleted too.',
      confirmLabel: 'Delete permanently',
      danger: true,
      details: ['Download a backup first if you might need this content.', 'Export an individual script before deleting if you only need one copy.'],
    });
    if (!ok) return;
    try {
      for (const id of ids) await deleteScriptPermanently(id);
      toast(`Permanently deleted ${pluralize(ids.length, 'script')}.`, { type: 'success' });
      state.selected.clear();
      await refreshAfterChange();
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The scripts could not be deleted.'), { type: 'error' });
    }
  }

  async function handleEmptyTrash() {
    const count = state.scripts.length;
    if (!count) {
      toast('Trash is already empty.', { type: 'info' });
      return;
    }
    const ok = await confirmDialog({
      title: `Empty trash (${pluralize(count, 'script')})?`,
      message: 'Every script in Trash, and its revision history, will be deleted permanently.',
      confirmLabel: 'Empty trash',
      danger: true,
      details: ['This cannot be undone.', 'Consider downloading a backup first.'],
    });
    if (!ok) return;
    try {
      await emptyTrash();
      toast('Trash emptied.', { type: 'success' });
      state.selected.clear();
      await refreshAfterChange();
    } catch (error) {
      toast(friendlyErrorMessage(error, 'Trash could not be emptied.'), { type: 'error' });
    }
  }

  async function bulkAddTag() {
    const value = await promptDialog({
      title: 'Add tag to selected scripts',
      label: 'Tag',
      placeholder: 'e.g. keynote',
      help: 'The tag is added to every selected script. Existing tags are kept.',
      confirmLabel: 'Add tag',
      iconName: 'tag',
      maxLength: 40,
    });
    if (!value) return;
    const [tag] = normalizeTags([value]);
    if (!tag) {
      toast('Enter a valid tag.', { type: 'warning' });
      return;
    }
    await bulkPatch((script) => ({
      ...script,
      tags: normalizeTags([...(script.tags || []), tag]),
      updatedAt: new Date().toISOString(),
    }), `tag #${tag}`);
  }

  function openScriptMenu(script, anchor) {
    const items = [
      { label: 'Open in editor', icon: 'pencil', onSelect: () => ctx.navigate(`/editor/${encodeURIComponent(script.id)}`) },
      { label: 'Read now', icon: 'play', onSelect: () => ctx.navigate(`/read/${encodeURIComponent(script.id)}`) },
      { label: script.isFavorite ? 'Remove favorite' : 'Add to favorites', icon: 'star', onSelect: () => toggleFavorite(script) },
      { label: 'Rename…', icon: 'type', onSelect: () => renameScript(script) },
      { label: 'Move to folder…', icon: 'moveFolder', onSelect: () => openMoveDialog([script.id]) },
      { label: 'Manage tags…', icon: 'tag', onSelect: () => openTagsDialog(script) },
      { label: 'Duplicate', icon: 'copy', onSelect: () => duplicateOne(script) },
      { separator: true },
      { label: 'Export as text', icon: 'download', onSelect: () => exportScript(script, 'txt') },
      { label: 'Export as Markdown', icon: 'fileCode', onSelect: () => exportScript(script, 'md') },
      { label: 'Export as HTML', icon: 'fileText', onSelect: () => exportScript(script, 'html') },
      { label: 'Print…', icon: 'printer', onSelect: () => printOne(script) },
      { separator: true },
      { label: 'Move to trash', icon: 'trash', danger: true, onSelect: () => handleTrashOne(script) },
    ];
    openMenu(anchor, [...items, { separator: true }, { label: 'Properties', icon: 'info', onSelect: () => openProperties(script) }]);
  }

  async function renameScript(script) {
    const name = await promptDialog({
      title: 'Rename script',
      label: 'Title',
      value: script.title,
      confirmLabel: 'Rename',
      maxLength: 200,
      iconName: 'type',
      validate: (value) => (value.length > 200 ? 'Titles are limited to 200 characters.' : null),
    });
    if (!name || name === script.title) return;
    try {
      await bulkUpdateScripts([script.id], (record) => ({ ...record, title: normalizeTitle(name), updatedAt: new Date().toISOString() }));
      toast('Script renamed.', { type: 'success' });
      await refreshAfterChange();
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The script could not be renamed.'), { type: 'error' });
    }
  }

  async function duplicateOne(script) {
    try {
      const copy = await duplicateScript(script.id);
      toast(`Duplicated as “${copy.title}”.`, { type: 'success' });
      await refreshAfterChange();
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The script could not be duplicated.'), { type: 'error' });
    }
  }

  function exportScript(script, format) {
    try {
      const fileName = downloadScript(script, format, { readerSettings: ctx.settingsStore.get().reader });
      toast(`Exported ${fileName}.`, { type: 'success' });
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The script could not be exported.'), { type: 'error' });
    }
  }

  function printOne(script) {
    try {
      printScript(script);
    } catch (error) {
      toast(friendlyErrorMessage(error, 'Printing is not available in this browser.'), { type: 'error' });
    }
  }

  async function openMoveDialog(ids) {
    if (!ids.length) return;
    const modal = openModal({
      title: ids.length === 1 ? 'Move script' : `Move ${pluralize(ids.length, 'scripts')}`,
      description: 'Choose a folder. Moving does not change the script content or its updated date.',
      icon: 'moveFolder',
      size: 'md',
    });
    const body = h('div', { class: 'stack', style: { gap: '12px' } });
    const select = h('select', { class: 'select', 'aria-label': 'Destination folder' });
    select.append(h('option', { value: '', text: 'Unfiled' }));
    for (const folder of state.folders) select.append(h('option', { value: folder.id, text: folder.name }));
    body.append(h('div', { class: 'field' }, h('label', { class: 'label', text: 'Folder' }), select));
    body.append(h('div', { class: 'field-hint', text: 'Folders organize scripts; they do not duplicate or encrypt content.' }));
    modal.body.append(body);
    const footer = h('div', { class: 'btn-row' });
    const cancel = button('Cancel', { variant: 'ghost', onClick: () => modal.close() });
    const move = button('Move', { iconName: 'moveFolder', variant: 'primary' });
    footer.append(cancel, move);
    modal.footer.append(footer);
    move.addEventListener('click', async () => {
      try {
        const folderId = select.value || null;
        await bulkUpdateScripts(ids, (script) => ({ ...script, folderId }));
        toast(`Moved ${pluralize(ids.length, 'script')} to ${folderId ? folderNameFor(foldersById, folderId) : 'Unfiled'}.`, { type: 'success' });
        modal.close(true);
        state.selected.clear();
        await refreshAfterChange();
      } catch (error) {
        toast(friendlyErrorMessage(error, 'The scripts could not be moved.'), { type: 'error' });
      }
    });
  }

  async function openTagsDialog(script) {
    const modal = openModal({
      title: 'Manage tags',
      description: `Organize “${truncate(script.title, 60)}” with short tags. Tags are stored only with this script.`,
      icon: 'tag',
      size: 'md',
    });
    let tags = [...(script.tags || [])];
    const body = h('div', { class: 'stack', style: { gap: '12px' } });
    const tagList = h('div', { class: 'tag-list' });
    const input = h('input', { class: 'input', placeholder: 'Type a tag and press Enter', maxlength: '40', 'aria-label': 'New tag' });
    const error = h('div', { class: 'field-error', hidden: true });
    const renderTags = () => {
      tagList.replaceChildren();
      if (!tags.length) tagList.append(h('span', { class: 'field-hint', text: 'No tags yet.' }));
      for (const tag of tags) {
        const chip = h('span', { class: 'tag-chip' });
        chip.append(document.createTextNode(tag));
        const remove = h('button', { type: 'button', 'aria-label': `Remove tag ${tag}`, html: icon('x', { size: 11 }) });
        remove.addEventListener('click', () => {
          tags = tags.filter((item) => item !== tag);
          renderTags();
        });
        chip.append(remove);
        tagList.append(chip);
      }
    };
    renderTags();
    const addTag = () => {
      const [tag] = normalizeTags([input.value]);
      if (!tag) {
        error.textContent = 'Enter a tag between 1 and 40 characters.';
        error.hidden = false;
        return;
      }
      if (tags.some((item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase())) {
        error.textContent = 'That tag is already on this script.';
        error.hidden = false;
        return;
      }
      if (tags.length >= 30) {
        error.textContent = 'A script can have at most 30 tags.';
        error.hidden = false;
        return;
      }
      tags.push(tag);
      input.value = '';
      error.hidden = true;
      renderTags();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addTag();
      }
    });
    const addButton = button('Add tag', { iconName: 'plus', size: 'sm', onClick: addTag });
    const inputRow = h('div', { style: { display: 'flex', gap: '6px' } }, input, addButton);
    body.append(h('div', { class: 'field' }, h('label', { class: 'label', text: 'Tags' }), tagList), inputRow, error);
    modal.body.append(body);
    const footer = h('div', { class: 'btn-row' });
    const cancel = button('Cancel', { variant: 'ghost', onClick: () => modal.close() });
    const save = button('Save tags', { iconName: 'check', variant: 'primary' });
    footer.append(cancel, save);
    modal.footer.append(footer);
    save.addEventListener('click', async () => {
      try {
        await bulkUpdateScripts([script.id], (record) => ({ ...record, tags: normalizeTags(tags) }));
        toast('Tags updated.', { type: 'success' });
        modal.close(true);
        await refreshAfterChange();
      } catch (error_) {
        toast(friendlyErrorMessage(error_, 'Tags could not be saved.'), { type: 'error' });
      }
    });
  }

  function openProperties(script) {
    const modal = openModal({
      title: script.title,
      description: 'Script properties',
      icon: 'info',
      size: 'md',
    });
    const grid = h('div', { class: 'about-grid' });
    const rows = [
      ['Format', script.contentFormat === 'markdown' ? 'Markdown' : 'Plain text'],
      ['Words', (script.wordCount || 0).toLocaleString()],
      ['Characters', (script.characterCount || 0).toLocaleString()],
      ['Paragraphs', (script.paragraphCount || 0).toLocaleString()],
      ['Estimated read', estimateRead(script)],
      ['Folder', folderNameFor(foldersById, script.folderId)],
      ['Created', formatDate(script.createdAt, { dateStyle: 'medium', timeStyle: 'short' })],
      ['Updated', formatDate(script.updatedAt, { dateStyle: 'medium', timeStyle: 'short' })],
      ['Last opened', script.lastOpenedAt ? formatRelative(script.lastOpenedAt) : 'Never'],
      ['Source file', script.sourceFileName || 'None'],
      ['Content fingerprint', script.contentHash ? `${script.contentHash.slice(0, 12)}…` : 'Not available'],
      ['Script ID', script.id],
    ];
    for (const [label, value] of rows) {
      const item = h('dl', { class: 'about-item' });
      item.append(h('dt', { text: label }), h('dd', { text: String(value) }));
      grid.append(item);
    }
    modal.body.append(grid);
    modal.footer.append(h('div', { class: 'btn-row' }, button('Close', { onClick: () => modal.close() })));
  }

  async function createFolder() {
    const name = await promptDialog({
      title: 'New folder',
      label: 'Folder name',
      placeholder: 'e.g. Product launch',
      confirmLabel: 'Create folder',
      iconName: 'folderPlus',
      maxLength: 80,
      validate: (value) => {
        if (value.length > 80) return 'Folder names are limited to 80 characters.';
        if (state.folders.some((folder) => folder.name.toLocaleLowerCase() === value.toLocaleLowerCase())) {
          return 'A folder with that name already exists.';
        }
        return null;
      },
    });
    if (!name) return;
    try {
      await saveFolder(createFolderRecord({ name }));
      toast(`Folder “${name}” created.`, { type: 'success' });
      await refreshAfterChange();
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The folder could not be created.'), { type: 'error' });
    }
  }

  async function renameFolder(folder) {
    const name = await promptDialog({
      title: 'Rename folder',
      label: 'Folder name',
      value: folder.name,
      confirmLabel: 'Rename folder',
      iconName: 'folder',
      maxLength: 80,
      validate: (value) => {
        if (state.folders.some((item) => item.id !== folder.id && item.name.toLocaleLowerCase() === value.toLocaleLowerCase())) {
          return 'Another folder already uses that name.';
        }
        return value.length > 80 ? 'Folder names are limited to 80 characters.' : null;
      },
    });
    if (!name || name === folder.name) return;
    try {
      await saveFolder({ ...folder, name: normalizeFolderName(name), updatedAt: new Date().toISOString() });
      toast('Folder renamed.', { type: 'success' });
      await refreshAfterChange();
      folderManagerRefresh?.();
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The folder could not be renamed.'), { type: 'error' });
    }
  }

  async function removeFolder(folder) {
    const count = state.scripts.filter((script) => script.folderId === folder.id).length;
    const ok = await confirmDialog({
      title: `Delete folder “${folder.name}”?`,
      message: count
        ? `${pluralize(count, 'script')} in this folder will move to Unfiled. Scripts are not deleted.`
        : 'The folder is empty and will be removed.',
      confirmLabel: 'Delete folder',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteFolder(folder.id);
      if (state.folder === folder.id) state.folder = '';
      toast('Folder deleted.', { type: 'success' });
      await refreshAfterChange();
      folderManagerRefresh?.();
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The folder could not be deleted.'), { type: 'error' });
    }
  }

  let folderManagerRefresh = null;
  function openFolderManager() {
    const modal = openModal({
      title: 'Manage folders',
      description: 'Rename or delete folders. Deleting a folder moves its scripts to Unfiled; it never deletes scripts.',
      icon: 'folder',
      size: 'md',
    });
    const list = h('div', { class: 'stack', style: { gap: '6px' } });
    const refresh = () => {
      list.replaceChildren();
      const counts = new Map();
      for (const script of state.scripts) {
        if (script.folderId) counts.set(script.folderId, (counts.get(script.folderId) || 0) + 1);
      }
      if (!state.folders.length) list.append(h('div', { class: 'empty-inline', text: 'No folders yet.' }));
      for (const folder of state.folders) {
        const row = h('div', { class: 'setting-row', style: { alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--line)' } });
        const info = h('div', {});
        info.append(h('div', { class: 'setting-row__label', text: folder.name }), h('div', { class: 'setting-row__desc', text: pluralize(counts.get(folder.id) || 0, 'script') }));
        const actions = h('div', { class: 'btn-row' });
        actions.append(
          button('Rename', { size: 'sm', iconName: 'pencil', onClick: () => renameFolder(folder) }),
          button('Delete', { size: 'sm', iconName: 'trash', onClick: () => removeFolder(folder) }),
        );
        row.append(info, actions);
        list.append(row);
      }
    };
    refresh();
    folderManagerRefresh = refresh;
    modal.body.append(list);
    const footer = h('div', { class: 'btn-row' });
    footer.append(
      button('New folder', { iconName: 'folderPlus', onClick: async () => { await createFolder(); refresh(); } }),
      button('Close', { variant: 'ghost', onClick: () => { folderManagerRefresh = null; modal.close(); } }),
    );
    modal.footer.append(footer);
  }

  function updateRouteQuery() {
    const query = {
      q: state.q || undefined,
      folder: state.folder || undefined,
      tag: state.tag || undefined,
      sort: state.sort !== 'updated-desc' ? state.sort : undefined,
      recent: state.recent ? '1' : undefined,
    };
    if (isTrash) routerPathReplace('/trash', query);
    else if (isFavorites) routerPathReplace('/favorites', query);
    else routerPathReplace('/library', query);
  }

  function routerPathReplace(path, query) {
    // Keep filter state visible in the URL without triggering a full rerender.
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
    try {
      history.replaceState(null, '', `#${path}${params.toString() ? `?${params}` : ''}`);
    } catch {
      // Filtering still works if history is unavailable.
    }
  }

  // Evidence of file content is not rendered as HTML here. The row preview is
  // plain text, and export/print use the sanitising exporters.

  return {
    element,
    pageTitle: isTrash ? 'Trash' : isFavorites ? 'Favorites' : 'Script library',
    guard: null,
    cleanup: () => {
      clearTimeout(searchTimer);
      folderManagerRefresh = null;
    },
  };
}
