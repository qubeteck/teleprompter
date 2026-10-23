import {
  clearAllData,
  exportAllData,
  getMetadata,
  getStorageEstimate,
  isStoragePersisted,
  putImportedData,
  replaceAllData,
  requestPersistentStorage,
  savePreset,
  setMetadata,
  getAllUserPresets,
} from './database.js';
import {
  backupSummaryText,
  createBackupObject,
  MAX_BACKUP_BYTES,
  planMerge,
  planReplace,
  serializeBackup,
  validateBackup,
  validatePresetImport,
} from './backup-format.js';
import { serializePreset, presetFileName, normalizePresetName } from './presets.js';
import {
  badge,
  button,
  confirmDialog,
  createSwitch,
  emptyState,
  h,
  iconButton,
  iconSpan,
  openModal,
  promptDialog,
  setButtonBusy,
  toast,
} from './ui.js';
import {
  downloadText,
  escapeHtml,
  formatBytes,
  formatDate,
  formatRelative,
  friendlyErrorMessage,
  nowIso,
  pluralize,
  safeJsonParse,
  sanitizeFileName,
} from './utils.js';
import { APP_NAME, APP_VERSION } from './settings.js';

const LAST_BACKUP_KEY = 'lastBackupAt';
const LAST_RESTORE_KEY = 'lastRestoreAt';

export async function getBackupStatus(settings = null) {
  const lastBackupAt = await getMetadata(LAST_BACKUP_KEY).catch(() => null);
  const days = settings?.general?.backupReminderDays ?? 14;
  const last = lastBackupAt ? new Date(lastBackupAt).getTime() : 0;
  const ageDays = last ? (Date.now() - last) / 86_400_000 : Infinity;
  return {
    lastBackupAt,
    ageDays,
    due: ageDays >= days,
    never: !lastBackupAt,
    reminderDays: days,
  };
}

function backupFileName() {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return sanitizeFileName(`advanced-teleprompter-backup-${stamp}.json`, 'backup.json');
}

/**
 * Builds and downloads a complete, versioned backup. Only reports success
 * after the download has been handed to the browser and metadata persisted.
 */
export async function downloadBackup({ includeRevisions = true, includeTrash = true, settingsStore = null } = {}) {
  if (settingsStore) {
    try {
      await settingsStore.saveNow();
    } catch {
      // The backup still includes the last durable settings record.
    }
  }
  const data = await exportAllData({ includeDeleted: includeTrash, includeRevisions });
  const backup = createBackupObject(data, { includeRevisions, appVersion: APP_VERSION });
  const text = serializeBackup(backup, { pretty: true });
  const fileName = backupFileName();
  downloadText(text, fileName, 'application/json;charset=utf-8');
  const exportedAt = backup.exportedAt;
  await setMetadata(LAST_BACKUP_KEY, exportedAt);
  await setMetadata('lastBackupSummary', backup.summary);
  return {
    fileName,
    bytes: new Blob([text]).size,
    summary: {
      ...backup.summary,
      words: data.scripts.reduce((sum, script) => sum + (script.wordCount || 0), 0),
    },
    exportedAt,
  };
}

