import '../css/input.css';
import { APP_NAME, APP_VERSION, SettingsStore } from './settings.js';
import { openDatabase } from './database.js';
import { HashRouter, buildHash } from './router.js';
import { h, iconSpan, iconButton, button, toast, openModal, closeMenu, confirmDialog } from './ui.js';
import { icon } from './icons.js';
import { friendlyErrorMessage, formatBytes, isTypingTarget, supportsFeature } from './utils.js';
import { getShortcutGroups } from './keyboard-shortcuts.js';
import { getBackupStatus, renderBackupBanner } from './backup-manager.js';
import { openImportDialog } from './file-importer.js';
import { createBlankScript } from './script-validation.js';
import { saveScript, getAllScripts, getAllFolders, getStorageEstimate } from './database.js';
import { dashboardView } from './views/dashboard.js';
import { libraryView } from './views/library.js';
import { editorView } from './views/editor.js';
import { readerView } from './views/reader.js';
import { settingsView } from './views/settings.js';
import { remoteView } from './views/remote.js';
import { notFoundView } from './views/not-found.js';

const ROUTE_META = {
  dashboard: { title: 'Dashboard', crumb: 'Studio' },
  library: { title: 'Script library', crumb: 'Studio' },
  favorites: { title: 'Favorites', crumb: 'Library' },
  trash: { title: 'Trash', crumb: 'Library' },
  editor: { title: 'Editor', crumb: 'Studio' },
  reader: { title: 'Teleprompter', crumb: 'Studio' },
  settings: { title: 'Settings', crumb: 'Studio' },
  remote: { title: 'Remote control', crumb: 'Teleprompter' },
  'not-found': { title: 'Page not found', crumb: 'Studio' },
};

function makeShell() {
  const app = document.getElementById('app');
  app.replaceChildren();

  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar', 'aria-label': 'Primary navigation' });
  const backdrop = h('div', { class: 'sidebar-backdrop', hidden: true });
  backdrop.addEventListener('click', () => setSidebarOpen(false));

  const mobileMenu = iconButton('menu', 'Open navigation', {
    className: 'mobile-menu-btn',
    onClick: () => setSidebarOpen(true),
  });
  mobileMenu.classList.add('mobile-menu-btn');

  const crumb = h('div', { class: 'topbar__crumb', text: 'Studio' });
  const heading = h('h1', { class: 'topbar__heading', id: 'topbar-heading', text: 'Dashboard' });
  const titleWrap = h('div', { class: 'topbar__title' }, crumb, heading);

  const searchForm = h('form', { class: 'global-search', role: 'search' });
  searchForm.append(iconSpan('search', { size: 15, className: 'global-search__icon' }));
  const searchInput = h('input', {
    type: 'search',
    placeholder: 'Search scripts…',
    'aria-label': 'Search scripts',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  searchInput.id = 'global-search-input';
  searchForm.append(searchInput, h('kbd', { class: 'global-search__kbd', text: 'Ctrl K' }));
  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = searchInput.value.trim();
    ctx.navigate(buildHash('/library', { q: query || undefined }));
    searchInput.blur();
  });

  const importButton = button('Import', { iconName: 'upload', onClick: () => ctx.openImport(), className: 'btn--cta' });
  importButton.setAttribute('title', 'Import documents');
  const newButton = button('New script', { iconName: 'plus', variant: 'primary', onClick: () => ctx.createScript(), className: 'btn--cta' });
  const helpButton = iconButton('help', 'Help and keyboard shortcuts', { onClick: () => ctx.openHelp() });

  const actions = h('div', { class: 'topbar__actions' }, helpButton, importButton, newButton);
  const topbar = h('header', { class: 'topbar' }, mobileMenu, titleWrap, h('div', { class: 'topbar__spacer' }), searchForm, actions);

  const offlineBanner = h('div', { class: 'offline-banner', role: 'status', 'aria-live': 'polite' });
  offlineBanner.append(iconSpan('wifiOff', { size: 14 }), h('span', { text: 'You are offline. Editing, reading, and local saving continue to work.' }));

  const view = h('main', { class: 'view', id: 'view', tabindex: '-1' });
  const main = h('div', { class: 'main-column' }, offlineBanner, topbar, view);
  app.append(h('div', { class: 'app-shell' }, sidebar, backdrop, main));

  const updateOnline = () => {
    offlineBanner.dataset.visible = String(!navigator.onLine);
  };
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  updateOnline();

  return { app, sidebar, backdrop, crumb, heading, searchInput, searchForm, view, offlineBanner, topbar, mobileMenu };
}

