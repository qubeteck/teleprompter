import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_SETTINGS,
  END_BEHAVIOR_OPTIONS,
  FONT_FAMILY_OPTIONS,
  MIRROR_OPTIONS,
  OCR_LANGUAGES,
  READER_THEMES,
  TEXT_ALIGN_OPTIONS,
  getFontStack,
  getThemePalette,
  resolveReaderColors,
} from '../settings.js';
import {
  deletePreset,
  getAllFolders,
  getAllScripts,
  getAllUserPresets,
  getStorageEstimate,
  isStoragePersisted,
  loadSettingsRecord,
  requestPersistentStorage,
  savePreset,
} from '../database.js';
import {
  BUILT_IN_PRESETS,
  applyPreset,
  createUserPreset,
  normalizePresetName,
} from '../presets.js';
import {
  exportPresetFile,
  getBackupStatus,
  openBackupDialog,
  openPresetImportDialog,
  openRestoreDialog,
  openStorageDialog,
} from '../backup-manager.js';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  displayShortcut,
  getShortcutMap,
  shortcutFromEvent,
} from '../keyboard-shortcuts.js';
import {
  RECORDING_QUALITIES,
  describeMime,
  getSupportedMimeTypes,
  isCameraRecordingSupported,
} from '../camera-recorder.js';
import {
  badge,
  button,
  confirmDialog,
  createColorInput,
  createRange,
  createSelect,
  createSwitch,
  createTextInput,
  createTextarea,
  h,
  iconButton,
  iconSpan,
  openMenu,
  openModal,
  setButtonBusy,
  shortcutConflict,
  toast,
} from '../ui.js';
import {
  clamp,
  contrastRatio,
  deepClone,
  formatBytes,
  formatRelative,
  friendlyErrorMessage,
  nowIso,
  supportsFeature,
} from '../utils.js';

const SECTION_ORDER = Object.freeze([
  { id: 'general', label: 'General', icon: 'sliders' },
  { id: 'editor', label: 'Editor', icon: 'type' },
  { id: 'reader', label: 'Reader', icon: 'monitorPlay' },
  { id: 'presets', label: 'Presets', icon: 'sparkles' },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard' },
  { id: 'data', label: 'Data & backup', icon: 'database' },
  { id: 'recording', label: 'Recording', icon: 'camera' },
  { id: 'about', label: 'About', icon: 'info' },
]);

const SECTION_IDS = new Set(SECTION_ORDER.map((section) => section.id));

function normalizeSectionId(value) {
  const raw = String(value || '').trim().toLowerCase();
  const aliases = {
    backup: 'data',
    import: 'data',
    storage: 'data',
    preview: 'reader',
    record: 'recording',
    camera: 'recording',
    keyboard: 'shortcuts',
  };
  const id = aliases[raw] || raw;
  return SECTION_IDS.has(id) ? id : 'general';
}

function settingsSection({ id, icon, title, description, actions = [] }) {
  const headingId = `settings-${id}-title`;
  const head = h('div', { class: 'settings-section__head' });
  const iconBox = h('div', { class: 'settings-section__icon' });
  iconBox.append(iconSpan(icon, { size: 18 }));
  const copy = h('div', { class: 'settings-section__copy' });
  const heading = h('h2', { id: headingId, tabindex: '-1', text: title });
  copy.append(heading, h('p', { text: description }));
  head.append(iconBox, copy);
  if (actions.length) head.append(h('div', { class: 'settings-section__actions' }, ...actions));
  const element = h('section', {
    class: 'settings-section',
    id: `settings-${id}`,
    'data-section': id,
    'data-active': 'false',
    'aria-labelledby': headingId,
  });
  element.append(head);
  element.heading = heading;
  return element;
}

function settingsCard(title, description, ...children) {
  const card = h('div', { class: 'settings-card' });
  const head = h('div', { class: 'settings-card__head' });
  head.append(h('h2', { text: title }));
  if (description) head.append(h('p', { text: description }));
  const body = h('div', { class: 'settings-card__body' });
  body.append(...children.flat(Infinity).filter((child) => child != null && child !== false));
  card.append(head, body);
  return card;
}

async function resetSettingsSection(store, section, label) {
  const confirmed = await confirmDialog({
    title: `Reset ${label} settings?`,
    message: 'The current values in this section return to their defaults. Scripts, presets, and other settings sections are not changed.',
    confirmLabel: 'Reset defaults',
    iconName: 'refresh',
  });
  if (!confirmed) return false;
  store.resetSection(section);
  toast(`${label.charAt(0).toUpperCase()}${label.slice(1)} settings reset to defaults.`, { type: 'success' });
  return true;
}

function buildSaveBar({ store, onResetAll }) {
  const dot = h('span', { class: 'settings-savebar__dot', 'aria-hidden': 'true' });
  const text = h('div', { class: 'settings-savebar__text' });
  const status = h('div', { class: 'settings-savebar__status', role: 'status', 'aria-live': 'polite' }, dot, text);
  const saveNow = button('Save now', { iconName: 'save', size: 'sm' });
  const resetAll = button('Reset all settings', { iconName: 'restart', size: 'sm', variant: 'ghost', onClick: onResetAll });
  const element = h(
    'div',
    { class: 'settings-savebar' },
    status,
    h('div', { class: 'settings-savebar__actions' }, saveNow, resetAll),
  );

  function update() {
    const error = store.getLastError();
    if (error) {
      element.dataset.state = 'error';
      text.textContent = `Settings could not be saved. ${friendlyErrorMessage(error)}`;
      return;
    }
    if (store.isDirty) {
      element.dataset.state = 'pending';
      text.textContent = 'Saving changes to this browser...';
      return;
    }
    element.dataset.state = 'saved';
    text.textContent = 'All settings are saved in this browser.';
  }

  saveNow.addEventListener('click', async () => {
    setButtonBusy(saveNow, true, 'Saving...');
    try {
      await store.saveNow();
      toast('Settings are saved in this browser.', { type: 'success', title: 'Settings saved' });
    } catch (error) {
      toast(friendlyErrorMessage(error, 'Settings could not be saved.'), { type: 'error', title: 'Save failed' });
    } finally {
      setButtonBusy(saveNow, false);
      update();
    }
  });

  return { element, update };
}

function createControlHelpers(store, syncers) {
  function updateSection(section, key, value) {
    store.update({ [section]: { [key]: value } });
  }

  function registerSync(listener) {
    syncers.add(listener);
    return () => syncers.delete(listener);
  }

  function settingSwitch({ section, key, label, description, onChange }) {
    const checked = Boolean(store.get()[section]?.[key]);
    const element = createSwitch({
      checked,
      label,
      description,
      onChange: (value) => {
        updateSection(section, key, value);
        onChange?.(value);
      },
    });
    const input = element.querySelector('input');
    registerSync((settings) => {
      if (document.activeElement !== input) input.checked = Boolean(settings[section]?.[key]);
    });
    return element;
  }

  function settingSelect({ section, key, label, options, help, onChange }) {
    const value = store.get()[section]?.[key];
    const element = createSelect({
      label,
      value,
      options,
      help,
      onChange: (next) => {
        updateSection(section, key, next);
        onChange?.(next);
      },
    });
    const input = element.querySelector('select');
    registerSync((settings) => {
      if (document.activeElement === input) return;
      const next = settings[section]?.[key];
      if (next != null && input.value !== String(next)) input.value = String(next);
    });
    return element;
  }

  function settingRange({ section, key, label, min, max, step = 1, suffix = '', format, help, onChange }) {
    const options = store.get()[section] || {};
    const value = Number(options[key]);
    const formatter = typeof format === 'function' ? format : (current) => `${current}${suffix}`;
    const element = createRange({
      label,
      value,
      min,
      max,
      step,
      format: formatter,
      help,
      onChange: (next) => {
        updateSection(section, key, next);
        onChange?.(next);
      },
    });
    const input = element.querySelector('input[type="range"]');
    const output = element.querySelector('.label__value');
    registerSync((settings) => {
      const next = Number(settings[section]?.[key]);
      if (!Number.isFinite(next)) return;
      if (document.activeElement !== input) input.value = String(next);
      if (output) output.textContent = formatter(next);
    });
    return element;
  }

  function settingColor({ section, key, label, help }) {
    const value = store.get()[section]?.[key];
    const element = createColorInput({
      label,
      value,
      onChange: (next) => updateSection(section, key, next),
    });
    const colorInput = element.querySelector('input[type="color"]');
    const textInput = element.querySelector('input[type="text"]');
    if (help) element.append(h('div', { class: 'field-hint', text: help }));
    registerSync((settings) => {
      const next = settings[section]?.[key];
      if (!next) return;
      if (document.activeElement !== colorInput) colorInput.value = next;
      if (document.activeElement !== textInput) textInput.value = next;
    });
    return element;
  }

  return { settingSwitch, settingSelect, settingRange, settingColor, registerSync };
}