export function openBackupDialog({ settingsStore = null, onBackup = null } = {}) {
  const modal = openModal({
    title: 'Download a complete backup',
    description: 'A versioned JSON file containing scripts, folders, tags, presets, settings, and optional revision history.',
    icon: 'database',
    size: 'md',
  });
  let includeRevisions = true;
  let includeTrash = true;
  let busy = false;

  const body = h('div', { class: 'stack', style: { gap: '14px' } });
  const summary = h('div', { class: 'card card--flat' });
  const summaryBody = h('div', { class: 'card__body' });
  summaryBody.append(h('div', { class: 'loading-block', html: '<span class="spinner"></span><span>Measuring local data…</span>' }));
  summary.append(summaryBody);
  body.append(summary);

  const options = h('div', { class: 'settings-card', style: { margin: '0' } });
  const optionsBody = h('div', { class: 'settings-card__body' });
  optionsBody.append(
    createSwitch({
      checked: includeRevisions,
      label: 'Include revision history',
      description: 'Revision history makes the backup larger but allows recovering earlier drafts.',
      onChange: (checked) => {
        includeRevisions = checked;
      },
    }),
    createSwitch({
      checked: includeTrash,
      label: 'Include scripts in trash',
      description: 'Keep deleted scripts recoverable from the backup.',
      onChange: (checked) => {
        includeTrash = checked;
      },
    }),
  );
  options.append(optionsBody);
  body.append(options);

  const note = h('div', { class: 'field-hint' });
  note.textContent =
    'The file is generated entirely on this device. It is not uploaded anywhere. Store it somewhere you can access if this browser data is cleared.';
  body.append(note);
  modal.body.append(body);

  const footer = h('div', { class: 'btn-row' });
  const cancel = button('Cancel', { variant: 'ghost', onClick: () => modal.close() });
  const download = button('Download backup', { iconName: 'download', variant: 'primary' });
  footer.append(cancel, download);
  modal.footer.append(footer);

  exportAllData({ includeDeleted: true, includeRevisions: true })
    .then((data) => {
      const words = data.scripts.reduce((sum, script) => sum + (script.wordCount || 0), 0);
      summaryBody.replaceChildren();
      summaryBody.append(
        h('div', { class: 'section-head', style: { marginBottom: '8px' } }, h('h2', { text: 'Ready to export' })),
      );
      const stats = h('div', { class: 'storage-grid' });
      const entries = [
        [data.scripts.filter((script) => !script.deletedAt).length.toLocaleString(), 'Active scripts'],
        [data.scripts.filter((script) => script.deletedAt).length.toLocaleString(), 'In trash'],
        [data.folders.length.toLocaleString(), 'Folders'],
        [data.presets.length.toLocaleString(), 'Presets'],
        [data.revisions.length.toLocaleString(), 'Revisions'],
        [words.toLocaleString(), 'Words'],
      ];
      for (const [value, label] of entries) {
        const box = h('div', { class: 'storage-box' });
        box.append(h('strong', { text: value }), h('span', { text: label }));
        stats.append(box);
      }
      summaryBody.append(stats);
    })
    .catch((error) => {
      summaryBody.replaceChildren();
      summaryBody.append(h('div', { class: 'field-error', text: friendlyErrorMessage(error, 'The data could not be measured.') }));
    });

  download.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    setButtonBusy(download, true, 'Preparing backup…');
    try {
      const result = await downloadBackup({ includeRevisions, includeTrash, settingsStore });
      toast(`Backup saved as ${result.fileName} (${formatBytes(result.bytes)}).`, {
        type: 'success',
        title: 'Backup downloaded',
      });
      modal.close(result);
      onBackup?.(result);
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The backup could not be created.'), { type: 'error', title: 'Backup failed' });
      setButtonBusy(download, false);
      busy = false;
    }
  });

  return modal;
}

function restoreStat(value, label) {
  const box = h('div', { class: 'restore-stat' });
  box.append(h('div', { class: 'restore-stat__value', text: String(value) }), h('div', { class: 'restore-stat__label', text: label }));
  return box;
}