function setSidebarOpen(open) {
  if (!shell) return;
  shell.sidebar.dataset.open = String(Boolean(open));
  shell.backdrop.hidden = !open;
  document.body.classList.toggle('sidebar-is-open', Boolean(open));
  if (open) {
    shell.sidebar.querySelector('a, button')?.focus({ preventScroll: true });
  } else {
    shell.mobileMenu?.focus({ preventScroll: true });
  }
}

let shell = null;
let router = null;
let settingsStore = null;
let currentViewResult = null;
let deferredInstallPrompt = null;
let searchDebounceTimer = null;

const ctx = {
  get settingsStore() {
    return settingsStore;
  },
  navigate: (path, options) => router?.navigate(path, options),
  buildHash,
  get route() {
    return router?.current || null;
  },
  setTopbarTitle(title, crumb = null) {
    if (!shell) return;
    shell.heading.textContent = title || 'Advanced Teleprompter Studio';
    if (crumb) shell.crumb.textContent = crumb;
    document.title = `${title || APP_NAME} — ${APP_NAME}`;
  },
  async refreshSidebar() {
    await refreshSidebar(router?.current?.name);
  },
  async refresh() {
    if (router) await router.refresh();
  },
  async refreshBackupStatus() {
    await refreshBackupStatus();
  },
  async createScript({ folderId = null, content = '', contentFormat = 'plain', title = 'Untitled script', open = true } = {}) {
    try {
      const blank = createBlankScript({ title, content, contentFormat, folderId });
      const { prepareScriptRecord } = await import('./script-validation.js');
      const record = await prepareScriptRecord(blank);
      await saveScript(record);
      await refreshSidebar();
      if (open) await router.navigate(`/editor/${encodeURIComponent(record.id)}`);
      toast('New script created. Start typing — changes save automatically.', { type: 'success', title: 'Script created' });
      return record;
    } catch (error) {
      toast(friendlyErrorMessage(error, 'A new script could not be created.'), { type: 'error', title: 'Could not create script' });
      return null;
    }
  },
  openImport(options = {}) {
    const modal = openImportDialog({
      settingsStore,
      ...options,
      onImported(records) {
        refreshSidebar();
        options.onImported?.(records);
        if (!options.onImported && records?.length) {
          router.navigate(`/editor/${encodeURIComponent(records[0].id)}`);
        }
      },
    });
    return modal;
  },
  openHelp() {
    openShortcutsHelp();
  },
  openSearch(query = '') {
    if (query) shell.searchInput.value = query;
    shell.searchInput.focus();
    shell.searchInput.select();
  },
  async openInstall() {
    if (!deferredInstallPrompt) {
      toast(
        supportsFeature('serviceWorker')
          ? 'Use your browser’s “Install app” or “Add to Home Screen” action. The install prompt is not available right now.'
          : 'This browser does not support installing the app. The studio still works in a normal tab.',
        { type: 'info', title: 'Install the studio' },
      );
      return false;
    }
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice.catch(() => null);
    deferredInstallPrompt = null;
    return choice?.outcome === 'accepted';
  },
  get canInstall() {
    return Boolean(deferredInstallPrompt);
  },
  confirmDialog,
  toast,
  async leaveReader() {
    router.navigate('/library');
  },
};

