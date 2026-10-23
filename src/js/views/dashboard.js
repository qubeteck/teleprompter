import { getAllScripts, getAllFolders, getAllUserPresets } from '../database.js';
import { h, iconSpan, button, emptyState, toast } from '../ui.js';
import { icon } from '../icons.js';
import {
  formatDuration,
  formatEstimated,
  formatRelative,
  friendlyErrorMessage,
  pluralize,
  countWords,
  truncate,
} from '../utils.js';
import { getBackupStatus, renderBackupBanner, openBackupDialog } from '../backup-manager.js';
import { getAllPresets, getPresetById, applyPreset, getLastPresetId } from '../presets.js';
import { computePlaybackMetrics } from '../scroll-engine.js';

function statCard(iconName, value, label, tone = '') {
  const card = h('div', { class: 'stat-card' });
  const box = h('div', { class: `stat-card__icon${tone ? ` stat-card__icon--${tone}` : ''}` });
  box.innerHTML = icon(iconName, { size: 17 });
  const text = h('div', { style: { minWidth: '0' } });
  text.append(h('div', { class: 'stat-card__value', text: value }), h('div', { class: 'stat-card__label', text: label }));
  card.append(box, text);
  return card;
}

function recentItem(script, foldersById) {
  const anchor = h('a', { class: 'recent-item', href: `#/editor/${encodeURIComponent(script.id)}` });
  const iconBox = h('div', { class: 'recent-item__icon' });
  iconBox.innerHTML = icon(script.contentFormat === 'markdown' ? 'fileCode' : 'fileText', { size: 16 });
  const body = h('div', { class: 'recent-item__body' });
  body.append(h('div', { class: 'recent-item__title', text: script.title }));
  const meta = h('div', { class: 'recent-item__meta' });
  meta.append(h('span', { text: pluralize(script.wordCount || countWords(script.content), 'word') }));
  meta.append(h('span', { text: `≈ ${formatDuration(((script.wordCount || 0) / 140) * 60)}` }));
  if (script.folderId && foldersById.get(script.folderId)) meta.append(h('span', { text: foldersById.get(script.folderId).name }));
  meta.append(h('span', { text: formatRelative(script.updatedAt) }));
  body.append(meta);
  const arrow = h('div', { class: 'recent-item__arrow' });
  arrow.innerHTML = icon('chevronRight', { size: 16 });
  anchor.append(iconBox, body, arrow);
  return anchor;
}

function presetPill(preset, onApply) {
  const pill = h('button', { type: 'button', class: 'preset-pill' });
  pill.append(iconSpan(preset.icon || 'sliders', { size: 14 }), h('span', { text: preset.name }));
  pill.addEventListener('click', () => onApply(preset));
  return pill;
}