function uniquePresetName(name, used) {
  const base = normalizePresetName(name) || 'Imported preset';
  let candidate = base;
  let counter = 2;
  while (used.has(candidate.toLocaleLowerCase())) {
    candidate = `${base} (${counter})`;
    counter += 1;
  }
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

/**
 * Restore wizard. Validates before writing and never starts a replace without
 * explicit confirmation. A downloadable safety backup is offered by default.
 */
export function openRestoreDialog({ onRestored = null } = {}) {
  const modal = openModal({
    title: 'Restore a backup',
    description: 'Choose an Advanced Teleprompter Studio backup file. Nothing is written until you review and confirm.',
    icon: 'history',
    size: 'lg',
    closeOnBackdrop: false,
  });
  const stage = h('div');
  modal.body.append(stage);
  renderChooseFile();

  function setFooter(nodes) {
    modal.footer.replaceChildren();
    modal.footer.hidden = !nodes?.length;
    if (nodes?.length) modal.footer.append(...nodes);
  }

  function renderChooseFile() {
    setFooter([button('Cancel', { variant: 'ghost', onClick: () => modal.close() })]);
    stage.replaceChildren();
    const drop = h('div', { class: 'import-drop', role: 'button', tabindex: '0' });
    const iconBox = h('div', { class: 'import-drop__icon' });
    iconBox.append(iconSpan('database', { size: 24 }));
    drop.append(
      iconBox,
      h('h3', { text: 'Select a backup file' }),
      h('p', { text: `Versioned .json backups up to ${formatBytes(MAX_BACKUP_BYTES)}. Backups from newer schema versions are rejected safely.` }),
    );
    const input = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    const openPicker = () => input.click();
    drop.addEventListener('click', openPicker);
    drop.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openPicker();
      }
    });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) handleFile(file);
    });
    stage.append(drop, input);
  }

  async function handleFile(file) {
    if (file.size > MAX_BACKUP_BYTES) {
      toast(`This backup is ${formatBytes(file.size)}; the maximum safe size is ${formatBytes(MAX_BACKUP_BYTES)}.`, {
        type: 'error',
        title: 'Backup too large',
      });
      return;
    }
    stage.replaceChildren(h('div', { class: 'loading-block', html: '<span class="spinner"></span><span>Validating backup without writing anything…</span>' }));
    setFooter([]);
    let backup;
    try {
      const text = await file.text();
      const parsed = safeJsonParse(text);
      if (!parsed.ok) {
        throw new Error('This file is not valid JSON. Select the original backup file without editing it.');
      }
      backup = await validateBackup(parsed.value);
    } catch (error) {
      stage.replaceChildren();
      const box = h('div', { class: 'card', style: { borderColor: 'rgba(251,113,133,.3)' } });
      const body = h('div', { class: 'card__body' });
      body.append(
        h('h2', { style: { margin: '0 0 6px', fontSize: '14px' }, text: 'This backup cannot be restored' }),
        h('p', { class: 'muted', style: { margin: '0', fontSize: '12px', lineHeight: '1.6' }, text: friendlyErrorMessage(error) }),
      );
      if (error?.details?.length) {
        const list = h('ul', { class: 'confirm-list' });
        for (const detail of error.details) list.append(h('li', { text: detail }));
        body.append(list);
      }
      box.append(body);
      stage.append(box);
      setFooter([
        button('Choose another file', { iconName: 'upload', onClick: renderChooseFile }),
        button('Close', { variant: 'ghost', onClick: () => modal.close() }),
      ]);
      return;
    }
    renderSummary(backup, file);
  }

  function renderSummary(backup, file) {
    const summary = backup.summary;
    stage.replaceChildren();
    modal.setTitle('Review the backup');
    const intro = h('div', { class: 'card card--flat' });
    const introBody = h('div', { class: 'card__body' });
    introBody.append(
      h('div', { class: 'section-head', style: { marginBottom: '4px' } },
        h('h2', { text: file.name }),
        badge(formatBytes(file.size), 'accent'),
      ),
      h('p', { class: 'muted', style: { margin: '0', fontSize: '12px' }, text: backupSummaryText(summary) }),
      h('p', { class: 'field-hint', style: { marginTop: '6px' }, text: `Exported ${formatDate(backup.exportedAt, { dateStyle: 'medium', timeStyle: 'short' })} with app version ${summary.appVersion || 'unknown'}.` }),
    );
    intro.append(introBody);
    stage.append(intro);

    const stats = h('div', { class: 'restore-summary' });
    stats.append(
      restoreStat(summary.scripts.toLocaleString(), 'Scripts'),
      restoreStat(summary.folders.toLocaleString(), 'Folders'),
      restoreStat(summary.presets.toLocaleString(), 'Presets'),
      restoreStat(summary.revisions.toLocaleString(), 'Revisions'),
    );
    stage.append(stats);
    if (summary.trashedScripts) {
      stage.append(h('div', { class: 'field-hint', text: `${pluralize(summary.trashedScripts, 'script')} in this backup are in the trash.` }));
    }

    let mode = 'merge';
    let includeFolders = true;
    let includePresets = true;
    let includeSettings = Boolean(backup.data.settings);
    let safetyBackup = true;

    const modeField = h('div', { class: 'field' });
    modeField.append(h('div', { class: 'label', text: 'Restore behavior' }));
    const modeChoices = h('div', { class: 'stack', style: { gap: '8px' } });
    const mergeLabel = h('label', { class: 'checkbox' });
    const mergeRadio = h('input', { type: 'radio', name: 'restore-mode', value: 'merge', checked: true });
    mergeLabel.append(mergeRadio, h('span', {}, h('strong', { text: 'Merge (recommended)' }), h('span', { class: 'switch__desc', text: 'Adds missing records. Existing scripts are never overwritten; conflicting scripts are imported as renamed copies.' })));
    const replaceLabel = h('label', { class: 'checkbox' });
    const replaceRadio = h('input', { type: 'radio', name: 'restore-mode', value: 'replace' });
    replaceLabel.append(replaceRadio, h('span', {}, h('strong', { text: 'Replace the entire local library' }), h('span', { class: 'switch__desc', text: 'Deletes current scripts, folders, revisions, and optionally presets/settings before restoring. Requires confirmation.' })));
    modeChoices.append(mergeLabel, replaceLabel);
    modeField.append(modeChoices);
    stage.append(modeField);

    const optionsCard = h('div', { class: 'settings-card', style: { margin: '14px 0 0' } });
    const optionsHead = h('div', { class: 'settings-card__head' });
    optionsHead.append(h('h2', { text: 'Include from backup' }));
    const optionsBody = h('div', { class: 'settings-card__body' });
    optionsBody.append(
      createSwitch({
        checked: includeFolders,
        label: 'Folders',
        description: 'When unchecked, restored scripts are placed in Unfiled.',
        onChange: (checked) => {
          includeFolders = checked;
        },
      }),
      createSwitch({
        checked: includePresets,
        label: 'Presets',
        description: 'User presets from the backup are merged without replacing built-in presets.',
        onChange: (checked) => {
          includePresets = checked;
        },
      }),
    );
    const settingsSwitch = createSwitch({
      checked: includeSettings,
      label: 'Reader and app settings',
      description: 'Only applied in Replace mode. Merge mode never changes your current preferences.',
      onChange: (checked) => {
        includeSettings = checked;
      },
    });
    const settingsRow = h('div');
    settingsRow.append(settingsSwitch);
    optionsBody.append(settingsRow);
    optionsCard.append(optionsHead, optionsBody);
    stage.append(optionsCard);

    const safety = createSwitch({
      checked: safetyBackup,
      label: 'Download a safety backup before replacing',
      description: 'Strongly recommended. Existing data is preserved in a download even if you later change your mind.',
      onChange: (checked) => {
        safetyBackup = checked;
      },
    });
    const safetyWrap = h('div', { style: { marginTop: '14px' } });
    safetyWrap.append(safety);
    stage.append(safetyWrap);

    const updateModes = () => {
      const replacing = replaceRadio.checked;
      mode = replacing ? 'replace' : 'merge';
      settingsSwitch.querySelector('input').disabled = !replacing;
      safetyWrap.style.display = replacing ? '' : 'none';
    };
    mergeRadio.addEventListener('change', updateModes);
    replaceRadio.addEventListener('change', updateModes);
    updateModes();

    const warning = h('div', { class: 'backup-banner', style: { marginTop: '14px' } });
    warning.append(iconSpan('warning', { size: 16 }), h('span', { text: 'Restore writes in a single database transaction after validation. If the write fails, the existing library is left unchanged where the browser supports transaction rollback.' }));
    stage.append(warning);

    const back = button('Back', { iconName: 'arrowLeft', variant: 'ghost', onClick: renderChooseFile });
    const restore = button('Restore now', { iconName: 'restart', variant: 'primary' });
    setFooter([back, restore]);

    restore.addEventListener('click', async () => {
      if (mode === 'replace') {
        const confirmed = await confirmDialog({
          title: 'Replace the entire library?',
          message: 'This removes the current scripts, folders, and revisions before restoring the backup.',
          confirmLabel: 'Replace library',
          danger: true,
          details: [
            `Backup: ${pluralize(summary.scripts, 'script')}, ${pluralize(summary.folders, 'folder')}`,
            safetyBackup ? 'A safety backup will download before the replace begins.' : 'No safety backup will be downloaded.',
            'This action is not reversible unless you have a backup.',
          ],
        });
        if (!confirmed) return;
      }
      setButtonBusy(restore, true, 'Restoring…');
      back.disabled = true;
      try {
        if (mode === 'replace' && safetyBackup) {
          await downloadBackup({ includeRevisions: true, includeTrash: true });
        }
        if (mode === 'merge') {
          const existing = await exportAllData({ includeDeleted: true, includeRevisions: true });
          const plan = planMerge(existing, backup.data, { includeFolders, includePresets });
          if (!plan.scripts.length && !plan.folders.length && !plan.presets.length) {
            toast('Every script in this backup already exists locally. Nothing needed to be imported.', {
              type: 'info',
              title: 'Already up to date',
            });
            modal.close({ mode, stats: plan.stats });
            onRestored?.(plan.stats);
            return;
          }
          await putImportedData(plan);
          await setMetadata(LAST_RESTORE_KEY, nowIso());
          toast(
            `Added ${pluralize(plan.stats.scriptsAdded, 'script')}, ${pluralize(plan.stats.scriptsRenamed, 'conflict copy', 'conflict copies')}, and ${pluralize(plan.foldersAdded, 'folder')}. Existing data was not overwritten.`,
            { type: 'success', title: 'Backup merged' },
          );
          modal.close({ mode, stats: plan.stats });
          onRestored?.(plan.stats);
        } else {
          const plan = planReplace(backup.data, { includeFolders, includePresets });
          await replaceAllData(
            {
              scripts: plan.scripts,
              folders: plan.folders,
              presets: plan.presets,
              revisions: plan.revisions,
              settings: includeSettings ? backup.data.settings : null,
            },
            { includeSettings: includeSettings && Boolean(backup.data.settings), includeFolders, includePresets },
          );
          await setMetadata(LAST_RESTORE_KEY, nowIso());
          toast(`Restored ${pluralize(plan.stats.scriptsAdded, 'script')}, ${pluralize(plan.stats.foldersAdded, 'folder')}, and ${pluralize(plan.stats.presetsAdded, 'preset')}.`, {
            type: 'success',
            title: 'Library replaced',
          });
          modal.close({ mode, stats: plan.stats });
          onRestored?.(plan.stats, { settingsRestored: includeSettings && Boolean(backup.data.settings) });
        }
      } catch (error) {
        toast(friendlyErrorMessage(error, 'The backup could not be restored.'), { type: 'error', title: 'Restore failed' });
        setButtonBusy(restore, false);
        back.disabled = false;
      }
    });
  }

  return modal;
}