async function refreshSidebar(routeName = null) {
  if (!shell) return;
  const currentName = routeName || router?.current?.name || 'dashboard';
  let scripts = [];
  let folders = [];
  let trashCount = 0;
  try {
    [scripts, folders] = await Promise.all([getAllScripts(), getAllFolders()]);
    trashCount = (await getAllScripts({ includeDeleted: true })).filter((script) => script.deletedAt).length;
  } catch {
    // The main view surfaces storage errors; the sidebar keeps working.
  }
  const favoriteCount = scripts.filter((script) => script.isFavorite).length;
  const counts = {
    library: scripts.length,
    favorites: favoriteCount,
    trash: trashCount,
  };

  const navItems = [
    { path: '/', label: 'Dashboard', iconName: 'dashboard', routeName: 'dashboard' },
    { path: '/library', label: 'Script library', iconName: 'library', routeName: 'library', count: counts.library },
    { path: '/favorites', label: 'Favorites', iconName: 'star', routeName: 'favorites', count: counts.favorites },
    { path: '/trash', label: 'Trash', iconName: 'trash', routeName: 'trash', count: counts.trash },
    { path: '/settings', label: 'Settings & presets', iconName: 'settings', routeName: 'settings' },
  ];

  const nav = h('div', { class: 'nav-group' });
  nav.append(h('div', { class: 'nav-label', text: 'Workspace' }));
  for (const item of navItems) {
    const link = h('a', {
      class: 'nav-link',
      href: buildHash(item.path),
      'aria-current': currentName === item.routeName ? 'page' : null,
    });
    link.append(iconSpan(item.iconName, { size: 17, className: 'nav-link__icon' }), h('span', { text: item.label }));
    if (item.count != null) link.append(h('span', { class: 'nav-link__count', text: item.count.toLocaleString() }));
    nav.append(link);
  }

  const reading = h('a', {
    class: 'nav-link',
    href: '#/library?recent=1',
  });
  reading.append(iconSpan('play', { size: 17, className: 'nav-link__icon' }), h('span', { text: 'Quick read' }));
  nav.append(h('div', { class: 'nav-label', text: 'Read' }), reading);

  const foldersNav = h('div', { class: 'nav-group' });
  const folderHead = h('div', { class: 'nav-label' });
  folderHead.style.display = 'flex';
  folderHead.append(h('span', { text: 'Folders' }));
  const addFolder = h('button', {
    type: 'button',
    class: 'btn btn--icon btn--sm btn--ghost',
    'aria-label': 'Create folder',
    title: 'Create folder',
    style: { marginLeft: 'auto', minHeight: '24px', width: '24px' },
  });
  addFolder.innerHTML = icon('folderPlus', { size: 13 });
  folderHead.append(addFolder);
  foldersNav.append(folderHead);
  for (const folder of folders.slice(0, 6)) {
    const count = scripts.filter((script) => script.folderId === folder.id).length;
    const link = h('a', { class: 'nav-link', href: buildHash('/library', { folder: folder.id }) });
    link.append(iconSpan('folder', { size: 15, className: 'nav-link__icon' }), h('span', { class: 'truncate', text: folder.name }));
    link.append(h('span', { class: 'nav-link__count', text: String(count) }));
    foldersNav.append(link);
  }
  if (!folders.length) {
    const hint = h('div', { class: 'field-hint', style: { padding: '2px 12px' }, text: 'No folders yet.' });
    foldersNav.append(hint);
  }
  addFolder.addEventListener('click', async () => {
    const { promptDialog } = await import('./ui.js');
    const name = await promptDialog({
      title: 'New folder',
      label: 'Folder name',
      placeholder: 'e.g. Keynote 2026',
      confirmLabel: 'Create folder',
      iconName: 'folderPlus',
      maxLength: 80,
    });
    if (!name) return;
    const { createFolderRecord } = await import('./script-validation.js');
    const { saveFolder } = await import('./database.js');
    try {
      await saveFolder(createFolderRecord({ name }));
      toast(`Folder “${name}” created.`, { type: 'success' });
      await refreshSidebar();
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The folder could not be created.'), { type: 'error' });
    }
  });

  const storageCard = h('div', { class: 'storage-card' });
  storageCard.append(h('div', { class: 'storage-card__top' }, h('span', { text: 'Local storage' }), h('span', { class: 'badge badge--success', text: 'On device' })));
  const meter = h('div', { class: 'storage-meter' }, h('div', { class: 'storage-meter__fill', style: { width: '0%' } }));
  const storageText = h('div', { class: 'field-hint', text: 'Reading browser storage…' });
  storageCard.append(meter, storageText);

  const footer = h('div', { class: 'sidebar__footer' });
  footer.append(storageCard);
  const localUser = h('div', { class: 'sidebar__user' });
  localUser.append(h('div', { class: 'local-avatar', text: 'A' }));
  const userInfo = h('div', { style: { minWidth: '0', flex: '1' } });
  userInfo.append(h('div', { style: { fontSize: '11.5px', fontWeight: '650' }, text: 'Local workspace' }));
  userInfo.append(h('div', { class: 'field-hint', text: 'No account · No cloud' }));
  const settingsLink = h('a', {
    href: '#/settings',
    class: 'btn btn--icon btn--sm btn--ghost',
    'aria-label': 'Open settings',
    html: icon('settings', { size: 14 }),
  });
  localUser.append(userInfo, settingsLink);
  footer.append(localUser);
  footer.append(h('div', { class: 'field-hint', style: { textAlign: 'center' }, text: `v${APP_VERSION} · Local-first` }));

  shell.sidebar.replaceChildren();
  const brand = h('a', { class: 'brand', href: '#/' });
  const mark = h('div', { class: 'brand__mark' });
  mark.innerHTML = icon('zap', { size: 22 });
  brand.append(mark, h('div', {}, h('div', { class: 'brand__title', text: 'Teleprompter' }), h('div', { class: 'brand__subtitle', text: 'Studio' })));
  shell.sidebar.append(brand, nav, foldersNav, footer);

  getStorageEstimate()
    .then((estimate) => {
      if (!estimate) {
        serverTextUnavailable();
        return;
      }
      meter.firstElementChild.style.width = `${Math.min(100, Math.max(0.8, estimate.percent)).toFixed(2)}%`;
      storageText.textContent = `${formatBytes(estimate.usage)} of ~${formatBytes(estimate.quota)} used`;
    })
    .catch(() => {
      storageText.textContent = 'Storage estimate unavailable';
    });

  function serverTextUnavailable() {
    storageText.textContent = 'This browser does not report storage usage.';
    meter.firstElementChild.style.width = '0%';
  }
}