/* ============================================================
   Reader preview
   ============================================================ */

function buildReaderPreview(store) {
  const stage = h('div', { class: 'reader-preview__stage' });
  const fadeTop = h('div', { class: 'reader-preview__fade reader-preview__fade--top', 'aria-hidden': 'true' });
  const fadeBottom = h('div', { class: 'reader-preview__fade reader-preview__fade--bottom', 'aria-hidden': 'true' });
  const mirror = h('div', { class: 'reader-preview__mirror' });
  const content = h('div', { class: 'reader-preview__content' });
  content.append(
    h('p', { class: 'reader-preview__cue', text: 'Live sample' }),
    h('p', { text: 'Clear words, at a calm pace. Your voice leads the way.' }),
    h('p', { text: 'Type, color, spacing, alignment, mirroring, and focus aids update here as you adjust them.' }),
    h('p', { class: 'reader-preview__last', text: 'The next line is always ready.' }),
  );
  mirror.append(content);
  const focusLine = h('div', { class: 'reader-preview__focus', 'aria-hidden': 'true' });
  stage.append(fadeTop, mirror, focusLine, fadeBottom);

  const themeBadge = badge('Midnight', 'accent');
  const speedBadge = badge('140 WPM');
  const mirrorBadge = badge('Normal');
  const meta = h('div', { class: 'reader-preview__meta' }, themeBadge, speedBadge, mirrorBadge);
  const direction = h('div', { class: 'field-hint' });
  const preview = h('div', { class: 'reader-preview', 'aria-label': 'Live preview of the teleprompter style' }, stage);
  const card = settingsCard(
    'Live preview',
    'Typography, color, spacing, mirroring, and focus aids change instantly.',
    preview,
    meta,
    direction,
  );
  card.classList.add('reader-preview-card');

  const mirrorLabels = Object.fromEntries(MIRROR_OPTIONS.map((option) => [option.value, option.label]));

  function update(settings) {
    const reader = settings.reader;
    const colors = resolveReaderColors(reader);
    const palette = getThemePalette(reader.theme);
    preview.style.setProperty('--preview-bg', colors.bg);
    preview.style.setProperty('--preview-text', colors.text);
    preview.style.setProperty('--preview-accent', colors.accent);
    preview.style.setProperty('--preview-font', getFontStack(reader.fontFamily));
    preview.style.setProperty('--preview-size', `${clamp(reader.fontSize * 0.34, 12, 32).toFixed(1)}px`);
    preview.style.setProperty('--preview-weight', String(reader.fontWeight));
    preview.style.setProperty('--preview-line', String(reader.lineHeight));
    preview.style.setProperty('--preview-letter', `${reader.letterSpacing}em`);
    preview.style.setProperty('--preview-align', reader.textAlign);
    preview.style.setProperty('--preview-width', `${Math.round(reader.maxWidth * 0.64)}px`);
    preview.style.setProperty('--preview-inset', `${reader.horizontalMargin * 2}%`);
    preview.style.setProperty('--preview-para', String(reader.paragraphSpacing));
    preview.style.setProperty('--preview-focus', `${reader.verticalPosition}%`);
    preview.dataset.theme = reader.theme;
    stage.dataset.mirror = reader.mirror;
    stage.dataset.focusFade = String(Boolean(reader.focusFade));
    stage.dataset.focusLine = String(Boolean(reader.focusLine));
    themeBadge.textContent = palette.name;
    speedBadge.textContent = `${reader.speed} WPM - ${reader.direction === 'reverse' ? 'reverse' : 'forward'}`;
    mirrorBadge.textContent = mirrorLabels[reader.mirror] || 'Normal';
    direction.textContent = reader.direction === 'reverse'
      ? 'Reverse mode starts at the end of the script and scrolls upward. Displayed progress still runs from 0 to 100%.'
      : 'Playback opens in the full reader with progress, timers, and shortcuts.';
  }

  update(store.get());
  return { element: card, update };
}

/* ============================================================
   General and editor
   ============================================================ */

function buildGeneralSection({ store, controls }) {
  const element = settingsSection({
    id: 'general',
    icon: 'sliders',
    title: 'General',
    description: 'Studio-wide behavior and the reminders that keep your local library recoverable.',
    actions: [
      button('Reset general', { iconName: 'restart', size: 'sm', onClick: () => resetSettingsSection(store, 'general', 'general') }),
    ],
  });

  element.append(
    settingsCard(
      'Workspace behavior',
      'These choices apply across the library and editor.',
      controls.settingSwitch({
        section: 'general',
        key: 'revisionHistory',
        label: 'Keep revision history',
        description: 'Store earlier drafts while editing so an accidental change can be reviewed or recovered. Uses additional local storage.',
      }),
      controls.settingSwitch({
        section: 'general',
        key: 'confirmDelete',
        label: 'Ask before deleting',
        description: 'Show a confirmation before moving scripts to the trash or removing folders.',
      }),
      controls.settingSwitch({
        section: 'general',
        key: 'showWordStats',
        label: 'Show writing statistics',
        description: 'Display word, character, paragraph, and reading-time estimates in the editor and library.',
      }),
      h('div', { class: 'form-grid' },
        controls.settingSelect({
          section: 'general',
          key: 'clock',
          label: 'Clock format',
          options: [
            { value: '24h', label: '24-hour (14:30)' },
            { value: '12h', label: '12-hour (2:30 PM)' },
          ],
          help: 'Used where activity times are shown.',
        }),
        controls.settingRange({
          section: 'general',
          key: 'backupReminderDays',
          label: 'Backup reminder',
          min: 1,
          max: 90,
          step: 1,
          format: (value) => `${value} ${value === 1 ? 'day' : 'days'}`,
          help: 'The studio marks a backup as due after this many days. Reminders never upload anything.',
        }),
      ),
    ),
    settingsCard(
      'Local-only by design',
      'There is no account, server, or cloud sync.',
      h('p', {
        class: 'muted',
        style: { margin: '0', fontSize: '12px', lineHeight: '1.65' },
        text: 'Scripts, folders, presets, revisions, and settings live in this browser profile. Clearing site data, using a private window, or browser eviction can remove them. Download a backup from Data & backup before changing browsers or clearing storage.',
      }),
    ),
  );

  return element;
}

function buildEditorSection({ store, controls }) {
  const preview = h('div', { class: 'editor-preview', 'aria-label': 'Editor appearance preview' });
  preview.append(
    h('h3', { text: 'A strong opening line' }),
    h('p', { text: 'The editor keeps your words first. Markdown formatting stays readable, autosave is deliberate, and conflicts are never silently overwritten.' }),
    h('p', { text: 'Short paragraphs are easier to rehearse and easier to read aloud.' }),
    h('ul', {},
      h('li', { text: 'Headings, lists, emphasis, and links render in the reader.' }),
      h('li', { text: 'Plain text remains plain text.' }),
    ),
  );

  function updatePreview(settings) {
    const editor = settings.editor;
    preview.style.fontFamily = getFontStack(editor.fontFamily);
    preview.style.fontSize = `${editor.fontSize}px`;
    preview.style.lineHeight = String(editor.lineHeight);
    preview.style.maxWidth = `${editor.maxWidth}px`;
  }
  controls.registerSync(updatePreview);
  updatePreview(store.get());

  const element = settingsSection({
    id: 'editor',
    icon: 'type',
    title: 'Editor',
    description: 'Shape the writing surface without changing how the reader presents your script.',
    actions: [
      button('Reset editor', { iconName: 'restart', size: 'sm', onClick: () => resetSettingsSection(store, 'editor', 'editor') }),
    ],
  });

  element.append(
    settingsCard(
      'Typography',
      'The editor uses its own type settings, independent from the teleprompter.',
      controls.settingSelect({
        section: 'editor',
        key: 'fontFamily',
        label: 'Writing font',
        options: FONT_FAMILY_OPTIONS,
        help: 'The high-legibility option uses Verdana and an Ethiopic-capable fallback.',
      }),
      h('div', { class: 'form-grid' },
        controls.settingRange({ section: 'editor', key: 'fontSize', label: 'Text size', min: 13, max: 28, step: 1, format: (value) => `${value}px` }),
        controls.settingRange({ section: 'editor', key: 'lineHeight', label: 'Line height', min: 1.3, max: 2.4, step: 0.05, format: (value) => Number(value).toFixed(2) }),
        controls.settingRange({ section: 'editor', key: 'maxWidth', label: 'Text column width', min: 520, max: 1600, step: 20, format: (value) => `${value}px`, help: 'A narrower column is easier to scan while writing.' }),
      ),
    ),
    settingsCard(
      'Writing behavior',
      'Autosave and spellcheck apply the next time the editor opens.',
      controls.settingSwitch({
        section: 'editor',
        key: 'autosave',
        label: 'Autosave edits',
        description: 'Save changes after a short pause. When off, use Save or Ctrl/Cmd+S before leaving.',
      }),
      controls.settingSwitch({
        section: 'editor',
        key: 'spellcheck',
        label: 'Use browser spellcheck',
        description: 'Turn off if the squiggles distract you or if you write in a language the browser handles poorly.',
      }),
    ),
    settingsCard('Preview', 'A sample of the current editor appearance. The real editor also respects your Markdown.', preview),
  );

  return element;
}