export function exportPresetFile(preset) {
  const text = JSON.stringify(serializePreset(preset), null, 2);
  const fileName = presetFileName(preset);
  downloadText(text, fileName, 'application/json;charset=utf-8');
  toast(`Preset saved as ${fileName}.`, { type: 'success', title: 'Preset exported' });
  return fileName;
}

const MAX_PRESET_FILE_BYTES = 2 * 1024 * 1024;

export async function importPresetFile(file, { onImported = null } = {}) {
  if (!file) return null;
  if (file.size > MAX_PRESET_FILE_BYTES) {
    throw new Error(`Preset files must be smaller than ${formatBytes(MAX_PRESET_FILE_BYTES)}.`);
  }
  const text = await file.text();
  const parsed = safeJsonParse(text);
  if (!parsed.ok) throw new Error('This preset is not valid JSON.');
  const preset = validatePresetImport(parsed.value);
  const existing = await getAllUserPresets();
  const used = new Set(existing.map((item) => normalizePresetName(item.name).toLocaleLowerCase()));
  preset.name = uniquePresetName(preset.name, used);
  preset.updatedAt = nowIso();
  await savePreset(preset);
  toast(`Imported preset "${preset.name}".`, { type: 'success', title: 'Preset imported' });
  onImported?.(preset);
  return preset;
}