async function refreshBackupStatus() {
  const status = await getBackupStatus(settingsStore?.get?.() || null).catch(() => null);
  if (status) {
    shell?.topbar?.setAttribute('data-backup-due', String(status.due));
  }
  return status;
}

function openShortcutsHelp() {
  const modal = openModal({
    title: 'Keyboard shortcuts & help',
    description: 'Reader shortcuts work while the teleprompter is open and no dialog is active. You can rebind them in Settings → Shortcuts.',
    icon: 'keyboard',
    size: 'lg',
  });
  const body = h('div', { class: 'stack', style: { gap: '16px' } });
  const groups = getShortcutGroups(settingsStore?.get()?.reader?.shortcutOverrides || {});
  const grid = h('div', { class: 'help-grid' });
  for (const group of groups) {
    const card = h('div', { class: 'help-card' });
    card.append(h('h3', { text: group.group }));
    for (const item of group.items) {
      const line = h('div', { class: 'shortcut-row', style: { padding: '4px 0' } });
      line.append(
        h('div', {}, h('div', { class: 'shortcut-row__name', text: item.label }), h('div', { class: 'shortcut-row__desc', text: item.description })),
        h('kbd', { class: 'kbd', text: item.display }),
      );
      card.append(line);
    }
    grid.append(card);
  }
  body.append(grid);
  const guide = h('div', { class: 'card card--flat' });
  const guideBody = h('div', { class: 'card__body' });
  guideBody.append(
    h('h3', { style: { margin: '0 0 8px', fontSize: '13px' }, text: 'Working locally' }),
    h('p', {
      class: 'muted',
      style: { margin: '0', fontSize: '12px', lineHeight: '1.65' },
      text: 'Scripts are stored in this browser profile. Download a backup from Settings → Data & backup before clearing browser data or moving to another device. Imported documents are previewed before saving, and HTML is sanitized.',
    }),
  );
  guide.append(guideBody);
  body.append(guide);
  modal.body.append(body);
  modal.footer.append(h('div', { class: 'btn-row' }, button('Close', { onClick: () => modal.close() })));
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register(new URL('./sw.js', document.baseURI), { scope: './' });
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            toast('An update is ready. Reload to use the newest version.', {
              type: 'info',
              title: 'Studio updated',
              duration: 12000,
              actions: [
                {
                  label: 'Reload',
                  onClick: () => {
                    worker.postMessage({ type: 'SKIP_WAITING' });
                    setTimeout(() => window.location.reload(), 120);
                  },
                },
              ],
            });
          }
        });
      });
    } catch (error) {
      console.warn('Service worker registration failed', error);
    }
  });
}