/* ============================================================
   Reader
   ============================================================ */

function buildReaderSection({ store, controls }) {
  const preview = buildReaderPreview(store);
  controls.registerSync(preview.update);

  const themeButtons = new Map();
  const themeGrid = h('div', { class: 'theme-options' });
  const backgroundField = controls.settingColor({ section: 'reader', key: 'bgColor', label: 'Background' });
  const textField = controls.settingColor({ section: 'reader', key: 'textColor', label: 'Text' });
  const accentField = controls.settingColor({ section: 'reader', key: 'accentColor', label: 'Accent' });
  const customHint = h('div', { class: 'field-hint' });
  const contrastStatus = h('div', { class: 'contrast-status', role: 'status', 'aria-live': 'polite' });

  function selectTheme(themeId) {
    const palette = getThemePalette(themeId);
    const patch = { theme: themeId };
    if (themeId !== 'custom') {
      patch.bgColor = palette.bg;
      patch.textColor = palette.text;
      patch.accentColor = palette.accent;
    }
    store.setReader(patch);
  }

  for (const theme of READER_THEMES) {
    const swatch = h('div', { class: 'theme-swatch', style: { background: theme.bg, color: theme.text }, text: 'Aa' });
    const themeButton = h('button', {
      type: 'button',
      class: 'theme-option',
      'aria-pressed': 'false',
      title: theme.description,
    }, swatch, h('span', { text: theme.name }));
    themeButton.dataset.themeId = theme.id;
    themeButton.addEventListener('click', () => selectTheme(theme.id));
    themeButtons.set(theme.id, themeButton);
    themeGrid.append(themeButton);
  }

  function syncThemeUi(settings) {
    const reader = settings.reader;
    for (const [id, themeButton] of themeButtons) {
      themeButton.setAttribute('aria-pressed', String(reader.theme === id));
    }
    customHint.textContent = reader.theme === 'custom'
      ? 'The custom theme uses the colors below.'
      : 'Select the Custom theme to use your own colors. Other themes keep their tested palettes.';
    const colors = resolveReaderColors(reader);
    const ratio = contrastRatio(colors.text, colors.bg);
    const level = ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : 'below AA';
    contrastStatus.className = `contrast-status${ratio >= 4.5 ? ' contrast-status--ok' : ' contrast-status--warning'}`;
    contrastStatus.textContent = `Text/background contrast: ${ratio.toFixed(2)}:1 (${level}). ${ratio >= 4.5 ? 'This meets the usual minimum for body text.' : 'Increase contrast for easier reading.'}`;
    const customSwatch = themeButtons.get('custom')?.querySelector('.theme-swatch');
    if (customSwatch) {
      customSwatch.style.background = reader.bgColor;
      customSwatch.style.color = reader.textColor;
    }
  }
  controls.registerSync(syncThemeUi);
  syncThemeUi(store.get());

  const languageField = createTextInput({
    label: 'Speech recognition language',
    value: store.get().reader.voiceLanguage,
    placeholder: 'en-US',
    help: 'Use a BCP 47 language tag. Availability depends on the browser and installed speech service.',
    maxlength: '20',
    onInput: (value) => store.setReader({ voiceLanguage: value.trim() || 'en-US' }),
  });
  const languageError = h('div', { class: 'field-error', hidden: true });
  const speechAvailable = supportsFeature('speech');
  const voiceAvailability = speechAvailable
    ? h('span', { class: 'badge badge--success', text: 'Speech recognition available' })
    : h('span', { class: 'badge badge--warning', text: 'Speech recognition not available in this browser' });

  const element = settingsSection({
    id: 'reader',
    icon: 'monitorPlay',
    title: 'Reader',
    description: 'The teleprompter appearance, pacing, and optional voice behavior. The preview updates as you edit.',
    actions: [
      button('Reset reader', { iconName: 'restart', size: 'sm', onClick: () => resetSettingsSection(store, 'reader', 'reader') }),
    ],
  });

  const themeCard = settingsCard(
    'Theme and color',
    'Themes are tested for readable contrast. Custom colors are always checked.',
    themeGrid,
    contrastStatus,
    h('div', { class: 'form-grid form-grid--3' }, backgroundField, textField, accentField),
    customHint,
  );

  const typographyCard = settingsCard(
    'Typography',
    'Large, calm text is easier to read while speaking.',
    controls.settingSelect({ section: 'reader', key: 'fontFamily', label: 'Font', options: FONT_FAMILY_OPTIONS }),
    h('div', { class: 'form-grid' },
      controls.settingRange({ section: 'reader', key: 'fontSize', label: 'Text size', min: 20, max: 160, step: 1, format: (value) => `${value}px` }),
      controls.settingRange({ section: 'reader', key: 'fontWeight', label: 'Font weight', min: 300, max: 900, step: 50 }),
      controls.settingRange({ section: 'reader', key: 'lineHeight', label: 'Line height', min: 1.1, max: 2.6, step: 0.05, format: (value) => Number(value).toFixed(2) }),
      controls.settingRange({ section: 'reader', key: 'letterSpacing', label: 'Letter spacing', min: -0.05, max: 0.25, step: 0.01, format: (value) => `${Number(value).toFixed(2)}em` }),
      controls.settingRange({ section: 'reader', key: 'paragraphSpacing', label: 'Paragraph spacing', min: 0, max: 3, step: 0.1, format: (value) => `${Number(value).toFixed(1)}em` }),
      controls.settingSelect({ section: 'reader', key: 'textAlign', label: 'Alignment', options: TEXT_ALIGN_OPTIONS }),
    ),
  );

  const playbackCard = settingsCard(
    'Playback and timing',
    'Speed is converted to a pixel rate using the measured script height and word count.',
    h('div', { class: 'form-grid' },
      controls.settingRange({ section: 'reader', key: 'speed', label: 'Reading speed', min: 40, max: 400, step: 2, format: (value) => `${value} WPM` }),
      controls.settingSelect({
        section: 'reader',
        key: 'direction',
        label: 'Direction',
        options: [
          { value: 'forward', label: 'Forward (top to bottom)' },
          { value: 'reverse', label: 'Reverse (starts at end)' },
        ],
      }),
      controls.settingRange({ section: 'reader', key: 'countdownSeconds', label: 'Countdown', min: 0, max: 10, step: 1, format: (value) => `${value}s` }),
      controls.settingSelect({ section: 'reader', key: 'endBehavior', label: 'At the end', options: END_BEHAVIOR_OPTIONS }),
      controls.settingRange({
        section: 'reader',
        key: 'targetDurationMinutes',
        label: 'Target duration',
        min: 0,
        max: 120,
        step: 1,
        format: (value) => (value ? `${value} min` : 'Off'),
        help: 'Shows a target timer. Zero turns the target off.',
      }),
      controls.settingRange({ section: 'reader', key: 'verticalPosition', label: 'Reading line position', min: 15, max: 75, step: 1, format: (value) => `${value}%` }),
    ),
    controls.settingSwitch({ section: 'reader', key: 'countdownEnabled', label: 'Show countdown before starting', description: 'Resuming after a pause starts immediately. Restarting re-arms the countdown.' }),
    controls.settingSwitch({ section: 'reader', key: 'restorePosition', label: 'Restore the last reading position', description: 'Reopen a script where you stopped. Near the end, the reader starts at the top and explains why.' }),
    controls.settingSwitch({ section: 'reader', key: 'pauseOnManualScroll', label: 'Pause while scrolling manually', description: 'Touching the wheel or trackpad pauses playback instead of fighting your position.' }),
  );

  const chromeCard = settingsCard(
    'Chrome and focus aids',
    'Keep attention on the words. Every overlay can be turned off.',
    controls.settingSwitch({ section: 'reader', key: 'autoHideControls', label: 'Auto-hide playback controls', description: 'Controls hide while playing and return when you move the pointer or press C.' }),
    controls.settingSwitch({ section: 'reader', key: 'progressVisible', label: 'Show reading progress', description: 'A thin progress bar at the top of the reader.' }),
    controls.settingSwitch({ section: 'reader', key: 'timerVisible', label: 'Show elapsed and remaining time', description: 'Uses the current speed and target duration.' }),
    controls.settingSwitch({ section: 'reader', key: 'focusFade', label: 'Fade distant lines', description: 'Reduces visual noise above and below the reading line.' }),
    controls.settingSwitch({ section: 'reader', key: 'focusLine', label: 'Show a reading line', description: 'A subtle horizontal guide at the chosen vertical position.' }),
  );

  const voiceCard = settingsCard(
    'Voice following (optional)',
    'Uses the browser speech recognition service. Audio is handled by the browser; the studio does not upload it.',
    h('div', { class: 'settings-actions', style: { justifyContent: 'space-between' } }, voiceAvailability, h('span', { class: 'field-hint', text: 'Reader panel controls start and stop listening.' })),
    languageField,
    languageError,
    controls.settingRange({ section: 'reader', key: 'voiceSensitivity', label: 'Match sensitivity', min: 0.1, max: 1, step: 0.05, format: (value) => `${Math.round(Number(value) * 100)}%`, help: 'Higher values accept looser phrase matches. Recognition still depends on your browser.' }),
    controls.settingSwitch({ section: 'reader', key: 'voicePauseOnSilence', label: 'Pause timed scrolling during silence', description: 'When voice and timed playback are both active, silence pauses the timed scroll until speech returns.' }),
    h('p', { class: 'field-hint', style: { margin: '0', lineHeight: '1.6' }, text: 'Voice following can be inaccurate, especially with accents, noise, or uncommon names. The pause, speed, and manual controls always remain available.' }),
  );

  const main = h('div', { class: 'settings-reader-main' }, themeCard, typographyCard, playbackCard, chromeCard, voiceCard);
  const aside = h('aside', { class: 'settings-reader-aside', 'aria-label': 'Live reader preview' }, preview.element);
  element.append(h('div', { class: 'settings-reader-layout' }, main, aside));

  const languageInput = languageField.querySelector('input');
  languageInput.addEventListener('blur', () => {
    const value = languageInput.value.trim();
    if (!value) {
      languageError.hidden = true;
      languageInput.value = store.get().reader.voiceLanguage;
      return;
    }
    const valid = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value);
    languageError.hidden = valid;
    languageError.textContent = valid ? '' : 'Use a language tag such as en-US or am-ET.';
  });

  return element;
}