export function openPresetImportDialog({ onImported = null } = {}) {
  const input = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  document.body.append(input);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      await importPresetFile(file, { onImported });
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The preset could not be imported.'), { type: 'error', title: 'Preset import failed' });
    }
  });
  input.click();
}

export function openStorageDialog({ onCleared = null } = {}) {
  const modal = openModal({
    title: 'Local storage & data',
    description: 'Everything in the studio is stored in this browser profile. Clearing browser data removes it.',
    icon: 'hardDrive',
    size: 'lg',
  });
  const body = h('div', { class: 'stack', style: { gap: '14px' } });
  const overview = h('div', { class: 'card card--flat' });
  const overviewBody = h('div', { class: 'card__body' });
  overviewBody.append(h('div', { class: 'loading-block', html: '<span class="spinner"></span><span>Reading storage status…</span>' }));
  overview.append(overviewBody);
  body.append(overview);

  const actions = h('div', { class: 'settings-card' });
  const actionsHead = h('div', { class: 'settings-card__head' });
  actionsHead.append(h('h2', { text: 'Backup and recovery' }), h('p', { text: 'Backups are the only recovery path if browser storage is cleared.' }));
  const actionsBody = h('div', { class: 'settings-card__body' });
  const backupButton = button('Download backup', { iconName: 'download', variant: 'primary', onClick: () => openBackupDialog() });
  const restoreButton = button('Restore backup', { iconName: 'history', onClick: () => openRestoreDialog() });
  actionsBody.append(h('div', { class: 'settings-actions' }, backupButton, restoreButton));
  actions.append(actionsHead, actionsBody);
  body.append(actions);

  const danger = h('div', { class: 'settings-card danger-zone' });
  const dangerHead = h('div', { class: 'settings-card__head' });
  dangerHead.append(h('h2', { text: 'Danger zone' }), h('p', { text: 'Permanently delete scripts, folders, presets, revisions, and settings from this browser.' }));
  const dangerBody = h('div', { class: 'settings-card__body' });
  const clearButton = button('Clear all local data', { iconName: 'trash', variant: 'danger' });
  dangerBody.append(clearButton);
  danger.append(dangerHead, dangerBody);
  body.append(danger);
  modal.body.append(body);

  const footer = h('div', { class: 'btn-row' });
  footer.append(button('Close', { variant: 'ghost', onClick: () => modal.close() }));
  modal.footer.append(footer);

  Promise.all([getStorageEstimate(), isStoragePersisted(), exportAllData({ includeDeleted: true, includeRevisions: true }), getMetadata(LAST_BACKUP_KEY)])
    .then(([estimate, persisted, data, lastBackupAt]) => {
      overviewBody.replaceChildren();
      const top = h('div', { class: 'storage-card__top' });
      top.append(h('span', { text: 'Browser storage' }), badge(persisted ? 'Persistent' : 'Best effort', persisted ? 'success' : 'warning'));
      overviewBody.append(top);
      if (estimate) {
        const meter = h('div', { class: 'storage-meter' });
        const fill = h('div', { class: 'storage-meter__fill', style: { width: `${Math.min(100, Math.max(0.5, estimate.percent)).toFixed(2)}%` } });
        meter.append(fill);
        overviewBody.append(meter);
        overviewBody.append(h('div', { class: 'field-hint', text: `${formatBytes(estimate.usage)} used of ~${formatBytes(estimate.quota)} available (${estimate.percent.toFixed(1)}%).` }));
      } else {
        overviewBody.append(h('div', { class: 'field-hint', text: 'This browser does not expose a storage estimate.' }));
      }
      const grid = h('div', { class: 'storage-grid', style: { marginTop: '12px' } });
      const entries = [
        [String(data.scripts.filter((script) => !script.deletedAt).length), 'Active scripts'],
        [String(data.scripts.filter((script) => script.deletedAt).length), 'In trash'],
        [String(data.folders.length), 'Folders'],
        [String(data.revisions.length), 'Revisions'],
        [lastBackupAt ? formatRelative(lastBackupAt) : 'Never', 'Last backup'],
        [persisted ? 'Protected' : 'May be evicted', 'Persistence'],
      ];
      for (const [value, label] of entries) {
        const box = h('div', { class: 'storage-box' });
        box.append(h('strong', { text: value }), h('span', { text: label }));
        grid.append(box);
      }
      overviewBody.append(grid);

      if (!persisted) {
        const persistButton = button('Request persistent storage', { iconName: 'shield', size: 'sm' });
        persistButton.addEventListener('click', async () => {
          setButtonBusy(persistButton, true, 'Requesting…');
          const granted = await requestPersistentStorage();
          setButtonBusy(persistButton, false);
          toast(granted ? 'The browser granted persistent storage. Your data is less likely to be evicted.' : 'The browser did not grant persistent storage. Regular backups are strongly recommended.', {
            type: granted ? 'success' : 'warning',
            title: granted ? 'Storage protected' : 'Request not granted',
          });
          if (granted) modal.close();
        });
        overviewBody.append(h('div', { class: 'settings-actions', style: { marginTop: '12px' } }, persistButton));
      }
    })
    .catch((error) => {
      overviewBody.replaceChildren(h('div', { class: 'field-error', text: friendlyErrorMessage(error, 'Storage status could not be read.') }));
    });

  clearButton.addEventListener('click', async () => {
    const first = await confirmDialog({
      title: 'Clear all local data?',
      message: 'This deletes every script, folder, preset, revision, and setting stored by the studio in this browser.',
      confirmLabel: 'Continue',
      danger: true,
      details: ['Download a backup first if you may need this data again.', 'This cannot be undone.'],
    });
    if (!first) return;
    const typed = await promptDialog({
      title: 'Confirm permanent deletion',
      label: 'Type DELETE to confirm',
      value: '',
      placeholder: 'DELETE',
      confirmLabel: 'Delete everything',
      validate: (value) => (value === 'DELETE' ? null : 'Type DELETE exactly (uppercase).'),
      iconName: 'warning',
    });
    if (typed !== 'DELETE') return;
    try {
      await clearAllData({ keepSettings: false });
      toast('All local data was cleared.', { type: 'success', title: 'Data cleared' });
      modal.close({ cleared: true });
      onCleared?.();
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The data could not be cleared.'), { type: 'error', title: 'Clear failed' });
    }
  });

  return modal;
}