function updateTopbar(routeContext) {
  const meta = ROUTE_META[routeContext.name] || ROUTE_META['not-found'];
  shell.crumb.textContent = meta.crumb;
  shell.heading.textContent = meta.title;
  document.title = `${meta.title} — ${APP_NAME}`;
  const isLibrary = ['library', 'favorites', 'trash'].includes(routeContext.name);
  if (routeContext.query?.q) shell.searchInput.value = routeContext.query.q;
  if (isLibrary) {
    const query = routeContext.query.q || '';
    shell.searchInput.value = query;
  }
  for (const link of shell.sidebar.querySelectorAll('.nav-link')) {
    link.removeAttribute('aria-current');
  }
  const navName = routeContext.name;
  const mapping = { dashboard: '/', library: '/library', favorites: '/favorites', trash: '/trash', settings: '/settings' };
  const activePath = mapping[navName];
  if (activePath) {
    const selector = `.nav-link[href="#${CSS.escape ? CSS.escape(activePath) : activePath}"]`;
    try {
      shell.sidebar.querySelector(selector)?.setAttribute('aria-current', 'page');
    } catch {
      // CSS.escape is unavailable in a few embedded browsers.
    }
  }
}

async function renderRoute(matched, routeContext) {
  closeMenu();
  setSidebarOpen(false);
  updateTopbar(routeContext);
  const meta = ROUTE_META[matched.name] || ROUTE_META['not-found'];
  shell.view.className = matched.name === 'reader' || matched.name === 'remote' ? 'view view--wide' : 'view';

  let result;
  if (matched.name === 'dashboard') result = await dashboardView(ctx, routeContext);
  else if (matched.name === 'library' || matched.name === 'favorites' || matched.name === 'trash') {
    result = await libraryView(ctx, routeContext, { mode: matched.name });
  } else if (matched.name === 'editor') result = await editorView(ctx, routeContext);
  else if (matched.name === 'reader') result = await readerView(ctx, routeContext);
  else if (matched.name === 'settings') result = await settingsView(ctx, routeContext);
  else if (matched.name === 'remote') result = await remoteView(ctx, routeContext);
  else result = await notFoundView(ctx, routeContext);

  // The router owns lifecycle cleanup and calls the previous view's cleanup
  // before the next render starts. Keeping a second call here would tear down
  // the previous view twice.
  currentViewResult = result || {};

  const element = result?.element || result;
  if (element instanceof Node) {
    shell.view.replaceChildren(element);
  } else {
    shell.view.replaceChildren(
      h('div', { class: 'empty-state' }, h('h2', { text: 'This view could not be displayed.' }), h('p', { text: 'Reload the app and try again.' })),
    );
  }
  if (matched.name !== 'reader' && matched.name !== 'remote') {
    window.scrollTo({ top: 0, behavior: 'instant' });
    requestAnimationFrame(() => {
      if (!shell.view.querySelector('[autofocus]')) shell.view.focus({ preventScroll: true });
    });
  }
  refreshSidebar(matched.name);
  document.title = `${result?.pageTitle || meta.title} — ${APP_NAME}`;
  if (result?.pageTitle) shell.heading.textContent = result.pageTitle;

  return {
    cleanup: result?.cleanup,
    guard: result?.guard,
    title: document.title,
  };
}