/* ============================================================
   Presets
   ============================================================ */

function presetSpecs(preset) {
  const reader = preset.settings?.reader || {};
  const mirror = MIRROR_OPTIONS.find((option) => option.value === reader.mirror);
  return [
    `${reader.speed || 140} WPM`,
    `${reader.fontSize || 56}px`,
    getThemePalette(reader.theme).name,
    mirror && reader.mirror !== 'none' ? mirror.label : null,
  ].filter(Boolean);
}

function buildPresetsSection({ store }) {
  let disposed = false;
  let userPresets = [];
  const builtInList = h('div', { class: 'preset-list' });
  const userList = h('div', { class: 'preset-list' });
  const userStatus = h('div', { class: 'field-hint', text: 'Loading presets...' });

  function currentReader() {
    return deepClone(store.get().reader);
  }

  function allNames(exceptId = null) {
    return new Set([...BUILT_IN_PRESETS, ...userPresets].filter((preset) => preset.id !== exceptId).map((preset) => preset.name.toLowerCase()));
  }

  function uniqueName(base, used) {
    const normalized = normalizePresetName(base) || 'Imported preset';
    let name = normalized.slice(0, 80);
    let counter = 2;
    while (used.has(name.toLowerCase())) {
      name = `${normalized.slice(0, 74)} ${counter}`;
      counter += 1;
    }
    return name;
  }

  function applyToReader(preset) {
    if (disposed) return;
    const previous = currentReader();
    applyPreset(store, preset);
    toast(`Preset "${preset.name}" applied. Reader settings changed only.`, {
      type: 'success',
      title: 'Preset applied',
      duration: 7000,
      actions: [
        {
          label: 'Undo',
          onClick: () => {
            store.setReader(previous);
            toast('Reader settings restored.', { type: 'info' });
          },
        },
      ],
    });
  }

  async function refreshUserPresets() {
    try {
      userPresets = await getAllUserPresets();
      if (disposed) return;
      renderUserPresets();
    } catch (error) {
      userStatus.textContent = friendlyErrorMessage(error, 'Custom presets could not be loaded.');
    }
  }

  function makeCard(preset, { builtIn = false } = {}) {
    const card = h('div', { class: 'preset-card' });
    const top = h('div', { class: 'preset-card__top' });
    const titleWrap = h('div', { style: { minWidth: '0' } });
    titleWrap.append(
      h('div', { class: 'preset-card__name', text: preset.name }),
      h('div', { class: 'preset-card__desc', text: preset.description || 'No description.' }),
    );
    top.append(titleWrap);
    if (builtIn) top.append(badge('Built in', 'accent'));
    const specs = h('div', { class: 'preset-card__specs' });
    for (const spec of presetSpecs(preset)) specs.append(badge(spec));
    const actions = h('div', { class: 'preset-card__actions' });
    actions.append(
      button('Apply', {
        iconName: 'check',
        size: 'sm',
        variant: 'primary',
        onClick: () => applyToReader(preset),
      }),
      button('Duplicate', {
        iconName: 'copy',
        size: 'sm',
        onClick: async () => {
          const used = allNames();
          const record = createUserPreset(preset.settings, {
            name: uniqueName(`${preset.name} copy`, used),
            description: preset.description || '',
          });
          try {
            await savePreset(record);
            toast(`"${record.name}" created.`, { type: 'success', title: 'Preset duplicated' });
            await refreshUserPresets();
          } catch (error) {
            toast(friendlyErrorMessage(error, 'The preset could not be duplicated.'), { type: 'error' });
          }
        },
      }),
    );
    if (!builtIn) {
      actions.append(iconButton('more', `${preset.name} preset actions`, {
        size: 'sm',
        onClick: () => openMenu(actions.lastElementChild, [
          { label: 'Edit details', iconName: 'pencil', onClick: () => openPresetEditor(preset) },
          { label: 'Update from current reader', iconName: 'refresh', onClick: () => updateFromCurrent(preset) },
          { label: 'Export preset', iconName: 'download', onClick: () => exportPresetFile(preset) },
          { separator: true },
          { label: 'Delete preset', iconName: 'trash', danger: true, onClick: () => deleteUserPreset(preset) },
        ]),
      }));
    }
    card.append(top, specs, actions);
    return card;
  }

  function renderBuiltIns() {
    builtInList.replaceChildren(...BUILT_IN_PRESETS.map((preset) => makeCard(preset, { builtIn: true })));
  }

  function renderUserPresets() {
    userList.replaceChildren();
    if (!userPresets.length) {
      userStatus.textContent = 'No custom presets yet. Save the current reader setup to create one.';
      userList.append(h('div', { class: 'empty-inline', text: 'Use "Save current setup" to keep this look for later.' }));
      return;
    }
    userStatus.textContent = `${userPresets.length} custom ${userPresets.length === 1 ? 'preset' : 'presets'} stored in this browser.`;
    for (const preset of userPresets) userList.append(makeCard(preset));
  }

  async function updateFromCurrent(preset) {
    const confirmed = await confirmDialog({
      title: `Update "${preset.name}"?`,
      message: 'The preset snapshot is replaced with the current reader settings. The preset name and description stay the same.',
      confirmLabel: 'Update preset',
      iconName: 'refresh',
    });
    if (!confirmed) return;
    try {
      const record = createUserPreset(store.get(), { name: preset.name, description: preset.description });
      await savePreset({ ...record, id: preset.id, createdAt: preset.createdAt });
      toast('Preset snapshot updated.', { type: 'success' });
      await refreshUserPresets();
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The preset could not be updated.'), { type: 'error' });
    }
  }

  async function deleteUserPreset(preset) {
    const confirmed = await confirmDialog({
      title: `Delete "${preset.name}"?`,
      message: 'The preset is removed from this browser. Reader settings and scripts are not affected.',
      confirmLabel: 'Delete preset',
      danger: true,
      iconName: 'trash',
    });
    if (!confirmed) return;
    try {
      await deletePreset(preset.id);
      toast('Preset deleted.', { type: 'success' });
      await refreshUserPresets();
    } catch (error) {
      toast(friendlyErrorMessage(error, 'The preset could not be deleted.'), { type: 'error' });
    }
  }

  function openPresetEditor(existing = null) {
    const editing = Boolean(existing);
    const initialName = existing?.name || '';
    const initialDescription = existing?.description || '';
    const sourceReader = editing ? existing.settings.reader : currentReader();
    const usedNames = allNames(existing?.id || null);
    let closing = false;

    const modal = openModal({
      title: editing ? 'Edit preset details' : 'Save current reader setup',
      description: editing
        ? 'Rename the preset or change its description. The stored reader snapshot is unchanged.'
        : 'The current reader appearance and timing are stored as a reusable preset.',
      icon: 'sparkles',
      size: 'sm',
      persistent: true,
      closeOnBackdrop: false,
    });
    const closeX = modal.element.querySelector('.modal__close');
    if (closeX) closeX.hidden = true;

    const nameField = createTextInput({
      label: 'Preset name',
      value: initialName,
      placeholder: 'e.g. Keynote stage',
      maxlength: '80',
      required: true,
    });
    const descriptionField = createTextarea({
      label: 'Description (optional)',
      value: initialDescription,
      placeholder: 'What is this setup for?',
      rows: 3,
      maxlength: '200',
    });
    const nameInput = nameField.querySelector('input');
    const descriptionInput = descriptionField.querySelector('textarea');
    const error = h('div', { class: 'field-error', hidden: true });
    const specs = h('div', { class: 'preset-card__specs' });
    for (const spec of presetSpecs({ settings: { reader: sourceReader } })) specs.append(badge(spec));

    const form = h('form', { novalidate: true });
    form.append(nameField, descriptionField, specs, error);
    modal.body.append(form);

    const cancelButton = button('Cancel', { variant: 'ghost' });
    const saveButton = button(editing ? 'Save details' : 'Save preset', { iconName: 'save', variant: 'primary' });
    modal.footer.append(h('div', { class: 'btn-row' }, cancelButton, saveButton));

    function isDirty() {
      return nameInput.value.trim() !== initialName || descriptionInput.value.trim() !== initialDescription;
    }
    function showError(message) {
      error.hidden = false;
      error.textContent = message;
      nameInput.setAttribute('aria-invalid', 'true');
    }
    function hideError() {
      error.hidden = true;
      error.textContent = '';
      nameInput.removeAttribute('aria-invalid');
    }
    nameInput.addEventListener('input', hideError);

    async function requestClose() {
      if (closing) return;
      if (isDirty()) {
        const confirmed = await confirmDialog({
          title: 'Discard preset changes?',
          message: 'The name and description changes have not been saved.',
          confirmLabel: 'Discard changes',
          danger: true,
          iconName: 'warning',
        });
        if (!confirmed) return;
      }
      closing = true;
      modal.close('dismiss');
    }
    cancelButton.addEventListener('click', requestClose);

    async function save() {
      const name = normalizePresetName(nameInput.value);
      const duplicate = usedNames.has(name.toLowerCase());
      if (!name) {
        showError('Enter a preset name.');
        nameInput.focus();
        return;
      }
      if (duplicate) {
        showError('Another preset already uses this name.');
        nameInput.focus();
        return;
      }
      setButtonBusy(saveButton, true, editing ? 'Saving...' : 'Creating...');
      try {
        if (editing) {
          await savePreset({
            ...existing,
            name,
            description: descriptionInput.value.trim().slice(0, 200),
            settings: { reader: deepClone(existing.settings.reader) },
            updatedAt: nowIso(),
          });
          toast('Preset details saved.', { type: 'success' });
        } else {
          const record = createUserPreset(store.get(), { name, description: descriptionInput.value.trim() });
          await savePreset(record);
          toast(`Preset "${name}" saved.`, { type: 'success', title: 'Preset created' });
        }
        closing = true;
        modal.close('saved');
        await refreshUserPresets();
      } catch (saveError) {
        closing = false;
        setButtonBusy(saveButton, false);
        showError(friendlyErrorMessage(saveError, 'The preset could not be saved.'));
      }
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      save();
    });
    saveButton.addEventListener('click', save);
    requestAnimationFrame(() => {
      nameInput.focus();
      nameInput.select();
    });
  }

  renderBuiltIns();
  refreshUserPresets();

  const element = settingsSection({
    id: 'presets',
    icon: 'sparkles',
    title: 'Presets',
    description: 'Reusable reader setups. Presets store settings only; they never duplicate or replace scripts.',
    actions: [
      button('Import preset', { iconName: 'upload', size: 'sm', onClick: () => openPresetImportDialog({ onImported: () => refreshUserPresets() }) }),
      button('Save current setup', { iconName: 'plus', variant: 'primary', size: 'sm', onClick: () => openPresetEditor() }),
    ],
  });

  element.append(
    settingsCard('Built-in presets', 'Starting points for common reading setups. Duplicate one to customize it.', builtInList),
    settingsCard(
      'My presets',
      'Snapshots of reader appearance, pacing, mirroring, and voice preferences.',
      h('div', { class: 'settings-actions', style: { justifyContent: 'space-between' } },
        badge('Custom', 'accent'),
        button('Import preset file', { iconName: 'upload', size: 'sm', onClick: () => openPresetImportDialog({ onImported: () => refreshUserPresets() }) }),
      ),
      userStatus,
      userList,
    ),
    h('p', {
      class: 'field-hint',
      style: { margin: '0', lineHeight: '1.6' },
      text: 'Preset files are validated JSON. Importing a preset never overwrites an existing preset; name conflicts are renamed. Applying a preset changes reader settings only and offers an Undo action.',
    }),
  );

  return { element, cleanup: () => { disposed = true; } };
}