export async function dashboardView(ctx) {
  const element = h('div', { class: 'stack' });
  const loading = h('div', { class: 'loading-block' }, h('span', { class: 'spinner' }), h('span', { text: 'Opening your studio…' }));
  element.append(loading);

  let scripts = [];
  let folders = [];
  let userPresets = [];
  let backupStatus = null;
  try {
    [scripts, folders, userPresets, backupStatus] = await Promise.all([
      getAllScripts(),
      getAllFolders(),
      getAllUserPresets(),
      getBackupStatus(ctx.settingsStore.get()),
    ]);
  } catch (error) {
    element.replaceChildren(
      emptyState({
        iconName: 'warning',
        title: 'Your library could not be read',
        description: friendlyErrorMessage(error, 'IndexedDB could not be accessed. Your data may still exist in this browser.'),
        actions: [{ label: 'Try again', icon: 'refresh', primary: true, onClick: () => ctx.navigate('/') }],
      }),
    );
    return { element };
  }

  const foldersById = new Map(folders.map((folder) => [folder.id, folder]));
  const totalWords = scripts.reduce((sum, script) => sum + (script.wordCount || countWords(script.content)), 0);
  const recent = [...scripts].sort((a, b) => {
    const aTime = new Date(a.lastOpenedAt || a.updatedAt).getTime();
    const bTime = new Date(b.lastOpenedAt || b.updatedAt).getTime();
    return bTime - aTime;
  }).slice(0, 5);
  const favorites = scripts.filter((script) => script.isFavorite).slice(0, 4);
  const lastScript = recent[0] || null;
  const presets = getAllPresets(userPresets);
  const lastPresetId = getLastPresetId();
  const lastPreset = lastPresetId ? getPresetById(presets, lastPresetId) : null;
  const quickPresets = [...new Set([lastPreset?.id, 'builtin-standard', 'builtin-youtube', 'builtin-live'].filter(Boolean))]
    .map((id) => getPresetById(presets, id))
    .filter(Boolean)
    .slice(0, 4);
  const totalMinutes = Math.round(totalWords / 140);

  element.replaceChildren();

  const hero = h('section', { class: 'hero', 'aria-labelledby': 'hero-heading' });
  hero.append(h('div', { class: 'hero__eyebrow' }, iconSpan('shield', { size: 12 }), h('span', { text: 'Local-first · no account' })));
  const title = h('h2', { class: 'hero__title', id: 'hero-heading' });
  if (!scripts.length) {
    title.append(document.createTextNode('Your words, ready when '), h('em', { text: 'you are.' }));
  } else {
    title.append(document.createTextNode('Step up and '), h('em', { text: 'deliver.' }));
  }
  hero.append(title);
  hero.append(
    h('p', {
      class: 'hero__copy',
      text: scripts.length
        ? 'Write, import, and rehearse from one quiet workspace. Everything stays in this browser unless you export it.'
        : 'Create a script or import a document, then read it at your pace with a smooth teleprompter, presets, and keyboard controls. Nothing leaves this device.',
    }),
  );

  const heroActions = h('div', { class: 'hero__actions' });
  heroActions.append(
    button('New script', { iconName: 'plus', variant: 'primary', size: 'lg', onClick: () => ctx.createScript() }),
    button('Import document', { iconName: 'upload', size: 'lg', onClick: () => ctx.openImport() }),
  );
  if (lastScript) {
    heroActions.append(
      button('Resume reading', {
        iconName: 'play',
        variant: 'violet',
        size: 'lg',
        onClick: () => ctx.navigate(`/read/${encodeURIComponent(lastScript.id)}`),
      }),
    );
  }
  hero.append(heroActions);

  const heroMeta = h('div', { class: 'hero__meta' });
  const metaEntries = [
    [String(scripts.length), pluralize(scripts.length, 'script')],
    [totalWords.toLocaleString(), 'words stored'],
    [totalMinutes ? formatDuration(totalMinutes * 60) : '0s', 'est. reading time'],
    [pluralize(folders.length, 'folder'), 'for organizing'],
  ];
  for (const [value, label] of metaEntries) {
    const stat = h('div');
    stat.append(h('div', { class: 'hero-stat__value', text: value }), h('div', { class: 'hero-stat__label', text: label }));
    heroMeta.append(stat);
  }
  hero.append(heroMeta);
  element.append(hero);

  const stats = h('div', { class: 'stat-grid', style: { marginTop: '16px' } });
  stats.append(
    statCard('fileText', scripts.length.toLocaleString(), 'Active scripts'),
    statCard('star', favorites.length.toLocaleString(), 'Favorites', 'violet'),
    statCard('folder', folders.length.toLocaleString(), 'Folders', 'success'),
    statCard('clock', totalWords ? formatDuration((totalWords / 140) * 60) : '0s', 'Total read time', 'warn'),
  );
  element.append(stats);

  const grid = h('div', { class: 'dashboard-grid' });
  const left = h('div', { class: 'stack' });

  const recentCard = h('section');
  const recentHead = h('div', { class: 'section-head' });
  recentHead.append(h('h2', { text: 'Recent scripts' }), h('a', { href: '#/library', text: 'View library →' }));
  recentCard.append(recentHead);
  if (recent.length) {
    const list = h('div', { class: 'recent-list' });
    for (const script of recent) list.append(recentItem(script, foldersById));
    recentCard.append(list);
  } else {
    const empty = h('div', { class: 'empty-inline' });
    empty.append(
      h('p', { style: { margin: '0 0 12px' }, text: 'Your library is empty. Start with a blank script or bring in a document you already have.' }),
      h('div', { class: 'btn-row', style: { justifyContent: 'center' } },
        button('Create blank script', { iconName: 'plus', onClick: () => ctx.createScript() }),
        button('Import a file', { iconName: 'upload', onClick: () => ctx.openImport() }),
      ),
    );
    recentCard.append(empty);
  }
  left.append(recentCard);

  if (favorites.length) {
    const favCard = h('section');
    const favHead = h('div', { class: 'section-head' });
    favHead.append(h('h2', { text: 'Favorites' }), h('a', { href: '#/favorites', text: 'All favorites →' }));
    favCard.append(favHead);
    const list = h('div', { class: 'recent-list' });
    for (const script of favorites) list.append(recentItem(script, foldersById));
    favCard.append(list);
    left.append(favCard);
  }

  const right = h('div', { class: 'stack' });

  if (backupStatus && (backupStatus.due || backupStatus.never) && scripts.length) {
    const banner = renderBackupBanner(backupStatus, {
      onBackup: () => {
        openBackupDialog({
          settingsStore: ctx.settingsStore,
          onBackup: () => {
            ctx.refreshBackupStatus();
            ctx.navigate('/');
          },
        });
      },
    });
    right.append(banner);
  } else if (backupStatus && !backupStatus.never && scripts.length) {
    right.append(renderBackupBanner(backupStatus, { compact: true, onBackup: () => openBackupDialog({ settingsStore: ctx.settingsStore }) }));
  }

  const presetCard = h('div', { class: 'card' });
  const presetHead = h('div', { class: 'card__head' });
  presetHead.append(h('h2', { class: 'card__title', text: 'Quick-start presets' }), h('span', { class: 'badge badge--violet', text: 'Reader' }));
  const presetBody = h('div', { class: 'card__body' });
  presetBody.append(h('p', { class: 'field-hint', style: { marginTop: '0' }, text: 'Apply a reading setup, then jump straight into rehearsal.' }));
  const quick = h('div', { class: 'preset-quick', style: { marginTop: '10px' } });
  for (const preset of quickPresets) {
    quick.append(
      presetPill(preset, async () => {
        applyPreset(ctx.settingsStore, preset);
        ctx.settingsStore.saveNow().catch(() => {});
        toast(`“${preset.name}” applied to reader settings.`, {
          type: 'success',
          actions: lastScript
            ? [{ label: 'Read now', onClick: () => ctx.navigate(`/read/${encodeURIComponent(lastScript.id)}`) }]
            : [],
        });
      }),
    );
  }
  presetBody.append(quick);
  const presetFooter = h('div', { class: 'card__footer' });
  presetFooter.append(button('Manage presets', { iconName: 'sliders', size: 'sm', onClick: () => ctx.navigate('/settings?section=presets') }));
  presetCard.append(presetHead, presetBody, presetFooter);
  right.append(presetCard);

  if (lastScript) {
    const resumeCard = h('div', { class: 'card' });
    const resumeHead = h('div', { class: 'card__head' });
    resumeHead.append(h('h2', { class: 'card__title', text: 'Continue where you left off' }));
    const resumeBody = h('div', { class: 'card__body' });
    resumeBody.append(
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' } },
        (() => {
          const box = h('div', { class: 'recent-item__icon' });
          box.innerHTML = icon('fileText', { size: 16 });
          return box;
        })(),
        h('div', { style: { minWidth: '0' } },
          h('div', { style: { fontWeight: '650', fontSize: '12.5px' }, class: 'truncate', text: lastScript.title }),
          h('div', { class: 'field-hint', text: `Updated ${formatRelative(lastScript.updatedAt)}` }),
        ),
      ),
    );
    if (lastScript.lastPosition?.progress > 0) {
      const percent = Math.round(lastScript.lastPosition.progress * 100);
      const track = h('div', { class: 'progress-track' });
      track.append(h('div', { class: 'progress-track__fill', style: { width: `${percent}%` } }));
      resumeBody.append(track, h('div', { class: 'field-hint', style: { marginTop: '4px' }, text: `${percent}% through the script` }));
    }
    const resumeActions = h('div', { class: 'btn-row', style: { marginTop: '12px' } });
    resumeActions.append(
      button('Read script', { iconName: 'play', variant: 'primary', onClick: () => ctx.navigate(`/read/${encodeURIComponent(lastScript.id)}`) }),
      button('Edit', { iconName: 'pencil', onClick: () => ctx.navigate(`/editor/${encodeURIComponent(lastScript.id)}`) }),
    );
    resumeBody.append(resumeActions);
    resumeCard.append(resumeHead, resumeBody);
    right.append(resumeCard);
  }

  const localCard = h('div', { class: 'card card--flat' });
  const localBody = h('div', { class: 'card__body' });
  localBody.append(
    h('div', { style: { display: 'flex', gap: '9px', alignItems: 'flex-start' } },
      (() => {
        const box = h('div', { class: 'empty-state__icon', style: { width: '34px', height: '34px', borderRadius: '9px', margin: '0', flex: '0 0 auto' } });
        box.innerHTML = icon('hardDrive', { size: 16 });
        return box;
      })(),
      h('div', {},
        h('div', { style: { fontSize: '12px', fontWeight: '650' }, text: 'Private by default' }),
        h('p', { class: 'field-hint', style: { margin: '3px 0 0', lineHeight: '1.55' }, text: 'No upload, no analytics, no account. Clearing browser data erases scripts, so keep a backup.' }),
      ),
    ),
  );
  localCard.append(localBody);
  right.append(localCard);

  grid.append(left, right);
  element.append(grid);

  const wordsHead = h('div', { class: 'section-head', style: { marginTop: '24px' } });
  wordsHead.append(h('h2', { text: 'Today’s stage' }), h('span', { class: 'field-hint', text: lastPreset ? `Last preset: ${lastPreset.name}` : 'Choose a preset to match your setup' }));
  const wordsBody = h('div', { class: 'help-grid' });
  const cards = [
    ['Write with focus', 'Use plain text or Markdown, insert pause and cue markers, and keep an eye on speaking time.', 'pencil', () => ctx.createScript()],
    ['Import without surprises', 'TXT, Markdown, HTML, DOCX, PDF, RTF, JSON, and images with optional OCR. Preview before saving.', 'upload', () => ctx.openImport()],
    ['Rehearse and record', 'Mirror for a beam splitter, hide controls, follow your voice, or record camera and audio locally.', 'video', () => (lastScript ? ctx.navigate(`/read/${encodeURIComponent(lastScript.id)}`) : ctx.openImport())],
    ['Keep it recoverable', 'Download a versioned backup after a writing session. Restore supports safe merge or replace.', 'shield', () => ctx.navigate('/settings?section=data')],
  ];
  for (const [cardTitle, copy, iconName, action] of cards) {
    const card = h('button', { type: 'button', class: 'help-card', style: { textAlign: 'left', cursor: 'pointer' } });
    card.append(h('h3', { text: cardTitle }), h('p', { text: copy }));
    card.addEventListener('click', action);
    wordsBody.append(card);
  }
  // The help-grid cards above are buttons; replace the empty section media.
  element.append(wordsHead, wordsBody);

  return {
    element,
    guard: null,
    pageTitle: 'Dashboard',
  };
}