function renderFatal(error) {
  const app = document.getElementById('app');
  const card = h('div', { style: { minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '24px' } });
  const inner = h('div', { class: 'card', style: { width: 'min(560px, 100%)' } });
  const body = h('div', { class: 'card__body' });
  const mark = h('div', { class: 'empty-state__icon', html: icon('warning', { size: 24 }) });
  mark.style.margin = '0 0 14px';
  body.append(
    mark,
    h('h1', { style: { margin: '0', fontSize: '22px', letterSpacing: '-0.03em' }, text: 'The studio could not start' }),
    h('p', { class: 'muted', style: { lineHeight: '1.65', fontSize: '13px' }, text: friendlyErrorMessage(error, 'The local database could not be opened.') }),
    h('p', {
      class: 'field-hint',
      style: { lineHeight: '1.6' },
      text: 'Your scripts remain in this browser. Check that private browsing is not blocking IndexedDB, close other studio tabs, then reload. If the problem persists, try another browser profile and restore from a backup.',
    }),
  );
  const actions = h('div', { class: 'btn-row', style: { marginTop: '18px' } });
  actions.append(
    button('Reload studio', { iconName: 'refresh', variant: 'primary', onClick: () => window.location.reload() }),
    button('View backup docs', {
      iconName: 'book',
      onClick: () => window.open('https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API', '_blank', 'noopener'),
    }),
  );
  body.append(actions);
  inner.append(body);
  card.append(inner);
  app.replaceChildren(card);
  const boot = document.querySelector('.boot-splash');
  boot?.remove();
}

async function boot() {
  shell = makeShell();
  try {
    await openDatabase();
    settingsStore = await SettingsStore.load();
  } catch (error) {
    console.error('Studio boot failed', error);
    renderFatal(error);
    return;
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    toast('The studio was installed. It will work offline after the first launch.', { type: 'success', title: 'App installed' });
  });
  window.addEventListener('teleprompter:db-versionchange', () => {
    toast('The local database was upgraded in another tab. Reload this tab before editing.', {
      type: 'warning',
      title: 'Reload required',
      duration: 0,
      actions: [{ label: 'Reload', onClick: () => window.location.reload() }],
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'k' && !event.altKey) {
      event.preventDefault();
      ctx.openSearch();
      return;
    }
    if (event.key === '?' && !isTypingTarget(event.target) && !ctx.route?.name?.match?.(/reader|editor/)) {
      event.preventDefault();
      openShortcutsHelp();
    }
  });

  // Debounced search suggestions via the library route when typing in the
  // global search would be surprising; keep explicit submit only.

  shell.searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    const value = shell.searchInput.value.trim();
    if (!value) return;
    searchDebounceTimer = setTimeout(() => {
      if (document.activeElement === shell.searchInput && ctx.route?.name !== 'reader') {
        // Keep the typed value; do not navigate while the user is still typing.
      }
    }, 250);
  });

  router = new HashRouter({
    routes: [
      { name: 'dashboard', path: '/' },
      { name: 'library', path: '/library' },
      { name: 'favorites', path: '/favorites' },
      { name: 'trash', path: '/trash' },
      { name: 'editor', path: '/editor/:id' },
      { name: 'reader', path: '/read/:id' },
      { name: 'settings', path: '/settings' },
      { name: 'remote', path: '/remote' },
      { name: 'not-found', notFound: true },
    ],
    onRender: renderRoute,
    onError: (error, routeContext) => {
      console.error('Route render failed', error);
      toast(friendlyErrorMessage(error, 'This screen could not be loaded.'), { type: 'error' });
      if (routeContext.name === 'editor' || routeContext.name === 'reader') {
        router.navigate('/library');
      }
    },
  });

  // The router owns anchor interception; make the shell's mobile menu close
  // after any navigation has committed.
  window.addEventListener('hashchange', () => setSidebarOpen(false));
  window.addEventListener('popstate', () => setSidebarOpen(false));

  registerServiceWorker();
  await router.start();
  refreshBackupStatus();
  window.addEventListener('online', () => toast('Back online. Your work was always saved locally.', { type: 'info', duration: 2500 }));
}

boot().catch((error) => {
  console.error('Unexpected boot failure', error);
  renderFatal(error);
});

// Ensure the current view can release media, timers, and listeners when the
// page is closed. beforeunload warnings themselves belong to the editor.
window.addEventListener('pagehide', () => {
  try {
    currentViewResult?.cleanup?.();
  } catch {
    // Cleanup is best effort during unload.
  }
});