export function backupBannerText(status) {
  if (status.never) return 'You have not downloaded a backup yet. Your scripts live only in this browser.';
  if (status.due) {
    return `Your last backup was ${formatRelative(status.lastBackupAt)}. Download a fresh backup to keep your scripts recoverable.`;
  }
  return `Last backup ${formatRelative(status.lastBackupAt)}. Local data is backed up.`;
}

export function renderBackupBanner(status, { onBackup = null, compact = false } = {}) {
  const okay = !status.due && !status.never;
  const banner = h('div', { class: `backup-banner${okay ? ' backup-banner--ok' : ''}` });
  banner.append(iconSpan(okay ? 'shield' : 'warning', { size: 17 }));
  const content = h('div', { style: { flex: '1', minWidth: '0' } });
  content.append(h('div', { text: backupBannerText(status) }));
  if (!compact) {
    content.append(
      h('div', { class: 'field-hint', style: { marginTop: '3px', color: 'inherit', opacity: '0.8' }, text: 'Backups include scripts, folders, presets, settings, and revisions.' }),
    );
  }
  banner.append(content);
  if (onBackup) {
    const action = button('Back up now', {
      iconName: 'download',
      size: 'sm',
      onClick: onBackup,
    });
    action.style.alignSelf = 'center';
    banner.append(action);
  }
  return banner;
}

export function emptyBackupStatus() {
  return { lastBackupAt: null, ageDays: Infinity, due: true, never: true, reminderDays: 14 };
}

export { APP_NAME, APP_VERSION, escapeHtml };