/* ============================================================
   Shortcuts
   ============================================================ */

function reservedShortcutReason(event) {
  if (event.key === 'Tab') return 'Tab moves focus and cannot be used as a reader shortcut.';
  if (['F5', 'F11', 'F12'].includes(event.key)) return `${event.key} is reserved by the browser.`;
  if (event.altKey && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return 'That combination is used for browser navigation.';
  const modifier = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (modifier) {
    const reserved = new Set(['w', 't', 'n', 'l', 'r', 'p', 's', 'f', 'o', 'd', 'h', 'j', 'u', 'g', 'e', 'q', 'a', 'z', 'x', 'c', 'v', 'i']);
    if (reserved.has(key)) {
      return 'Browsers keep Ctrl/Cmd combinations such as W, T, N, L, R, P, S, and F for their own actions. Try a different combination.';
    }
  }
  return '';
}

function buildShortcutsSection({ store, controls, registerCleanup }) {
  const entries = [];
  const groupsRoot = h('div', { class: 'shortcut-groups' });
  const captureError = h('div', { class: 'field-error', role: 'status', 'aria-live': 'polite', hidden: true });
  let captureAction = null;
  let capturing = false;

  function showError(message) {
    captureError.hidden = false;
    captureError.textContent = message;
  }
  function clearError() {
    captureError.hidden = true;
    captureError.textContent = '';
  }

  function updateEntries(settings) {
    const map = getShortcutMap(settings.reader.shortcutOverrides);
    for (const entry of entries) {
      const shortcut = map[entry.action] || DEFAULT_SHORTCUTS[entry.action];
      entry.button.textContent = captureAction === entry.action && capturing ? 'Press keys...' : displayShortcut(shortcut);
      entry.button.dataset.capturing = String(captureAction === entry.action && capturing);
      const customized = shortcut !== DEFAULT_SHORTCUTS[entry.action];
      entry.custom.hidden = !customized;
      entry.reset.disabled = !customized;
    }
  }
  controls.registerSync(updateEntries);

  function endCapture({ restore = true } = {}) {
    if (!capturing) return;
    capturing = false;
    captureAction = null;
    document.removeEventListener('keydown', onKey, true);
    clearError();
    if (restore) updateEntries(store.get());
  }

  function startCapture(entry) {
    if (captureAction === entry.action) {
      endCapture();
      return;
    }
    endCapture({ restore: false });
    clearError();
    captureAction = entry.action;
    capturing = true;
    updateEntries(store.get());
    document.addEventListener('keydown', onKey, true);
    entry.button.focus();
  }

  function onKey(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      endCapture();
      return;
    }
    if (['Backspace', 'Delete'].includes(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const overrides = { ...(store.get().reader.shortcutOverrides || {}) };
      delete overrides[captureAction];
      endCapture();
      store.setReader({ shortcutOverrides: overrides });
      toast('Shortcut reset to its default.', { type: 'success' });
      return;
    }
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
    const reserved = reservedShortcutReason(event);
    if (reserved) {
      showError(reserved);
      return;
    }
    const shortcut = shortcutFromEvent(event);
    if (!shortcut) return;
    const conflict = shortcutConflict(shortcut, getShortcutMap(store.get().reader.shortcutOverrides), captureAction);
    if (conflict) {
      const conflictLabel = SHORTCUT_ACTIONS.find((item) => item.action === conflict)?.label || conflict;
      showError(`${displayShortcut(shortcut)} is already used by ${conflictLabel}. Choose another combination.`);
      return;
    }
    const action = captureAction;
    endCapture({ restore: false });
    const overrides = { ...(store.get().reader.shortcutOverrides || {}), [action]: shortcut };
    store.setReader({ shortcutOverrides: overrides });
    toast(`Shortcut set to ${displayShortcut(shortcut)}.`, { type: 'success' });
  }

  const groups = [...new Set(SHORTCUT_ACTIONS.map((action) => action.group))];
  for (const groupName of groups) {
    const group = h('div', { class: 'shortcut-group' });
    group.append(h('h3', { text: groupName }));
    for (const action of SHORTCUT_ACTIONS.filter((item) => item.group === groupName)) {
      const copy = h('div', { class: 'shortcut-row__copy' });
      copy.append(h('div', { class: 'shortcut-row__name', text: action.label }), h('div', { class: 'shortcut-row__desc', text: action.description }));
      const custom = badge('Custom', 'accent');
      custom.hidden = true;
      const captureButton = h('button', {
        type: 'button',
        class: 'shortcut-capture',
        'aria-label': `Change shortcut for ${action.label}`,
      });
      const resetButton = iconButton('restart', `Reset ${action.label} to default`, { size: 'sm' });
      const entry = { ...action, button: captureButton, reset: resetButton, custom };
      captureButton.addEventListener('click', () => startCapture(entry));
      resetButton.addEventListener('click', () => {
        const overrides = { ...(store.get().reader.shortcutOverrides || {}) };
        delete overrides[action.action];
        store.setReader({ shortcutOverrides: overrides });
        clearError();
        toast(`${action.label} shortcut reset.`, { type: 'success' });
      });
      const control = h('div', { class: 'shortcut-row__control' }, custom, captureButton, resetButton);
      const row = h('div', { class: 'shortcut-row' }, copy, control);
      group.append(row);
      entries.push(entry);
    }
    groupsRoot.append(group);
  }
  updateEntries(store.get());

  const element = settingsSection({
    id: 'shortcuts',
    icon: 'keyboard',
    title: 'Shortcuts',
    description: 'Reader-only keys for playback, position, display, and help. Nothing here intercepts typing in an input or dialog.',
    actions: [
      button('Reset all shortcuts', {
        iconName: 'restart',
        size: 'sm',
        onClick: async () => {
          endCapture();
          const overrides = store.get().reader.shortcutOverrides || {};
          if (!Object.keys(overrides).length) {
            toast('Every reader shortcut is already using its default.', { type: 'info' });
            return;
          }
          const confirmed = await confirmDialog({
            title: 'Reset all reader shortcuts?',
            message: 'Every custom binding returns to its default key. Presets, scripts, and other reader settings are unchanged.',
            confirmLabel: 'Reset shortcuts',
            iconName: 'keyboard',
          });
          if (!confirmed) return;
          store.setReader({ shortcutOverrides: {} });
          toast('All reader shortcuts reset to defaults.', { type: 'success' });
        },
      }),
    ],
  });

  element.append(
    settingsCard(
      'Shortcut behavior',
      'Shortcuts are active only in the teleprompter, never while typing in the editor or a form.',
      controls.settingSwitch({
        section: 'reader',
        key: 'shortcutsEnabled',
        label: 'Enable reader keyboard shortcuts',
        description: 'Turn off if your keyboard, switch control, or other assistive tool needs these keys. Pointer and remote controls still work.',
      }),
      h('p', {
        class: 'field-hint',
        style: { margin: '0', lineHeight: '1.6' },
        text: 'Click a key button and press the new combination. Escape cancels capture, and Backspace or Delete resets that action. The browser always keeps its own reserved combinations such as Ctrl/Cmd+W, Ctrl/Cmd+T, and F11.',
      }),
    ),
    settingsCard('Reader bindings', 'Conflict checks prevent two actions from sharing one key.', captureError, groupsRoot),
  );

  registerCleanup(() => endCapture({ restore: false }));
  return element;
}

/* ============================================================
   Data and backup
   ============================================================ */

function buildDataSection({ store, ctx, controls, registerCleanup }) {
  let disposed = false;
  const persistenceBadge = badge('Checking...');
  const persistenceHelp = h('div', { class: 'field-hint', text: 'Reading browser storage status...' });
  const usageText = h('div', { class: 'field-hint', text: 'Reading browser storage...' });
  const meterFill = h('div', { class: 'storage-meter__fill', style: { width: '0%' } });
  const meter = h('div', {
    class: 'storage-meter',
    role: 'progressbar',
    'aria-label': 'Browser storage used',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': '0',
  }, meterFill);
  const countsGrid = h('div', { class: 'storage-grid' });
  const persistActions = h('div', { class: 'settings-actions', style: { marginTop: '4px' } });
  const backupBadge = badge('Checking...');
  const backupText = h('div', { class: 'field-hint', text: 'Reading backup status...' });

  function fulfilled(result, fallback = null) {
    return result.status === 'fulfilled' ? result.value : fallback;
  }

  async function refreshData() {
    const [estimateResult, persistedResult, backupResult, scriptsResult, foldersResult, presetsResult] = await Promise.allSettled([
      getStorageEstimate(),
      isStoragePersisted(),
      getBackupStatus(store.get()),
      getAllScripts({ includeDeleted: true }),
      getAllFolders(),
      getAllUserPresets(),
    ]);
    if (disposed) return;

    const estimate = fulfilled(estimateResult, null);
    if (estimate) {
      const percent = Math.max(0, Math.min(100, estimate.percent));
      meterFill.style.width = `${Math.max(0.8, percent).toFixed(2)}%`;
      meter.setAttribute('aria-valuenow', percent.toFixed(1));
      usageText.textContent = `${formatBytes(estimate.usage)} used of about ${formatBytes(estimate.quota)} available (${percent.toFixed(1)}%).`;
    } else {
      meterFill.style.width = '0%';
      meter.setAttribute('aria-valuenow', '0');
      usageText.textContent = 'This browser does not report a storage estimate. Backups remain the reliable recovery path.';
    }

    const persisted = fulfilled(persistedResult, false);
    persistenceBadge.className = `badge ${persisted ? 'badge--success' : 'badge--warning'}`;
    persistenceBadge.textContent = persisted ? 'Persistent' : 'Best effort';
    persistenceHelp.textContent = persisted
      ? 'The browser granted persistent storage, so this data is less likely to be evicted automatically.'
      : 'Storage is best effort. The browser may evict local data when space is low; regular backups are strongly recommended.';
    persistActions.replaceChildren();
    if (persisted) {
      persistActions.append(h('span', { class: 'field-hint', text: 'Persistent storage is already granted for this origin.' }));
    } else if (supportsFeature('persistentStorage')) {
      const persistButton = button('Request persistent storage', { iconName: 'shield', size: 'sm' });
      persistButton.addEventListener('click', async () => {
        setButtonBusy(persistButton, true, 'Requesting...');
        try {
          const granted = await requestPersistentStorage();
          toast(
            granted ? 'The browser granted persistent storage. Keep downloading backups anyway.' : 'The browser did not grant persistent storage. Download backups regularly.',
            { type: granted ? 'success' : 'warning', title: granted ? 'Storage protected' : 'Request not granted' },
          );
          await refreshData();
        } catch (error) {
          toast(friendlyErrorMessage(error, 'Persistent storage could not be requested.'), { type: 'error' });
        } finally {
          setButtonBusy(persistButton, false);
        }
      });
      persistActions.append(persistButton);
    } else {
      persistActions.append(h('span', { class: 'field-hint', text: 'This browser does not support persistent storage requests.' }));
    }

    const scripts = fulfilled(scriptsResult, []);
    const folders = fulfilled(foldersResult, []);
    const presets = fulfilled(presetsResult, []);
    const activeScripts = scripts.filter((script) => !script.deletedAt);
    const trashedScripts = scripts.filter((script) => script.deletedAt);
    const words = activeScripts.reduce((sum, script) => sum + (Number(script.wordCount) || 0), 0);
    const counts = [
      [String(activeScripts.length), 'Active scripts'],
      [String(trashedScripts.length), 'In trash'],
      [String(folders.length), 'Folders'],
      [String(presets.length), 'Custom presets'],
      [words.toLocaleString(), 'Words'],
      [scripts.length ? 'IndexedDB' : 'Empty', 'Library store'],
    ];
    countsGrid.replaceChildren();
    for (const [value, label] of counts) {
      countsGrid.append(h('div', { class: 'storage-box' }, h('strong', { text: value }), h('span', { text: label })));
    }

    const status = fulfilled(backupResult, { never: true, due: true, lastBackupAt: null, reminderDays: 14 });
    const due = status.never || status.due;
    backupBadge.className = `badge ${status.never ? 'badge--warning' : due ? 'badge--warning' : 'badge--success'}`;
    backupBadge.textContent = status.never ? 'Never backed up' : due ? 'Backup due' : 'Backup current';
    backupText.textContent = status.never
      ? `No backup has been downloaded from this browser yet. A reminder appears after ${status.reminderDays} days by default.`
      : `Last backup ${formatRelative(status.lastBackupAt)}. The reminder interval is ${status.reminderDays} days.`;
  }

  async function refreshShell() {
    try { await ctx.refreshBackupStatus?.(); } catch { /* best effort */ }
    try { await ctx.refreshSidebar?.(); } catch { /* best effort */ }
  }

  async function handleRestored(info = {}) {
    if (info.settingsRestored) {
      try {
        const record = await loadSettingsRecord();
        store.replaceAll(record?.value || deepClone(DEFAULT_SETTINGS));
        await store.saveNow().catch(() => {});
      } catch (error) {
        toast(friendlyErrorMessage(error, 'Restored settings could not be reloaded.'), { type: 'error', title: 'Reload required' });
      }
    }
    await refreshShell();
    await refreshData();
  }

  async function handleCleared() {
    try {
      const record = await loadSettingsRecord();
      store.replaceAll(record?.value || deepClone(DEFAULT_SETTINGS));
      await store.saveNow().catch(() => {});
    } catch (error) {
      toast(friendlyErrorMessage(error, 'Default settings could not be restored after clearing data.'), { type: 'error' });
    }
    await refreshShell();
    await refreshData();
  }

  const element = settingsSection({
    id: 'data',
    icon: 'database',
    title: 'Data & backup',
    description: 'Your library is local to this browser. Backups are the durable copy you control.',
    actions: [
      button('Reset import settings', { iconName: 'restart', size: 'sm', onClick: () => resetSettingsSection(store, 'import', 'import') }),
    ],
  });

  element.append(
    settingsCard(
      'Local storage',
      'Usage, persistence, and a count of what is stored in this browser profile.',
      h('div', { class: 'storage-card__top' }, h('span', { text: 'Browser storage' }), persistenceBadge),
      meter,
      usageText,
      countsGrid,
      persistActions,
      persistenceHelp,
    ),
    settingsCard(
      'Backup & restore',
      'Versioned JSON backups include scripts, folders, tags, presets, settings, and optional revisions.',
      h('div', { class: 'settings-actions', style: { justifyContent: 'space-between' } }, backupBadge, backupText),
      h('div', { class: 'settings-actions' },
        button('Download backup', {
          iconName: 'download',
          variant: 'primary',
          onClick: () => openBackupDialog({
            settingsStore: store,
            onBackup: () => {
              refreshData();
              ctx.refreshBackupStatus?.().catch(() => {});
            },
          }),
        }),
        button('Restore backup', { iconName: 'history', onClick: () => openRestoreDialog({ onRestored: handleRestored }) }),
        button('Manage storage', { iconName: 'hardDrive', onClick: () => openStorageDialog({ onCleared: handleCleared }) }),
      ),
      h('div', { class: 'backup-banner', style: { marginTop: '2px' } },
        iconSpan('warning', { size: 16 }),
        h('span', { text: 'Restoring can add records (merge) or replace the entire local library. Replace requires explicit confirmation and offers a safety backup. Always keep a recent backup outside this browser.' }),
      ),
    ),
    settingsCard(
      'Import defaults',
      'The import dialog starts with these values. You can still adjust them for an individual batch.',
      controls.settingRange({
        section: 'import',
        key: 'maxFileSizeMB',
        label: 'Maximum file size',
        min: 1,
        max: 200,
        step: 1,
        format: (value) => `${value} MB`,
        help: 'Larger files may be slow to parse. PDFs with OCR can take significantly longer.',
      }),
      controls.settingSwitch({
        section: 'import',
        key: 'cleanupBlankLines',
        label: 'Collapse excessive blank lines',
        description: 'Keeps paragraph breaks while removing long runs of empty lines.',
      }),
      controls.settingSwitch({
        section: 'import',
        key: 'removePageArtifacts',
        label: 'Remove page headers, footers, and numbers',
        description: 'Best-effort cleanup for PDFs and exported documents. Review the preview before importing.',
      }),
      controls.settingSelect({
        section: 'import',
        key: 'ocrLanguage',
        label: 'OCR language',
        options: OCR_LANGUAGES,
        help: 'OCR runs locally with bundled language data. English and Amharic are available; recognition can make mistakes.',
      }),
    ),
  );

  refreshData();
  registerCleanup(() => { disposed = true; });
  return element;
}

/* ============================================================
   Recording
   ============================================================ */

function buildRecordingSection({ store, controls }) {
  const element = settingsSection({
    id: 'recording',
    icon: 'camera',
    title: 'Recording',
    description: 'Camera and microphone recording for rehearsal takes. Media never leaves this tab unless you download it.',
    actions: [
      button('Reset recording', { iconName: 'restart', size: 'sm', onClick: () => resetSettingsSection(store, 'recording', 'recording') }),
    ],
  });

  const support = isCameraRecordingSupported();
  const supportedMimes = getSupportedMimeTypes();
  const qualityOptions = Object.entries(RECORDING_QUALITIES).map(([value, quality]) => ({ value, label: quality.label }));

  element.append(
    settingsCard(
      'Browser support',
      'Formats depend on your browser and device. The app uses only formats the browser reports as supported.',
      h('div', { class: 'capability-row' }, h('span', { text: 'Camera + microphone recording' }), badge(support ? 'Available' : 'Not available', support ? 'success' : 'warning')),
      h('div', { class: 'capability-row' }, h('span', { text: 'Supported containers and codecs' }), h('span', { class: 'muted capability-row__value', text: supportedMimes.length ? supportedMimes.map((mime) => describeMime(mime)).join(', ') : 'None detected' })),
      !support
        ? h('p', { class: 'field-hint', style: { margin: '0', lineHeight: '1.6' }, text: 'This browser does not support camera/microphone capture or MediaRecorder. The camera dock in the reader shows an honest not-supported state instead of a broken control.' })
        : null,
    ),
    settingsCard(
      'Recording defaults',
      'These are used when opening the camera dock in the teleprompter.',
      controls.settingSelect({ section: 'recording', key: 'videoQuality', label: 'Video quality', options: qualityOptions, help: 'Higher quality uses more CPU and storage.' }),
      controls.settingSwitch({ section: 'recording', key: 'includeMic', label: 'Include microphone audio', description: 'If off, the recorder requests video only. Some browsers may still require a microphone permission for certain formats.' }),
      controls.settingSelect({
        section: 'recording',
        key: 'preferredMime',
        label: 'Preferred format',
        options: [
          { value: 'auto', label: 'Auto (best supported)' },
          ...supportedMimes.map((mime) => ({ value: mime, label: describeMime(mime) })),
        ],
        help: supportedMimes.length ? 'If unavailable, the recorder falls back to another supported format.' : 'No MediaRecorder formats were detected in this browser.',
      }),
    ),
    settingsCard(
      'Privacy and limits',
      'Recordings are temporary until you download them.',
      h('p', {
        class: 'muted',
        style: { margin: '0', fontSize: '12px', lineHeight: '1.65' },
        text: 'Recording uses your device camera and microphone through browser APIs. Nothing is uploaded. The last take lives in the reader tab until it is downloaded or discarded, and closing the tab may release it. Camera/microphone permission is controlled by your browser.',
      }),
    ),
  );

  return element;
}

/* ============================================================
   About
   ============================================================ */

function capabilityRows() {
  return [
    ['Speech recognition', supportsFeature('speech')],
    ['Camera and MediaRecorder', isCameraRecordingSupported()],
    ['Fullscreen API', supportsFeature('fullscreen')],
    ['Persistent storage', supportsFeature('persistentStorage')],
    ['Service worker (offline)', supportsFeature('serviceWorker')],
    ['BroadcastChannel (remote)', supportsFeature('broadcastChannel')],
    ['Web Share', supportsFeature('share')],
    ['Storage estimate', supportsFeature('storageEstimate')],
  ];
}

function buildAboutSection() {
  const element = settingsSection({
    id: 'about',
    icon: 'info',
    title: 'About',
    description: 'Version, capabilities, credits, and local-first notes.',
  });

  const capabilityList = h('div', { class: 'capability-list' });
  for (const [label, available] of capabilityRows()) {
    capabilityList.append(
      h('div', { class: 'capability-row' },
        h('span', { text: label }),
        badge(available ? 'Available' : 'Not available', available ? 'success' : 'warning'),
      ),
    );
  }

  element.append(
    settingsCard(
      'Application',
      'Advanced Teleprompter Studio',
      h('div', { class: 'about-grid' },
        h('dl', { class: 'about-item' }, h('dt', { text: 'Name' }), h('dd', { text: APP_NAME })),
        h('dl', { class: 'about-item' }, h('dt', { text: 'Version' }), h('dd', { text: APP_VERSION })),
        h('dl', { class: 'about-item' }, h('dt', { text: 'License' }), h('dd', { text: 'MIT' })),
        h('dl', { class: 'about-item' }, h('dt', { text: 'Model' }), h('dd', { text: 'Local-first, no accounts' })),
      ),
    ),
    settingsCard('Browser capabilities', 'Detected live in this browser. Unavailable features are clearly marked instead of simulated.', capabilityList),
    settingsCard(
      'Built with',
      'Open source libraries used by this app.',
      h('div', { class: 'about-grid' },
        h('dl', { class: 'about-item' }, h('dt', { text: 'Vite' }), h('dd', { text: 'Build tool' })),
        h('dl', { class: 'about-item' }, h('dt', { text: 'Tailwind CSS' }), h('dd', { text: 'Styling' })),
        h('dl', { class: 'about-item' }, h('dt', { text: 'marked' }), h('dd', { text: 'Markdown' })),
        h('dl', { class: 'about-item' }, h('dt', { text: 'DOMPurify' }), h('dd', { text: 'Sanitization' })),
        h('dl', { class: 'about-item' }, h('dt', { text: 'Mammoth' }), h('dd', { text: 'DOCX import' })),
        h('dl', { class: 'about-item' }, h('dt', { text: 'PDF.js' }), h('dd', { text: 'PDF import' })),
        h('dl', { class: 'about-item' }, h('dt', { text: 'Tesseract.js' }), h('dd', { text: 'OCR' })),
        h('dl', { class: 'about-item' }, h('dt', { text: 'qrcode' }), h('dd', { text: 'QR codes' })),
      ),
    ),
    settingsCard(
      'Privacy and data',
      'Everything stays on your device.',
      h('p', {
        class: 'muted',
        style: { margin: '0', fontSize: '12px', lineHeight: '1.65' },
        text: 'Scripts, folders, presets, settings, and revisions are stored in IndexedDB in this browser. There is no telemetry, account, or cloud sync. Backups are user-initiated JSON files. Imported HTML is sanitized and imported scripts never run.',
      }),
    ),
  );

  return element;
}

/* ============================================================
   Main settings view
   ============================================================ */

export async function settingsView(ctx, routeContext = {}) {
  const store = ctx.settingsStore;
  if (!store) throw new Error('SettingsStore not initialized.');

  const requested = routeContext.query?.section || routeContext.query?.tab || null;
  const syncers = new Set();
  const cleanups = [];
  let disposed = false;

  function registerCleanup(fn) {
    if (typeof fn === 'function') cleanups.push(fn);
  }

  const controls = createControlHelpers(store, syncers);
  const layout = h('div', { class: 'settings-layout' });
  const nav = h('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' });
  const content = h('div', { class: 'settings-content' });
  const navButtons = new Map();
  const sections = [];
  let activeSection = normalizeSectionId(requested);

  function activateSection(id, { focus = false, updateUrl = false } = {}) {
    const sectionId = normalizeSectionId(id);
    activeSection = sectionId;
    for (const [key, buttonEl] of navButtons) {
      buttonEl.setAttribute('aria-current', key === sectionId ? 'true' : null);
    }
    for (const section of sections) {
      section.dataset.active = String(section.dataset.section === sectionId);
      section.hidden = section.dataset.section !== sectionId;
    }
    if (updateUrl) {
      const url = new URL(globalThis.location.href);
      url.hash = `#/settings?section=${encodeURIComponent(sectionId)}`;
      try {
        history.replaceState(null, '', url.pathname + url.search + url.hash);
      } catch {
        // Address bar updates are a convenience.
      }
    }
    const heading = shellHeading();
    if (heading) heading.textContent = `Settings - ${SECTION_ORDER.find((section) => section.id === sectionId)?.label || 'Settings'}`;
    if (focus) {
      const section = sections.find((item) => item.dataset.section === sectionId);
      section?.heading?.focus?.({ preventScroll: true });
    }
  }

  function shellHeading() {
    return document.getElementById('topbar-heading');
  }

  for (const section of SECTION_ORDER) {
    const buttonEl = h('button', {
      type: 'button',
      class: 'settings-nav__button',
      'data-section': section.id,
    }, iconSpan(section.icon, { size: 16 }), h('span', { text: section.label }));
    buttonEl.addEventListener('click', () => activateSection(section.id, { updateUrl: true }));
    navButtons.set(section.id, buttonEl);
    nav.append(buttonEl);
  }

  const saveBar = buildSaveBar({
    store,
    onResetAll: async () => {
      const confirmed = await confirmDialog({
        title: 'Reset all settings?',
        message: 'All settings sections return to defaults. Scripts, folders, presets, and revisions are not changed.',
        confirmLabel: 'Reset all',
        iconName: 'restart',
      });
      if (!confirmed) return;
      store.resetSection('all');
      toast('All settings reset to defaults.', { type: 'success' });
    },
  });

  const presets = buildPresetsSection({ store });
  const built = [
    buildGeneralSection({ store, controls }),
    buildEditorSection({ store, controls }),
    buildReaderSection({ store, controls }),
    presets.element,
    buildShortcutsSection({ store, controls, registerCleanup }),
    buildDataSection({ store, ctx, controls, registerCleanup }),
    buildRecordingSection({ store, controls }),
    buildAboutSection(),
  ];
  sections.push(...built);
  if (presets.cleanup) registerCleanup(presets.cleanup);
  content.append(...built);

  activateSection(activeSection);

  const unsubscribe = store.subscribe((settings) => {
    if (disposed) return;
    for (const listener of syncers) {
      try {
        listener(settings);
      } catch (error) {
        console.error('Settings sync failed', error);
      }
    }
    saveBar.update();
  });
  saveBar.update();

  layout.append(nav, content);
  const wrapper = h('div', { class: 'settings-page' }, saveBar.element, layout);
  ctx.setTopbarTitle('Settings', 'Studio');
  const titleAfterRoute = `Settings - ${SECTION_ORDER.find((section) => section.id === activeSection)?.label || 'Settings'}`;
  if (shellHeading()) shellHeading().textContent = titleAfterRoute;

  return {
    element: wrapper,
    pageTitle: 'Settings',
    cleanup: () => {
      disposed = true;
      unsubscribe();
      for (const fn of cleanups) {
        try {
          fn();
        } catch (error) {
          console.error('Settings cleanup failed', error);
        }
      }
    },
  };
}
