import { bulkUpdateScripts, getScript } from '../database.js';
import {
  END_BEHAVIOR_OPTIONS,
  FONT_FAMILY_OPTIONS,
  MIRROR_OPTIONS,
  READER_THEMES,
  TEXT_ALIGN_OPTIONS,
  getFontStack,
  resolveReaderColors,
} from '../settings.js';
import {
  ScrollEngine,
  computePlaybackMetrics,
  positionToProgress,
  progressToPosition,
} from '../scroll-engine.js';
import { renderScriptHtml, buildRenderedTextIndex, rangeForToken } from '../render-content.js';
import {
  button,
  confirmDialog,
  copyText,
  createColorInput,
  createRange,
  createSelect,
  createSwitch,
  createTextInput,
  h,
  iconSpan,
  setButtonBusy,
  toast,
} from '../ui.js';
import { icon } from '../icons.js';
import { ShortcutController } from '../keyboard-shortcuts.js';
import {
  clamp,
  countWords,
  formatBytes,
  formatDuration,
  friendlyErrorMessage,
  isLowContrast,
  nowIso,
  sanitizeFileName,
} from '../utils.js';
import { VoiceFollowController } from '../voice-follow.js';
import {
  CameraRecorder,
  RECORDING_QUALITIES,
  describeMime,
  getSupportedMimeTypes,
  isCameraRecordingSupported,
  pickMimeType,
} from '../camera-recorder.js';
import {
  RemoteHost,
  buildRemoteUrl,
  createRemoteSession,
  isRemoteSupported,
} from '../remote-control.js';

const STATUS_LABELS = Object.freeze({
  ready: 'Ready',
  playing: 'Playing',
  paused: 'Paused',
  stopped: 'Stopped',
  countdown: 'Starting',
  finished: 'Finished',
  voice: 'Voice follow',
  error: 'Error',
});

const PANEL_NAMES = Object.freeze(['drawer', 'voice', 'camera', 'remote']);

function directionWord(direction) {
  return direction === 'reverse' ? 'Reverse' : 'Forward';
}

function readerClock(ms) {
  return formatDuration(Math.max(0, ms) / 1000, { compact: true });
}

function defaultReaderStyle(screen) {
  screen.style.setProperty('--reader-bg', '#050910');
  screen.style.setProperty('--reader-text', '#f2f7ff');
  screen.style.setProperty('--reader-accent', '#22d3ee');
  screen.style.setProperty('--reader-font', getFontStack('sans'));
  screen.style.setProperty('--reader-font-size', '56px');
  screen.style.setProperty('--reader-font-weight', '600');
  screen.style.setProperty('--reader-line-height', '1.5');
  screen.style.setProperty('--reader-letter-spacing', '0em');
  screen.style.setProperty('--reader-para-spacing', '1em');
  screen.style.setProperty('--reader-align', 'left');
  screen.style.setProperty('--reader-width', '920px');
  screen.style.setProperty('--reader-margin', '5vw');
  screen.style.setProperty('--reader-top-pad', '42vh');
  screen.style.setProperty('--reader-bottom-pad', '58vh');
  screen.style.setProperty('--reader-focus-position', '42vh');
}

function readerFallback(ctx, { title, message, iconName = 'fileText', actions = [] }) {
  const screen = h('div', { class: 'reader-screen', 'data-reader-theme': 'midnight' });
  defaultReaderStyle(screen);

  const exit = h('button', {
    type: 'button',
    class: 'reader-btn reader-btn--exit',
    onclick: () => ctx.navigate('/library'),
  });
  exit.append(iconSpan('arrowLeft', { size: 15 }), h('span', { class: 'reader-btn__label', text: 'Back to library' }));

  const topbar = h(
    'div',
    { class: 'reader-topbar' },
    exit,
    h('div', { class: 'reader-topbar__title' }, h('div', { class: 'reader-topbar__name', text: title })),
  );

  const iconBox = h('div', { class: 'reader-endcard__icon', html: icon(iconName, { size: 26 }) });
  const inner = h('div', { class: 'reader-empty__inner' }, iconBox, h('h2', { text: title }), h('p', { text: message }));
  if (actions.length) {
    const row = h('div', { class: 'reader-endcard__actions' });
    for (const action of actions) {
      row.append(
        button(action.label, {
          iconName: action.icon,
          variant: action.primary ? 'primary' : '',
          onClick: action.onClick,
        }),
      );
    }
    inner.append(row);
  }

  screen.append(topbar, h('div', { class: 'reader-empty' }, inner));
  return {
    element: screen,
    pageTitle: title,
    cleanup: () => {},
  };
}

/**
 * Dedicated reading screen. Playback is separated from editing and every
 * control below is connected to real reader/settings behavior.
 */
export async function readerView(ctx, routeContext) {
  const scriptId = routeContext?.params?.id;
  let script = null;
  let loadError = null;
  try {
    script = await getScript(scriptId);
  } catch (error) {
    loadError = error;
  }

  if (loadError) {
    return readerFallback(ctx, {
      title: 'The script could not be opened',
      message: friendlyErrorMessage(loadError, 'Reading the local database failed. Try again or return to the library.'),
      iconName: 'warning',
      actions: [
        { label: 'Try again', icon: 'refresh', primary: true, onClick: () => ctx.refresh() },
        { label: 'Back to library', icon: 'arrowLeft', onClick: () => ctx.navigate('/library') },
      ],
    });
  }
  if (!script) {
    return readerFallback(ctx, {
      title: 'Script not found',
      message: 'This script is no longer in the local library. It may have been permanently deleted or the link may be out of date.',
      iconName: 'search',
      actions: [
        { label: 'Browse library', icon: 'library', primary: true, onClick: () => ctx.navigate('/library') },
        { label: 'Dashboard', icon: 'dashboard', onClick: () => ctx.navigate('/') },
      ],
    });
  }
  if (script.deletedAt) {
    return readerFallback(ctx, {
      title: 'This script is in the trash',
      message: `“${script.title}” is deleted. Restore it before reading, so the reader never opens removed content by accident.`,
      iconName: 'trash',
      actions: [
        { label: 'Open trash', icon: 'trash', primary: true, onClick: () => ctx.navigate('/trash') },
      ],
    });
  }
  if (!script.content.trim()) {
    return readerFallback(ctx, {
      title: 'This script is empty',
      message: 'Add some words in the editor, then return here to rehearse. Empty scripts cannot be scrolled or timed.',
      iconName: 'fileText',
      actions: [
        { label: 'Open editor', icon: 'pencil', primary: true, onClick: () => ctx.navigate(`/editor/${encodeURIComponent(script.id)}`) },
        { label: 'Back to library', icon: 'arrowLeft', onClick: () => ctx.navigate('/library') },
      ],
    });
  }

  let contentHtml;
  try {
    contentHtml = renderScriptHtml(script.content, script.contentFormat, { forReader: true });
  } catch (error) {
    return readerFallback(ctx, {
      title: 'This script could not be rendered',
      message: friendlyErrorMessage(error, 'The stored content could not be prepared for reading. Open the editor to inspect it.'),
      iconName: 'warning',
      actions: [
        { label: 'Open editor', icon: 'pencil', primary: true, onClick: () => ctx.navigate(`/editor/${encodeURIComponent(script.id)}`) },
      ],
    });
  }

  const settingsStore = ctx.settingsStore;
  const initialReader = settingsStore.get().reader;
  const words = Math.max(0, Number(script.wordCount) || countWords(script.content));

  const state = {
    destroyed: false,
    initialized: false,
    script,
    status: 'ready',
    maxScroll: 0,
    progress: 0,
    countdownArmed: true,
    countdownActive: false,
    countdownTimer: null,
    countdownEndsAt: 0,
    countdownLastValue: null,
    controlsVisible: true,
    chromeTimer: null,
    lastPointerShow: 0,
    elapsedMs: 0,
    playStartedAt: null,
    timerInterval: null,
    timerRefreshInterval: null,
    lastPersistAt: 0,
    positionSaveTimer: null,
    saveChain: Promise.resolve(),
    positionErrorShown: false,
    initialToastShown: false,
    direction: initialReader.direction,
    endcardOpen: false,
    endcardFocusReturn: null,
    endcardAnnouncement: '',
    drawerOpen: false,
    voiceOpen: false,
    voiceController: null,
    voiceIndex: null,
    voiceFallbackPlaying: false,
    cameraOpen: false,
    recorder: null,
    cameraRecording: false,
    cameraPaused: false,
    cameraLastRecording: null,
    remoteOpen: false,
    remoteHost: null,
    remoteSession: null,
    remoteInterval: null,
    remoteQrUrl: '',
    remoteQrObjectUrl: '',
    shortcutsEnabled: initialReader.shortcutsEnabled,
    lastRemoteSentAt: 0,
    lastProgressPaint: 0,
  };

  let engine = null;
  let shortcutController = null;
  let settingsUnsubscribe = null;
  let resizeObserver = null;
  let layoutFrame = null;
  let drawerPanel = null;
  let voicePanel = null;
  let cameraPanel = null;
  let remotePanel = null;
  let drawerApi = null;
  let voiceApi = null;
  let cameraApi = null;
  let remoteApi = null;
  const listeners = [];

  function listen(target, type, handler, options = undefined) {
    if (!target) return () => {};
    target.addEventListener(type, handler, options);
    listeners.push({ target, type, handler, options });
    return () => target.removeEventListener(type, handler, options);
  }

  function getReader() {
    return settingsStore.get().reader;
  }

  function getSettings() {
    return settingsStore.get();
  }

  function setReader(patch) {
    return settingsStore.setReader(patch);
  }

  function isAnyPanelOpen() {
    return state.drawerOpen || state.voiceOpen || state.cameraOpen || state.remoteOpen;
  }

  /* ============================================================
     Reader markup
     ============================================================ */

  const screen = h('div', {
    class: 'reader-screen',
    dataset: { readerTheme: initialReader.theme, playing: 'false', controlsHidden: 'false' },
    'aria-label': `Teleprompter reading ${script.title}`,
  });
  defaultReaderStyle(screen);

  const content = h('article', {
    class: 'reader-content',
    'aria-label': script.title,
  });
  content.innerHTML = contentHtml; // Sanitised by renderScriptHtml.

  const contentWrap = h('div', { class: 'reader-content-wrap' }, content);
  const scroll = h('div', {
    class: 'reader-scroll',
    tabindex: '0',
    'aria-label': 'Script text. Scroll manually with a mouse, touch, or arrow keys while paused.',
  });
  scroll.append(contentWrap);

  const topFade = h('div', { class: 'reader-fade reader-fade--top', 'aria-hidden': 'true' });
  const bottomFade = h('div', { class: 'reader-fade reader-fade--bottom', 'aria-hidden': 'true' });
  const focusLine = h('div', { class: 'reader-focus-line', 'aria-hidden': 'true' });

  const statusMessage = h('span', { text: STATUS_LABELS.ready });
  const statusPill = h(
    'div',
    { class: 'reader-status-pill', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    h('span', { class: 'reader-status-dot', 'aria-hidden': 'true' }),
    statusMessage,
  );

  const topbarMeta = h('div', { class: 'reader-topbar__meta' });
  const topbarName = h('div', { class: 'reader-topbar__name', text: script.title });
  const topbarTitle = h('div', { class: 'reader-topbar__title' }, topbarName, topbarMeta);

  function topButton(iconName, label, onClick, { pressed = null, text = null, className = '' } = {}) {
    const element = h('button', {
      type: 'button',
      class: `reader-btn ${text ? '' : 'reader-btn--icon'}${className ? ` ${className}` : ''}`.trim(),
      'aria-label': label,
      title: label,
    });
    if (pressed != null) element.setAttribute('aria-pressed', String(pressed));
    element.append(iconSpan(iconName, { size: 16 }));
    if (text) element.append(h('span', { class: 'reader-btn__label', text }));
    element.addEventListener('click', onClick);
    return element;
  }

  const exitButton = topButton('arrowLeft', 'Exit reader and return to the library', () => exitReader(), {
    text: 'Exit',
    className: 'reader-btn--exit',
  });
  const mirrorButton = topButton('flipHorizontal', `Mirror mode: ${initialReader.mirror}`, () => cycleMirror());
  const voiceButton = topButton('mic', 'Voice following', () => toggleVoicePanel(), { pressed: false });
  const cameraButton = topButton('camera', 'Camera and local recording', () => toggleCameraPanel(), { pressed: false });
  const remoteButton = topButton('smartphone', 'Remote control', () => toggleRemotePanel(), { pressed: false });
  const drawerButton = topButton('sliders', 'Reading settings', () => toggleReaderDrawer(), { pressed: false });
  const fullscreenButton = topButton('maximize', 'Enter fullscreen', () => toggleFullscreen(), { pressed: false });

  const topbar = h(
    'header',
    { class: 'reader-topbar' },
    exitButton,
    topbarTitle,
    statusPill,
    h('div', { class: 'reader-topbar__actions' }, mirrorButton, voiceButton, cameraButton, remoteButton, drawerButton, fullscreenButton),
  );

  const elapsedText = h('span', { text: '00:00' });
  const remainingText = h('span', { text: '— left' });
  const timerTarget = h('span', { class: 'reader-timer__target' });
  const timerEl = h(
    'div',
    { class: 'reader-timer', 'aria-label': 'Elapsed and estimated remaining reading time' },
    elapsedText,
    h('span', { class: 'reader-timer__sep', 'aria-hidden': 'true' }),
    remainingText,
    timerTarget,
  );

  const progressFill = h('div', { class: 'reader-progress__fill' });
  const progressTrack = h('div', { class: 'reader-progress__track' }, progressFill);
  const progressBar = h(
    'div',
    {
      class: 'reader-progress',
      role: 'slider',
      tabindex: '0',
      'aria-label': 'Reading progress. Drag to change position.',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '0',
      'aria-valuetext': '0% through the script',
    },
    progressTrack,
  );

  const controls = h('div', { class: 'reader-controls', 'aria-label': 'Playback controls' });

  const startOverButton = h('button', {
    type: 'button',
    class: 'reader-control',
    title: 'Restart from the beginning',
    'aria-label': 'Restart from the beginning',
  });
  startOverButton.append(iconSpan('restart', { size: 15 }));
  startOverButton.addEventListener('click', () => restartPlayback());

  function jumpButton(iconName, label, onClick) {
    const buttonEl = h('button', {
      type: 'button',
      class: 'reader-control',
      title: label,
      'aria-label': label,
    });
    buttonEl.append(iconSpan(iconName, { size: 15 }));
    buttonEl.addEventListener('click', onClick);
    return buttonEl;
  }

  const jumpBackButton = jumpButton('arrowLeft', 'Back ten seconds of reading', () => jumpReadingSeconds(-10));
  const jumpForwardButton = jumpButton('arrowRight', 'Forward ten seconds of reading', () => jumpReadingSeconds(10));
  const endButton = jumpButton('chevronDown', 'Jump to the end of the script', () => jumpToReadingEnd());
  const stopButton = jumpButton('stop', 'Stop playback but keep the current position', () => stopPlayback());

  const playButton = h('button', {
    type: 'button',
    class: 'reader-control reader-control--main',
    'aria-label': 'Start reading',
    title: 'Start reading (Space)',
  });
  playButton.innerHTML = icon('play', { size: 20 });
  playButton.addEventListener('click', () => togglePlayback());

  const speedLabel = h('span', { class: 'reader-speed__value', text: `${initialReader.speed} wpm` });
  const speedInput = h('input', {
    type: 'range',
    min: '40',
    max: '400',
    step: '1',
    value: String(initialReader.speed),
    'aria-label': 'Reading speed in words per minute',
    title: 'Reading speed',
  });
  speedInput.addEventListener('input', () => setSpeed(Number(speedInput.value), { fromSlider: true }));
  const speedDownButton = jumpButton('chevronDown', 'Decrease speed', () => setSpeed(getReader().speed - 5));
  const speedUpButton = jumpButton('chevronUp', 'Increase speed', () => setSpeed(getReader().speed + 5));
  speedDownButton.classList.add('reader-control--text');
  speedUpButton.classList.add('reader-control--text');

  const controlsSettingsButton = jumpButton('sliders', 'Reading settings', () => toggleReaderDrawer());
  const controlsMirrorButton = jumpButton('flipHorizontal', 'Cycle mirror mode', () => cycleMirror());

  controls.append(
    h('div', { class: 'reader-controls__group' }, startOverButton, jumpBackButton, playButton, jumpForwardButton, endButton, stopButton),
    h('span', { class: 'reader-controls__divider', 'aria-hidden': 'true' }),
    h('div', { class: 'reader-controls__group reader-controls__group--grow reader-speed' }, speedDownButton, speedInput, speedLabel, speedUpButton),
    h('span', { class: 'reader-controls__divider', 'aria-hidden': 'true' }),
    h('div', { class: 'reader-controls__group reader-controls__group--optional' }, controlsMirrorButton, controlsSettingsButton),
  );

  const hint = h('div', { class: 'reader-hint', text: 'Space play/pause · F fullscreen · C controls · Esc exit' });

  const countdownNumber = h('div', { class: 'reader-countdown__number', text: '3' });
  const countdownLabel = h('div', { class: 'reader-countdown__label', text: 'Get ready to read' });
  const countdownActions = h('div', { class: 'reader-endcard__actions' });
  const countdownStartNow = button('Start now', {
    iconName: 'play',
    size: 'sm',
    variant: 'primary',
    onClick: () => skipCountdown(),
  });
  const countdownCancel = button('Cancel', {
    iconName: 'x',
    size: 'sm',
    onClick: () => cancelCountdown({ rememberFocus: true }),
  });
  countdownActions.append(countdownStartNow, countdownCancel);
  const countdown = h(
    'div',
    { class: 'reader-countdown', hidden: true, role: 'status', 'aria-live': 'assertive' },
    h(
      'div',
      { class: 'reader-countdown__inner' },
      countdownNumber,
      countdownLabel,
      countdownActions,
      h('div', { class: 'reader-countdown__hint', text: 'Space starts now · Esc cancels' }),
    ),
  );

  const endcardTitle = h('h2', { text: 'You reached the end' });
  const endcardText = h('p', { text: '' });
  const endcardActions = h('div', { class: 'reader-endcard__actions' });
  const readAgainButton = button('Read again', { iconName: 'restart', variant: 'primary' });
  const editEndButton = button('Edit script', {
    iconName: 'pencil',
    onClick: () => ctx.navigate(`/editor/${encodeURIComponent(script.id)}`),
  });
  const libraryEndButton = button('Library', {
    iconName: 'library',
    onClick: () => ctx.navigate('/library'),
  });
  endcardActions.append(readAgainButton, editEndButton, libraryEndButton);
  const endcard = h(
    'div',
    { class: 'reader-endcard', 'data-open': 'false', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'reader-end-title' },
    h(
      'div',
      { class: 'reader-endcard__inner' },
      h('div', { class: 'reader-endcard__icon', html: icon('check', { size: 26 }) }),
      endcardTitle,
      endcardText,
      endcardActions,
    ),
  );
  endcardTitle.id = 'reader-end-title';

  screen.append(scroll, topFade, bottomFade, focusLine, progressBar, topbar, timerEl, controls, hint, countdown, endcard);

  /* ============================================================
     Playback engine and timers
     ============================================================ */

  function metrics() {
    return computePlaybackMetrics({
      maxScroll: state.maxScroll,
      wordCount: words,
      wpm: getReader().speed,
      direction: getReader().direction,
    });
  }

  engine = new ScrollEngine({
    getMaxScroll: () => state.maxScroll,
    getPixelsPerSecond: () => metrics().signedPixelsPerSecond,
    getPosition: () => scroll.scrollTop,
    setPosition: (position) => {
      scroll.scrollTop = position;
    },
    onTick: (snapshot) => {
      paintProgress(snapshot.position);
      if (Date.now() - state.lastPersistAt > 5000) schedulePositionPersist(0);
    },
    onStateChange: (status) => {
      if (state.destroyed) return;
      if (status === 'playing') {
        startTimer();
        setStatus('playing');
        scheduleChromeHide();
        broadcastRemote();
      } else if (status === 'paused') {
        stopTimer();
        setStatus('paused');
        showControls();
        schedulePositionPersist(300);
        broadcastRemote();
      } else if (status === 'reset') {
        setStatus('ready');
      }
    },
    onReachEnd: () => handleReachEnd(),
  });

  function formatSpeedValue(value) {
    return `${value} wpm`;
  }

  function updateMeta() {
    const reader = getReader();
    topbarMeta.replaceChildren(
      h('span', { text: `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}` }),
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('span', { text: formatSpeedValue(reader.speed) }),
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('span', { text: directionWord(reader.direction) }),
    );
  }

  function setStatus(status) {
    state.status = status;
    statusMessage.textContent = STATUS_LABELS[status] || status;
    statusPill.classList.toggle('reader-status-pill--live', status === 'playing' || status === 'countdown' || status === 'voice');
    statusPill.classList.toggle('reader-status-pill--error', status === 'error');
    statusPill.dataset.status = status;
    const playing = Boolean(engine?.playing);
    screen.dataset.playing = String(playing);
    const iconName = playing ? 'pause' : 'play';
    const label = playing ? 'Pause reading' : status === 'stopped' ? 'Resume reading' : 'Start reading';
    playButton.innerHTML = icon(iconName, { size: 20 });
    playButton.setAttribute('aria-label', label);
    playButton.title = `${label} (Space)`;
    remoteApi?.renderState?.(remoteState());
    updateHint();
  }

  function updateHint() {
    let text;
    if (!state.controlsVisible) {
      text = `Controls hidden · ${state.shortcutsEnabled ? 'C to show · ' : ''}Esc to exit`;
    } else if (state.voiceController?.active) {
      text = 'Voice following is driving the position · manual scrolling stays available';
    } else if (engine?.playing) {
      text = 'Space pause · ←/→ jump 10s · Esc exit';
    } else if (state.status === 'finished') {
      text = 'Reading complete · choose an option or press R to restart';
    } else {
      text = 'Space play/pause · F fullscreen · C controls · Esc exit';
    }
    hint.textContent = text;
  }

  function paintProgress(position = scroll.scrollTop) {
    const reader = getReader();
    const progress = positionToProgress(position, state.maxScroll, reader.direction);
    state.progress = progress;
    const percent = Math.round(progress * 1000) / 10;
    progressFill.style.transform = `scaleX(${clamp(progress, 0, 1).toFixed(5)})`;
    progressBar.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    progressBar.setAttribute('aria-valuetext', `${percent}% through the script`);
    refreshTimer();
    updatePlayAvailability();
    state.lastProgressPaint = performance.now();
  }

  function updatePlayAvailability() {
    const unavailable = state.maxScroll <= 0.5;
    playButton.disabled = unavailable;
    if (unavailable) {
      playButton.title = 'This script has no scrollable content. Add text in the editor.';
    }
    if (unavailable && state.status === 'ready') setStatus('ready');
  }

  function startTimer() {
    if (state.timerInterval) return;
    state.playStartedAt = performance.now();
    state.timerInterval = setInterval(refreshTimer, 250);
    refreshTimer();
  }

  function stopTimer() {
    if (state.playStartedAt != null) {
      state.elapsedMs += performance.now() - state.playStartedAt;
      state.playStartedAt = null;
    }
    clearInterval(state.timerInterval);
    state.timerInterval = null;
    refreshTimer();
  }

  function currentElapsedMs() {
    return state.elapsedMs + (state.playStartedAt != null ? performance.now() - state.playStartedAt : 0);
  }

  function refreshTimer() {
    if (state.destroyed) return;
    const elapsed = currentElapsedMs();
    elapsedText.textContent = readerClock(elapsed);
    const reader = getReader();
    if (state.maxScroll > 0.5) {
      const total = metrics().totalSeconds;
      const remaining = Math.max(0, (1 - state.progress) * total);
      remainingText.textContent = `${formatDuration(remaining)} left`;
    } else {
      remainingText.textContent = '— left';
    }
    const targetMinutes = Number(reader.targetDurationMinutes) || 0;
    if (targetMinutes > 0) {
      const targetMs = targetMinutes * 60_000;
      const difference = targetMs - elapsed;
      timerTarget.hidden = false;
      timerTarget.textContent = difference >= 0 ? `${readerClock(difference)} under target` : `${readerClock(-difference)} over target`;
      timerTarget.classList.toggle('reader-timer__target--over', difference < 0);
    } else {
      timerTarget.hidden = true;
      timerTarget.textContent = '';
      timerTarget.classList.remove('reader-timer__target--over');
    }
  }

  function setSpeed(value, { fromSlider = false } = {}) {
    const next = clamp(Math.round(Number(value) || getReader().speed), 40, 400);
    const current = getReader().speed;
    if (next === current) {
      speedLabel.textContent = formatSpeedValue(current);
      if (!fromSlider) speedInput.value = String(current);
      return current;
    }
    if (!fromSlider) speedInput.value = String(next);
    speedLabel.textContent = formatSpeedValue(next);
    setReader({ speed: next });
    refreshTimer();
    updateMeta();
    broadcastRemote();
    return next;
  }

  function changeFontSize(delta) {
    const next = clamp(Math.round(getReader().fontSize + delta), 20, 160);
    setReader({ fontSize: next });
    toast(`Reader text size: ${next}px`, { type: 'info', duration: 1600 });
    return next;
  }

  function mirrorSequence(current) {
    const order = ['none', 'horizontal', 'vertical', 'both'];
    return order[(order.indexOf(current) + 1) % order.length];
  }

  function cycleMirror() {
    const next = mirrorSequence(getReader().mirror);
    setReader({ mirror: next });
    const label = MIRROR_OPTIONS.find((option) => option.value === next)?.label || next;
    toast(`Mirror mode: ${label}`, { type: 'info', duration: 1600 });
    broadcastRemote();
    return next;
  }

  function applyReaderSettings({ initial = false } = {}) {
    const reader = getReader();
    const colors = resolveReaderColors(reader);
    screen.dataset.readerTheme = reader.theme;
    screen.style.setProperty('--custom-bg', reader.bgColor);
    screen.style.setProperty('--custom-text', reader.textColor);
    screen.style.setProperty('--custom-accent', reader.accentColor);
    screen.style.setProperty('--reader-bg', colors.bg);
    screen.style.setProperty('--reader-text', colors.text);
    screen.style.setProperty('--reader-accent', colors.accent);
    screen.style.setProperty('--reader-font', getFontStack(reader.fontFamily));
    screen.style.setProperty('--reader-font-size', `${reader.fontSize}px`);
    screen.style.setProperty('--reader-font-weight', String(reader.fontWeight));
    screen.style.setProperty('--reader-line-height', String(reader.lineHeight));
    screen.style.setProperty('--reader-letter-spacing', `${reader.letterSpacing}em`);
    screen.style.setProperty('--reader-para-spacing', `${reader.paragraphSpacing}em`);
    screen.style.setProperty('--reader-align', reader.textAlign);
    screen.style.setProperty('--reader-width', `${reader.maxWidth}px`);
    screen.style.setProperty('--reader-margin', `${reader.horizontalMargin}vw`);
    screen.style.setProperty('--reader-top-pad', `${reader.verticalPosition}vh`);
    screen.style.setProperty('--reader-bottom-pad', `${100 - reader.verticalPosition}vh`);
    screen.style.setProperty('--reader-focus-position', `${reader.verticalPosition}vh`);

    screen.classList.toggle('mirror-x', reader.mirror === 'horizontal' || reader.mirror === 'both');
    screen.classList.toggle('mirror-y', reader.mirror === 'vertical' || reader.mirror === 'both');
    screen.classList.toggle('mirror-both', reader.mirror === 'both');

    topFade.hidden = !reader.focusFade;
    bottomFade.hidden = !reader.focusFade;
    focusLine.hidden = !reader.focusLine;
    progressBar.hidden = !reader.progressVisible;
    timerEl.hidden = !reader.timerVisible;
    speedInput.value = String(reader.speed);
    speedLabel.textContent = formatSpeedValue(reader.speed);
    mirrorButton.setAttribute('aria-label', `Mirror mode: ${MIRROR_OPTIONS.find((option) => option.value === reader.mirror)?.label || reader.mirror}`);
    mirrorButton.setAttribute('title', `Mirror mode: ${MIRROR_OPTIONS.find((option) => option.value === reader.mirror)?.label || reader.mirror}`);
    updateMeta();
    drawerApi?.sync?.();
    voiceApi?.sync?.();
    if (!initial) {
      state.shortcutsEnabled = reader.shortcutsEnabled;
      updateShortcutController();
      if (!reader.autoHideControls && state.chromeTimer) {
        clearTimeout(state.chromeTimer);
        state.chromeTimer = null;
        showControls({ scheduleHide: false });
      }
      scheduleLayoutMeasure();
    }
  }

  function measureLayout() {
    state.maxScroll = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    return state.maxScroll;
  }

  function scheduleLayoutMeasure() {
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = null;
      if (state.destroyed || !state.initialized) return;
      const progress = state.progress;
      measureLayout();
      const target = progressToPosition(progress, state.maxScroll, getReader().direction);
      scroll.scrollTop = target;
      paintProgress(target);
    });
  }

  /* ============================================================
     Playback actions
     ============================================================ */

  function isAtReadingStart() {
    return state.progress <= 0.002;
  }

  function isAtReadingEnd() {
    return state.progress >= 0.998;
  }

  function startPlaybackNow() {
    hideEndcard({ restoreFocus: false });
    state.countdownActive = false;
    countdown.hidden = true;
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
    state.countdownArmed = false;
    const started = engine.play();
    if (!started) {
      toast('There is no scrollable content to play. Add more text in the editor.', {
        type: 'info',
        title: 'Nothing to scroll',
      });
      setStatus('ready');
      return false;
    }
    setStatus('playing');
    scheduleChromeHide();
    return true;
  }

  function beginCountdown(seconds) {
    if (state.countdownActive) return;
    const duration = clamp(Number(seconds) || 0, 1, 10);
    state.countdownActive = true;
    state.countdownLastValue = null;
    countdown.hidden = false;
    setStatus('countdown');
    state.countdownEndsAt = performance.now() + duration * 1000;
    const tick = () => {
      if (state.destroyed || !state.countdownActive) return;
      const remaining = Math.ceil((state.countdownEndsAt - performance.now()) / 1000);
      if (remaining !== state.countdownLastValue) {
        state.countdownLastValue = remaining;
        countdownNumber.textContent = String(Math.max(1, remaining));
        countdownLabel.textContent = remaining <= 1 ? 'Start reading now' : 'Get ready to read';
      }
      if (remaining <= 0) {
        clearInterval(state.countdownTimer);
        state.countdownTimer = null;
        state.countdownActive = false;
        countdown.hidden = true;
        startPlaybackNow();
        return;
      }
    };
    state.countdownTimer = setInterval(tick, 90);
    tick();
  }

  function skipCountdown() {
    if (!state.countdownActive) return false;
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
    state.countdownActive = false;
    countdown.hidden = true;
    startPlaybackNow();
    return true;
  }

  function cancelCountdown({ rememberFocus = false } = {}) {
    if (!state.countdownActive) return false;
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
    state.countdownActive = false;
    countdown.hidden = true;
    setStatus('ready');
    if (rememberFocus) drawerButton.focus({ preventScroll: true });
    return true;
  }

  function play() {
    if (engine.playing || state.countdownActive) return true;
    hideEndcard({ restoreFocus: false });
    if (state.maxScroll <= 0.5) measureLayout();
    if (state.maxScroll <= 0.5) {
      toast('There is no scrollable content to play. Add more text in the editor.', {
        type: 'info',
        title: 'Nothing to scroll',
      });
      return false;
    }
    engine.syncPosition(scroll.scrollTop);
    const reader = getReader();
    const countdownSeconds = Number(reader.countdownSeconds) || 0;
    const atStart = isAtReadingStart();
    const atEnd = isAtReadingEnd();
    if (reader.countdownEnabled && countdownSeconds > 0 && (state.countdownArmed || atStart || atEnd)) {
      beginCountdown(countdownSeconds);
      return true;
    }
    return startPlaybackNow();
  }

  function pausePlayback({ fromUser = true } = {}) {
    if (state.countdownActive) {
      cancelCountdown();
      return true;
    }
    const paused = engine.pause();
    if (paused) {
      showControls({ scheduleHide: false });
      schedulePositionPersist(250);
    }
    if (fromUser) updateHint();
    return paused;
  }

  function togglePlayback() {
    if (state.countdownActive) {
      skipCountdown();
      return;
    }
    if (state.endcardOpen) {
      restartPlayback({ autoPlay: true });
      return;
    }
    if (engine.playing) pausePlayback();
    else play();
  }

  function stopPlayback() {
    cancelCountdown();
    hideEndcard({ restoreFocus: false });
    engine.pause();
    setStatus('stopped');
    showControls({ scheduleHide: false });
    schedulePositionPersist(0);
    broadcastRemote();
  }

  function restartPlayback({ autoPlay = false } = {}) {
    cancelCountdown();
    hideEndcard({ restoreFocus: false });
    engine.pause();
    state.elapsedMs = 0;
    state.playStartedAt = null;
    clearInterval(state.timerInterval);
    state.timerInterval = null;
    const startPosition = getReader().direction === 'reverse' ? state.maxScroll : 0;
    engine.seekTo(startPosition);
    state.countdownArmed = true;
    setStatus('ready');
    paintProgress(startPosition);
    refreshTimer();
    showControls({ scheduleHide: false });
    schedulePositionPersist(0);
    broadcastRemote();
    if (autoPlay) play();
  }

  function jumpToReadingStart() {
    state.elapsedMs = state.elapsedMs;
    engine.seekTo(getReader().direction === 'reverse' ? state.maxScroll : 0);
    state.countdownArmed = true;
    showControls({ scheduleHide: false });
    schedulePositionPersist(250);
    updateHint();
    broadcastRemote();
  }

  function jumpToReadingEnd() {
    engine.seekTo(getReader().direction === 'reverse' ? 0 : state.maxScroll);
    state.countdownArmed = false;
    showControls({ scheduleHide: false });
    schedulePositionPersist(250);
    broadcastRemote();
  }

  function jumpReadingSeconds(seconds) {
    const playback = metrics();
    const distance = playback.pixelsPerSecond * Number(seconds || 0);
    engine.seekTo(clamp(scroll.scrollTop + distance, 0, state.maxScroll));
    schedulePositionPersist(250);
    broadcastRemote();
  }

  function seekProgress(progress, { announce = false } = {}) {
    const value = clamp(Number(progress) || 0, 0, 1);
    const position = progressToPosition(value, state.maxScroll, getReader().direction);
    engine.seekTo(position);
    if (value <= 0.002) state.countdownArmed = true;
    schedulePositionPersist(250);
    if (announce) {
      toast(`${Math.round(value * 100)}% through the script.`, { type: 'info', duration: 1400 });
    }
    broadcastRemote();
  }

  function handleReachEnd() {
    if (state.destroyed) return;
    stopTimer();
    const behavior = getReader().endBehavior;
    if (behavior === 'loop') {
      state.elapsedMs = 0;
      const start = getReader().direction === 'reverse' ? state.maxScroll : 0;
      engine.seekTo(start);
      state.countdownArmed = false;
      setStatus('playing');
      engine.play();
      return;
    }
    state.countdownArmed = true;
    if (behavior === 'return') {
      state.elapsedMs = 0;
      engine.seekTo(getReader().direction === 'reverse' ? state.maxScroll : 0);
      paintProgress(scroll.scrollTop);
      showEndcard({
        title: 'Returned to the beginning',
        message: 'The end behavior is set to return to the start. You can read it again whenever you are ready.',
      });
    } else {
      setStatus('finished');
      showEndcard({
        title: 'You reached the end',
        message: `Finished in ${readerClock(currentElapsedMs())} at ${getReader().speed} words per minute.`,
      });
    }
    schedulePositionPersist(0);
    broadcastRemote();
  }

  function showEndcard({ title, message }) {
    if (state.endcardOpen) return;
    state.endcardOpen = true;
    state.endcardFocusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    endcardTitle.textContent = title;
    endcardText.textContent = message;
    endcard.dataset.open = 'true';
    playButton.innerHTML = icon('play', { size: 20 });
    requestAnimationFrame(() => readAgainButton.focus({ preventScroll: true }));
    broadcastRemote();
  }

  function hideEndcard({ restoreFocus = true } = {}) {
    if (!state.endcardOpen) return;
    state.endcardOpen = false;
    endcard.dataset.open = 'false';
    if (restoreFocus && state.endcardFocusReturn?.isConnected) {
      state.endcardFocusReturn.focus({ preventScroll: true });
    }
    state.endcardFocusReturn = null;
  }

  readAgainButton.addEventListener('click', () => restartPlayback({ autoPlay: true }));

  /* ============================================================
     Position persistence
     ============================================================ */

  function positionSnapshot() {
    return {
      progress: clamp(state.progress, 0, 1),
      scrollTop: Math.max(0, scroll.scrollTop),
      updatedAt: nowIso(),
    };
  }

  function schedulePositionPersist(delay = 900) {
    clearTimeout(state.positionSaveTimer);
    state.positionSaveTimer = setTimeout(() => {
      state.positionSaveTimer = null;
      persistPosition();
    }, Math.max(0, delay));
  }

  function persistPosition() {
    if (state.destroyed && !state.saveOnCleanup) return;
    const snapshot = positionSnapshot();
    state.lastPersistAt = Date.now();
    state.saveChain = state.saveChain
      .catch(() => {})
      .then(async () => {
        await bulkUpdateScripts([script.id], (record) => {
          if (record.deletedAt) return record;
          return { ...record, lastPosition: snapshot };
        });
        script.lastPosition = snapshot;
      })
      .catch((error) => {
        console.warn('Could not save reading position', error);
        if (!state.positionErrorShown) {
          state.positionErrorShown = true;
          toast('The reading position could not be saved. The script itself is unchanged; use Backups for your content.', {
            type: 'warning',
            title: 'Position not saved',
          });
        }
      });
    return state.saveChain;
  }

  /* ============================================================
     Fullscreen and chrome visibility
     ============================================================ */

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function updateFullscreenButton() {
    const active = Boolean(fullscreenElement());
    if (active) {
      fullscreenButton.innerHTML = icon('minimize', { size: 16 });
      fullscreenButton.setAttribute('aria-label', 'Exit fullscreen');
      fullscreenButton.setAttribute('title', 'Exit fullscreen');
      fullscreenButton.setAttribute('aria-pressed', 'true');
    } else {
      fullscreenButton.innerHTML = icon('maximize', { size: 16 });
      fullscreenButton.setAttribute('aria-label', 'Enter fullscreen');
      fullscreenButton.setAttribute('title', 'Enter fullscreen');
      fullscreenButton.setAttribute('aria-pressed', 'false');
    }
  }

  async function toggleFullscreen() {
    try {
      if (fullscreenElement()) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else document.webkitExitFullscreen?.();
        return;
      }
      if (screen.requestFullscreen) await screen.requestFullscreen();
      else if (screen.webkitRequestFullscreen) screen.webkitRequestFullscreen();
      else {
        toast('Fullscreen is unavailable in this browser. The reader already fills the window.', {
          type: 'info',
          title: 'Fullscreen unavailable',
        });
      }
    } catch (error) {
      toast(
        `Fullscreen could not be entered (${friendlyErrorMessage(error, 'the browser denied it')}). The reader is still using the full window.`,
        { type: 'warning', title: 'Fullscreen blocked' },
      );
    }
  }

  function canAutoHide() {
    return getReader().autoHideControls && engine?.playing && !state.countdownActive && !isAnyPanelOpen() && !state.endcardOpen;
  }

  function scheduleChromeHide() {
    clearTimeout(state.chromeTimer);
    state.chromeTimer = null;
    if (!canAutoHide()) return;
    state.chromeTimer = setTimeout(() => {
      state.chromeTimer = null;
      if (!canAutoHide() || state.controlsVisible === false) return;
      state.controlsVisible = false;
      controls.classList.add('reader-controls--hidden');
      screen.dataset.controlsHidden = 'true';
      updateHint();
    }, 3200);
  }

  function showControls({ scheduleHide = true } = {}) {
    clearTimeout(state.chromeTimer);
    state.chromeTimer = null;
    state.controlsVisible = true;
    controls.classList.remove('reader-controls--hidden');
    screen.dataset.controlsHidden = 'false';
    updateHint();
    if (scheduleHide) scheduleChromeHide();
  }

  function toggleControls() {
    if (state.controlsVisible) {
      state.controlsVisible = false;
      controls.classList.add('reader-controls--hidden');
      screen.dataset.controlsHidden = 'true';
      clearTimeout(state.chromeTimer);
      state.chromeTimer = null;
    } else {
      showControls({ scheduleHide: !engine.playing ? false : true });
    }
    updateHint();
  }

  function onUserMouseMove() {
    const now = performance.now();
    if (now - state.lastPointerShow < 180) return;
    state.lastPointerShow = now;
    if (!state.controlsVisible) showControls();
    else if (canAutoHide()) scheduleChromeHide();
  }

  /* ============================================================
     Remote state
     ============================================================ */

  function remoteState() {
    const playback = metrics();
    const remaining = clamp(1 - state.progress, 0, 1) * playback.totalSeconds;
    return {
      title: script.title,
      progress: clamp(state.progress, 0, 1),
      speed: getReader().speed,
      playing: Boolean(engine?.playing),
      remainingSeconds: Math.round(remaining),
      status: state.status,
      direction: getReader().direction,
    };
  }

  function broadcastRemote() {
    if (!state.remoteHost) return;
    state.remoteHost.broadcastState(remoteState());
    state.lastRemoteSentAt = Date.now();
  }

  function handleRemoteCommand(command) {
    switch (command) {
      case 'playPause':
        togglePlayback();
        break;
      case 'play':
        if (!engine.playing && !state.countdownActive) play();
        break;
      case 'pause':
        pausePlayback();
        break;
      case 'restart':
        restartPlayback();
        break;
      case 'stop':
        stopPlayback();
        break;
      case 'speedUp':
        setSpeed(getReader().speed + 10);
        break;
      case 'speedDown':
        setSpeed(getReader().speed - 10);
        break;
      case 'jumpBack':
        jumpReadingSeconds(-10);
        break;
      case 'jumpForward':
        jumpReadingSeconds(10);
        break;
      case 'jumpStart':
        jumpToReadingStart();
        break;
      case 'jumpEnd':
        jumpToReadingEnd();
        break;
      default:
        return;
    }
    setTimeout(broadcastRemote, 40);
    setTimeout(refreshTimer, 0);
  }

  /* ============================================================
     Keyboard shortcuts
     ============================================================ */

  function shouldIgnoreShortcut(event) {
    if (event.target instanceof Element) {
      const tag = event.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target.isContentEditable) return true;
    }
    return false;
  }

  function updateShortcutController() {
    const enabled = Boolean(getReader().shortcutsEnabled);
    if (shortcutController && (!enabled || state.shortcutsEnabled !== enabled)) {
      shortcutController.destroy();
      shortcutController = null;
    }
    state.shortcutsEnabled = enabled;
    if (!enabled) {
      updateHint();
      return;
    }
    if (shortcutController) {
      shortcutController.setSettings(getSettings());
      return;
    }
    shortcutController = new ShortcutController({
      settings: getSettings(),
      getEnabled: () => !state.destroyed,
      shouldIgnore: shouldIgnoreShortcut,
      handlers: {
        playPause: () => {
          if (state.countdownActive) skipCountdown();
          else togglePlayback();
        },
        restart: () => restartPlayback(),
        speedUp: () => setSpeed(getReader().speed + 5),
        speedDown: () => setSpeed(getReader().speed - 5),
        jumpBack: () => jumpReadingSeconds(-10),
        jumpForward: () => jumpReadingSeconds(10),
        jumpStart: () => jumpToReadingStart(),
        jumpEnd: () => jumpToReadingEnd(),
        fullscreen: () => toggleFullscreen(),
        mirror: () => cycleMirror(),
        fontUp: () => changeFontSize(4),
        fontDown: () => changeFontSize(-4),
        toggleControls: () => toggleControls(),
        toggleHelp: () => ctx.openHelp(),
        voice: () => toggleVoicePanel(),
        exit: () => handleEscape(),
      },
    });
    updateHint();
  }

  function handleEscape() {
    if (state.countdownActive) {
      cancelCountdown({ rememberFocus: true });
      return;
    }
    if (drawerPanel?.isOpen) {
      closeReaderDrawer();
      return;
    }
    if (voicePanel?.isOpen) {
      closeVoicePanel();
      return;
    }
    if (cameraPanel?.isOpen) {
      closeCameraPanel();
      return;
    }
    if (remotePanel?.isOpen) {
      closeRemotePanel();
      return;
    }
    if (state.endcardOpen) {
      hideEndcard();
      return;
    }
    if (fullscreenElement()) {
      toggleFullscreen();
      return;
    }
    exitReader();
  }

  /* ============================================================
     Navigation and lifecycle
     ============================================================ */

  function exitReader() {
    if (state.cameraRecording) {
      confirmDialog({
        title: 'Recording in progress',
        message: 'Leaving the reader now will stop the camera and discard the unfinished take.',
        confirmLabel: 'Stop and leave',
        danger: true,
        details: ['Stop the recording first if you need to download the take.'],
      }).then((confirmed) => {
        if (confirmed) ctx.navigate('/library');
      });
      return;
    }
    ctx.navigate('/library');
  }

  async function leaveGuard() {
    if (!state.cameraRecording) return true;
    return confirmDialog({
      title: 'Stop recording and leave?',
      message: 'The camera is still recording. Leaving stops the camera and discards the unfinished recording.',
      confirmLabel: 'Stop and leave',
      danger: true,
      details: ['Stop the recording from the camera dock first if you want to keep it.'],
    });
  }

  function cleanup() {
    if (state.destroyed) return;
    state.destroyed = true;
    state.saveOnCleanup = true;
    clearTimeout(state.positionSaveTimer);
    clearInterval(state.countdownTimer);
    clearInterval(state.timerInterval);
    clearInterval(state.remoteInterval);
    clearTimeout(state.chromeTimer);
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    if (state.playStartedAt != null) {
      state.elapsedMs += performance.now() - state.playStartedAt;
      state.playStartedAt = null;
    }
    if (!state.initialized) state.maxScroll = 0;
    engine?.destroy();
    shortcutController?.destroy();
    settingsUnsubscribe?.();
    resizeObserver?.disconnect();
    for (const { target, type, handler, options } of listeners) {
      target.removeEventListener(type, handler, options);
    }
    listeners.length = 0;
    try {
      voiceApi?.destroy?.();
    } catch {
      // Media cleanup is best effort on navigation.
    }
    try {
      remoteApi?.destroy?.();
    } catch {
      // Close the remote channel even if the page is going away.
    }
    try {
      cameraApi?.destroy?.();
    } catch {
      // Stop camera tracks even if the browser rejects teardown.
    }
    if (state.initialized) persistPosition();
    settingsStore.saveNow?.().catch?.(() => {});
    if (fullscreenElement() === screen || fullscreenElement() === document.documentElement) {
      (document.exitFullscreen ? document.exitFullscreen() : Promise.resolve()).catch(() => {});
    }
    document.body.classList.remove('reader-active');
  }

  /* ============================================================
     Initialization
     ============================================================ */

  function applySavedPosition() {
    const reader = getReader();
    const saved = reader.restorePosition ? script.lastPosition : null;
    if (!saved || !Number.isFinite(Number(saved.progress))) {
      engine.seekTo(reader.direction === 'reverse' ? state.maxScroll : 0);
      paintProgress(scroll.scrollTop);
      return;
    }
    const progress = clamp(Number(saved.progress), 0, 1);
    if (progress >= 0.995) {
      engine.seekTo(reader.direction === 'reverse' ? state.maxScroll : 0);
      paintProgress(scroll.scrollTop);
      if (!state.initialToastShown) {
        state.initialToastShown = true;
        toast('The last reading session reached the end. Starting from the top.', {
          type: 'info',
          title: 'Start from the top',
          duration: 6000,
        });
      }
      return;
    }
    if (progress <= 0.005) {
      engine.seekTo(reader.direction === 'reverse' ? state.maxScroll : 0);
      paintProgress(scroll.scrollTop);
      return;
    }
    const position = progressToPosition(progress, state.maxScroll, reader.direction);
    engine.seekTo(position);
    paintProgress(position);
    state.countdownArmed = false;
    if (!state.initialToastShown) {
      state.initialToastShown = true;
      toast(`Resumed ${Math.round(progress * 100)}% into “${script.title}”.`, {
        type: 'info',
        title: 'Reading position restored',
        duration: 9000,
        actions: [
          {
            label: 'Start over',
            onClick: () => restartPlayback(),
          },
        ],
      });
    }
  }

  function initializeReader() {
    if (state.destroyed || state.initialized) return;
    state.initialized = true;
    document.body.classList.add('reader-active');
    applyReaderSettings({ initial: true });
    measureLayout();
    applySavedPosition();
    refreshTimer();
    updateShortcutController();
    settingsUnsubscribe = settingsStore.subscribe(() => {
      const reader = getReader();
      const previousDirection = state.direction;
      if (!state.initialized) return;
      if (previousDirection !== reader.direction) {
        const progress = state.progress;
        engine.pause();
        state.direction = reader.direction;
        measureLayout();
        const position = progressToPosition(progress, state.maxScroll, reader.direction);
        engine.seekTo(position);
        paintProgress(position);
        state.countdownArmed = progress <= 0.002;
      }
      applyReaderSettings();
    });
    measureLayout();
    scheduleLayoutMeasure();
    broadcastRemote();
  }

  /* ============================================================
     Reading settings drawer
     ============================================================ */

  const drawerSyncers = [];
  const drawerBackdrop = h('div', {
    class: 'reader-drawer-backdrop',
    'data-open': 'false',
    'aria-hidden': 'true',
  });
  const drawerClose = h('button', {
    type: 'button',
    class: 'btn btn--icon btn--sm btn--ghost',
    'aria-label': 'Close reading settings',
    html: icon('x', { size: 16 }),
  });
  const drawerTitle = h('h2', {
    class: 'reader-drawer__title',
    id: 'reader-drawer-title',
    text: 'Reading settings',
  });
  const drawerEl = h(
    'aside',
    {
      class: 'reader-drawer',
      'data-open': 'false',
      role: 'dialog',
      'aria-modal': 'false',
      'aria-labelledby': 'reader-drawer-title',
      inert: true,
    },
    h(
      'div',
      { class: 'reader-drawer__head' },
      h('div', {}, drawerTitle, h('div', { class: 'field-hint', text: 'Changes apply to the reader immediately.' })),
      drawerClose,
    ),
  );
  const drawerBody = h('div', { class: 'reader-drawer__body' });
  const drawerFooter = h('div', { class: 'reader-drawer__footer' });

  function readerRange({ label, key, min, max, step = 1, suffix = '', format = null, help = null, enabled = null }) {
    const initial = getReader()[key];
    const field = createRange({
      label,
      value: initial,
      min,
      max,
      step,
      suffix,
      format,
      help,
      onChange: (value) => setReader({ [key]: value }),
    });
    const input = field.querySelector('input[type="range"]');
    const output = field.querySelector('.label__value');
    drawerSyncers.push(() => {
      const value = getReader()[key];
      input.value = String(value);
      output.textContent = format ? format(value) : `${value}${suffix}`;
      const available = enabled ? enabled(getReader()) : true;
      input.disabled = !available;
      field.dataset.disabled = String(!available);
    });
    return field;
  }

  function readerSelect({ label, key, options, help = null }) {
    const field = createSelect({
      label,
      value: getReader()[key],
      options,
      help,
      onChange: (value) => setReader({ [key]: value }),
    });
    const select = field.querySelector('select');
    drawerSyncers.push(() => {
      select.value = getReader()[key];
    });
    return field;
  }

  function readerSwitch({ label, description, key }) {
    const element = createSwitch({
      checked: Boolean(getReader()[key]),
      label,
      description,
      onChange: (checked) => setReader({ [key]: checked }),
    });
    const input = element.querySelector('input');
    drawerSyncers.push(() => {
      input.checked = Boolean(getReader()[key]);
    });
    return element;
  }

  const themeSelect = readerSelect({
    label: 'Theme',
    key: 'theme',
    options: READER_THEMES.map((theme) => ({ value: theme.id, label: theme.name })),
  });

  const customColorsGroup = h('div', { class: 'reader-settings-group', style: { gap: '8px' } });
  const customColorFields = [
    ['bgColor', 'Background'],
    ['textColor', 'Text'],
    ['accentColor', 'Accent'],
  ].map(([key, label]) => {
    const initial = getReader()[key];
    const field = createColorInput({
      label,
      value: initial,
      onChange: (value) => setReader({ [key]: value }),
    });
    const colorInput = field.querySelector('input[type="color"]');
    const textInput = field.querySelector('input[type="text"]');
    drawerSyncers.push(() => {
      const value = getReader()[key];
      colorInput.value = value;
      if (document.activeElement !== textInput) textInput.value = value;
    });
    return field;
  });
  customColorsGroup.append(
    h('h3', { text: 'Custom colors' }),
    ...customColorFields,
    h('div', {
      class: 'field-hint',
      text: 'Only the Custom theme uses these colors. Other themes keep their accessible palettes.',
    }),
  );
  const contrastHint = h('div', { class: 'field-hint', role: 'status' });
  customColorsGroup.append(contrastHint);

  drawerBody.append(
    h(
      'div',
      { class: 'reader-settings-group' },
      h('h3', { text: 'Typography' }),
      readerSelect({
        label: 'Font',
        key: 'fontFamily',
        options: FONT_FAMILY_OPTIONS,
      }),
      readerRange({
        label: 'Text size',
        key: 'fontSize',
        min: 20,
        max: 160,
        suffix: 'px',
      }),
      readerRange({
        label: 'Font weight',
        key: 'fontWeight',
        min: 300,
        max: 900,
        step: 50,
      }),
      readerRange({
        label: 'Line height',
        key: 'lineHeight',
        min: 1.1,
        max: 2.6,
        step: 0.05,
        format: (value) => Number(value).toFixed(2),
      }),
      readerRange({
        label: 'Letter spacing',
        key: 'letterSpacing',
        min: -0.05,
        max: 0.25,
        step: 0.01,
        format: (value) => `${Number(value).toFixed(2)}em`,
      }),
      readerRange({
        label: 'Paragraph spacing',
        key: 'paragraphSpacing',
        min: 0,
        max: 3,
        step: 0.1,
        format: (value) => `${Number(value).toFixed(1)}×`,
      }),
    ),
    h(
      'div',
      { class: 'reader-settings-group' },
      h('h3', { text: 'Layout' }),
      readerSelect({
        label: 'Text alignment',
        key: 'textAlign',
        options: TEXT_ALIGN_OPTIONS,
      }),
      readerRange({
        label: 'Text width',
        key: 'maxWidth',
        min: 360,
        max: 1600,
        step: 20,
        suffix: 'px',
      }),
      readerRange({
        label: 'Side margins',
        key: 'horizontalMargin',
        min: 0,
        max: 20,
        suffix: 'vw',
      }),
      readerRange({
        label: 'Focus line position',
        key: 'verticalPosition',
        min: 15,
        max: 75,
        suffix: '% from top',
      }),
      readerSwitch({
        label: 'Fade above and below',
        description: 'Softens the edges around the focus area.',
        key: 'focusFade',
      }),
      readerSwitch({
        label: 'Focus line',
        description: 'Shows a subtle guide at the reading position.',
        key: 'focusLine',
      }),
    ),
    h(
      'div',
      { class: 'reader-settings-group' },
      h('h3', { text: 'Theme and color' }),
      themeSelect,
      customColorsGroup,
    ),
    h(
      'div',
      { class: 'reader-settings-group' },
      h('h3', { text: 'Playback' }),
      readerRange({
        label: 'Reading speed',
        key: 'speed',
        min: 40,
        max: 400,
        suffix: ' wpm',
      }),
      readerSelect({
        label: 'Direction',
        key: 'direction',
        options: [
          { value: 'forward', label: 'Forward (top to bottom)' },
          { value: 'reverse', label: 'Reverse (bottom to top)' },
        ],
      }),
      readerSwitch({
        label: 'Countdown before starting',
        description: 'Gives you time to get ready. Space skips it.',
        key: 'countdownEnabled',
      }),
      readerRange({
        label: 'Countdown length',
        key: 'countdownSeconds',
        min: 1,
        max: 10,
        suffix: 's',
        enabled: (reader) => reader.countdownEnabled,
      }),
      readerSelect({
        label: 'At the end of the script',
        key: 'endBehavior',
        options: END_BEHAVIOR_OPTIONS,
      }),
      readerSwitch({
        label: 'Pause when I scroll by hand',
        description: 'Prevents timed scrolling from fighting a manual adjustment.',
        key: 'pauseOnManualScroll',
      }),
      readerSwitch({
        label: 'Restore my last position',
        description: 'Reopen this script where you stopped reading.',
        key: 'restorePosition',
      }),
    ),
    h(
      'div',
      { class: 'reader-settings-group' },
      h('h3', { text: 'Chrome and shortcuts' }),
      readerSelect({
        label: 'Mirror',
        key: 'mirror',
        options: MIRROR_OPTIONS,
      }),
      readerSwitch({
        label: 'Hide controls while playing',
        description: 'Move the pointer or press C to reveal them.',
        key: 'autoHideControls',
      }),
      readerSwitch({
        label: 'Show progress bar',
        key: 'progressVisible',
      }),
      readerSwitch({
        label: 'Show timers',
        key: 'timerVisible',
      }),
      readerRange({
        label: 'Target duration',
        key: 'targetDurationMinutes',
        min: 0,
        max: 600,
        step: 5,
        format: (value) => (Number(value) > 0 ? `${value} min` : 'Off'),
        help: 'Zero turns the target comparison off.',
      }),
      readerSwitch({
        label: 'Keyboard shortcuts',
        description: 'Disable this if you use the keys for another assistive tool.',
        key: 'shortcutsEnabled',
      }),
    ),
  );

  drawerFooter.append(
    button('Reset', {
      iconName: 'refresh',
      size: 'sm',
      onClick: async () => {
        const confirmed = await confirmDialog({
          title: 'Reset reader settings?',
          message: 'Typography, theme, speed, mirroring, countdown, and reader shortcuts return to their defaults. Scripts and presets are not changed.',
          confirmLabel: 'Reset defaults',
          iconName: 'refresh',
        });
        if (!confirmed) return;
        settingsStore.resetSection('reader');
        toast('Reader settings returned to their defaults.', { type: 'success' });
      },
    }),
    button('Full settings', {
      iconName: 'settings',
      size: 'sm',
      onClick: () => {
        closeReaderDrawer({ restoreFocus: false });
        ctx.navigate('/settings?section=reader');
      },
    }),
    button('Done', {
      variant: 'primary',
      size: 'sm',
      className: 'ml-auto',
      onClick: () => closeReaderDrawer(),
    }),
  );
  drawerEl.append(drawerBody, drawerFooter);
  screen.append(drawerBackdrop, drawerEl);

  function syncDrawer() {
    const reader = getReader();
    for (const sync of drawerSyncers) {
      try {
        sync();
      } catch (error) {
        console.error('Reader settings control failed to update', error);
      }
    }
    customColorsGroup.hidden = reader.theme !== 'custom';
    const colors = resolveReaderColors(reader);
    const lowContrast = isLowContrast(colors.text, colors.bg, 4.5);
    contrastHint.hidden = !lowContrast;
    contrastHint.textContent = lowContrast
      ? 'This combination is below the WCAG AA contrast target for normal text. Consider a lighter text color or a darker background.'
      : '';
  }

  function openReaderDrawer() {
    if (state.drawerOpen) return;
    state.drawerOpen = true;
    drawerEl.inert = false;
    drawerEl.dataset.open = 'true';
    drawerBackdrop.dataset.open = 'true';
    drawerButton.setAttribute('aria-pressed', 'true');
    controlsSettingsButton.setAttribute('aria-pressed', 'true');
    drawerButton.classList.add('reader-btn--active');
    syncDrawer();
    showControls({ scheduleHide: false });
    requestAnimationFrame(() => drawerClose.focus({ preventScroll: true }));
  }

  function closeReaderDrawer({ restoreFocus = true } = {}) {
    if (!state.drawerOpen) return;
    state.drawerOpen = false;
    drawerEl.dataset.open = 'false';
    drawerBackdrop.dataset.open = 'false';
    drawerEl.inert = true;
    drawerButton.setAttribute('aria-pressed', 'false');
    controlsSettingsButton.removeAttribute('aria-pressed');
    drawerButton.classList.remove('reader-btn--active');
    if (restoreFocus) drawerButton.focus({ preventScroll: true });
  }

  function toggleReaderDrawer() {
    if (state.drawerOpen) closeReaderDrawer();
    else openReaderDrawer();
  }

  drawerClose.addEventListener('click', () => closeReaderDrawer());
  drawerBackdrop.addEventListener('click', () => closeReaderDrawer());
  drawerEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeReaderDrawer();
  });

  drawerApi = {
    get isOpen() {
      return state.drawerOpen;
    },
    open: openReaderDrawer,
    close: closeReaderDrawer,
    sync: syncDrawer,
    destroy() {
      closeReaderDrawer({ restoreFocus: false });
    },
  };

  /* ============================================================
     Voice following
     ============================================================ */

  const voiceSyncers = [];
  let voiceSilencePaused = false;
  const voiceStatusLabels = {
    idle: 'Not listening',
    starting: 'Starting microphone…',
    listening: 'Listening for your voice',
    speech: 'Hearing you',
    restarting: 'Reconnecting…',
    stopped: 'Voice follow off',
    unsupported: 'Speech recognition unavailable',
    denied: 'Microphone permission denied',
    'no-microphone': 'No microphone found',
    network: 'Recognition service unavailable',
    error: 'Recognition error',
    closed: 'Voice follow off',
  };

  const voiceClose = h('button', {
    type: 'button',
    class: 'reader-btn reader-btn--icon',
    'aria-label': 'Close voice following',
    html: icon('x', { size: 14 }),
  });
  const voiceStatusDot = h('span', { class: 'reader-status-dot', 'aria-hidden': 'true' });
  const voiceStatusText = h('span', { text: voiceStatusLabels.idle });
  const voiceStatusPill = h(
    'div',
    { class: 'voice-panel__status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    voiceStatusDot,
    voiceStatusText,
  );
  const voiceTitle = h('div', { class: 'voice-panel__title', text: 'Voice following' });
  const voiceExplanation = h('div', {
    class: 'voice-panel__text',
    text: 'Follow the script with your voice. Recognition is optional and conservative: it waits for clear speech and never jumps backwards. Timed playback pauses when listening starts; press Play if you want both together.',
  });
  const voiceLanguageField = createTextInput({
    label: 'Recognition language',
    value: getReader().voiceLanguage,
    placeholder: 'en-US',
    maxlength: 20,
    help: 'A BCP-47 language tag such as en-US. Browser recognition support varies by language and may require a network connection.',
    onChange: (value) => {
      const language = String(value || '').trim().slice(0, 20) || 'en-US';
      setReader({ voiceLanguage: language });
      state.voiceController?.setLanguage?.(language);
    },
  });
  voiceLanguageField.querySelector('input').setAttribute('autocomplete', 'off');
  const voiceLanguageInput = voiceLanguageField.querySelector('input');
  const voiceSensitivityField = createRange({
    label: 'Sensitivity',
    value: getReader().voiceSensitivity,
    min: 0.1,
    max: 1,
    step: 0.05,
    format: (value) => `${Math.round(value * 100)}%`,
    help: 'Higher values accept looser matches and skip more words. Lower values are stricter.',
    onChange: (value) => {
      setReader({ voiceSensitivity: value });
      state.voiceController?.setSensitivity?.(value);
    },
  });
  const voiceSensitivityInput = voiceSensitivityField.querySelector('input');
  const voiceSensitivityOutput = voiceSensitivityField.querySelector('.label__value');
  const voicePauseSwitch = createSwitch({
    label: 'Pause timed scrolling when I stop speaking',
    description: 'Only applies when timed playback and voice following are both running.',
    checked: getReader().voicePauseOnSilence,
    onChange: (checked) => setReader({ voicePauseOnSilence: checked }),
  });
  const voicePauseCheckbox = voicePauseSwitch.querySelector('input');
  const voiceTranscript = h('div', {
    class: 'voice-panel__transcript',
    role: 'status',
    'aria-live': 'polite',
    text: 'Your recognized words will appear here.',
  });
  const voiceNote = h('div', {
    class: 'voice-panel__text',
    style: { marginTop: '8px' },
    text: 'Microphone audio is handled by your browser’s speech service. Depending on the browser, recognition may send audio to a vendor service and may require internet access. This app never stores or uploads the audio itself.',
  });
  const voiceToggle = button('Start listening', {
    iconName: 'mic',
    variant: 'primary',
    size: 'sm',
  });
  const voicePanelEl = h(
    'section',
    {
      class: 'voice-panel',
      'data-open': 'false',
      role: 'dialog',
      'aria-modal': 'false',
      'aria-label': 'Voice following',
    },
    h(
      'div',
      { class: 'voice-panel__row' },
      h('div', {}, voiceTitle, voiceStatusPill),
      voiceClose,
    ),
    voiceExplanation,
    h(
      'div',
      { class: 'voice-panel__controls' },
      voiceToggle,
      h('span', { class: 'field-hint', text: 'Manual speed controls always remain available.' }),
    ),
    voiceLanguageField,
    voiceSensitivityField,
    voicePauseSwitch,
    voiceTranscript,
    voiceNote,
  );
  screen.append(voicePanelEl);

  function syncVoicePanel() {
    const reader = getReader();
    if (document.activeElement !== voiceLanguageInput) voiceLanguageInput.value = reader.voiceLanguage;
    voiceSensitivityInput.value = String(reader.voiceSensitivity);
    voiceSensitivityOutput.textContent = `${Math.round(reader.voiceSensitivity * 100)}%`;
    voicePauseCheckbox.checked = Boolean(reader.voicePauseOnSilence);
  }

  function setVoiceUiStatus(status, detail = {}) {
    const label = voiceStatusLabels[status] || voiceStatusLabels.idle;
    voiceStatusText.textContent = label;
    voiceStatusPill.dataset.state = status;
    voiceStatusDot.dataset.state = status;
    const active = Boolean(state.voiceController?.active);
    voiceToggle.innerHTML = '';
    voiceToggle.append(
      iconSpan(active ? 'micOff' : 'mic', { size: 14 }),
      h('span', { text: active ? 'Stop listening' : 'Start listening' }),
    );
    voiceToggle.setAttribute('aria-pressed', String(active));
    voiceButton.setAttribute('aria-pressed', String(active));
    if (status === 'denied') {
      voiceTranscript.textContent = 'Microphone access was denied. Allow microphone access in the browser’s site settings, then try again.';
    } else if (status === 'no-microphone') {
      voiceTranscript.textContent = 'No microphone was found. Connect a microphone or check the system input device.';
    } else if (status === 'unsupported') {
      voiceTranscript.textContent = 'This browser does not provide the Web Speech recognition API. Timed scrolling and the speed controls still work.';
    } else if (status === 'network') {
      voiceTranscript.textContent = 'The browser could not reach its recognition service. Voice follow may require an internet connection in this browser.';
    } else if (status === 'error') {
      voiceTranscript.textContent = friendlyErrorMessage(detail.error, 'Speech recognition stopped unexpectedly. Try starting it again.');
    } else if (status === 'idle' || status === 'stopped' || status === 'closed') {
      voiceTranscript.textContent = 'Your recognized words will appear here.';
    }
  }

  function alignToVoiceToken(token) {
    if (!token || state.voiceIndex == null) return;
    const range = rangeForToken(state.voiceIndex, token);
    if (!range) return;
    const rangeRect = range.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    if (!rangeRect.width && !rangeRect.height) return;
    const focusY = scrollRect.top + scrollRect.height * (getReader().verticalPosition / 100);
    const target = clamp(scroll.scrollTop + (rangeRect.top - focusY), 0, state.maxScroll);
    if (Math.abs(target - scroll.scrollTop) > 2) {
      engine.seekTo(target);
      state.countdownArmed = false;
      showControls({ scheduleHide: false });
    }
  }

  function destroyVoiceController() {
    if (!state.voiceController) return;
    const controller = state.voiceController;
    state.voiceController = null;
    state.voiceIndex = null;
    voiceSilencePaused = false;
    try {
      controller.destroy();
    } catch {
      // The recognition engine can throw while shutting down.
    }
  }

  function stopVoiceFollow({ restoreReaderStatus = true } = {}) {
    if (!state.voiceController) {
      setVoiceUiStatus('idle');
      return;
    }
    const controller = state.voiceController;
    try {
      controller.stop({ reason: 'user' });
    } catch {
      // Continue with local teardown.
    }
    if (state.voiceController === controller) {
      destroyVoiceController();
    }
    setVoiceUiStatus('stopped');
    if (restoreReaderStatus && state.status === 'voice') {
      setStatus(engine.playing ? 'playing' : 'paused');
    }
    updateHint();
    broadcastRemote();
  }

  function beginVoiceFollow() {
    if (!VoiceFollowController.isSupported()) {
      setVoiceUiStatus('unsupported');
      toast(
        'This browser does not support speech recognition. Use timed scrolling or the keyboard and remote controls instead.',
        { type: 'info', title: 'Voice following unavailable' },
      );
      return false;
    }
    if (engine.playing) pausePlayback({ fromUser: false });
    destroyVoiceController();
    state.voiceIndex = buildRenderedTextIndex(content);
    if (!state.voiceIndex.tokens.length) {
      setVoiceUiStatus('error', { error: new Error('There is no readable words in this script.') });
      toast('There are no readable words for voice matching in this script.', { type: 'warning', title: 'Nothing to follow' });
      return false;
    }
    const reader = getReader();
    const initialCursor = Math.min(
      state.voiceIndex.tokens.length - 1,
      Math.max(0, Math.floor(state.progress * state.voiceIndex.tokens.length)),
    );
    const index = state.voiceIndex;
    const controller = new VoiceFollowController({
      language: reader.voiceLanguage || 'en-US',
      sensitivity: reader.voiceSensitivity,
      pauseOnSilence: reader.voicePauseOnSilence,
      scriptTokens: index.normalizedTokens,
      cursor: initialCursor,
      onStatus: (status, detail) => {
        if (state.voiceController !== controller && status !== 'starting') return;
        setVoiceUiStatus(status, detail);
        if (status === 'listening' || status === 'speech') {
          if (state.status !== 'voice') setStatus('voice');
        } else if (['denied', 'no-microphone', 'network', 'error'].includes(status)) {
          if (state.status === 'voice') setStatus(engine.playing ? 'playing' : 'paused');
          updateHint();
        }
      },
      onTranscript: (text, final) => {
        if (state.voiceController !== controller) return;
        if (text) voiceTranscript.textContent = final ? text : `… ${text}`;
      },
      onMatch: (endIndex, match) => {
        if (state.voiceController !== controller) return;
        const token = index.tokens[endIndex];
        alignToVoiceToken(token);
        voiceStatusText.textContent = `Following · ${match.score >= 0.8 ? 'strong match' : 'reading'}`;
      },
      onSilenceChange: (silent) => {
        if (state.voiceController !== controller) return;
        if (silent) {
          voiceStatusText.textContent = 'Listening · waiting for speech';
          if (getReader().voicePauseOnSilence && engine.playing) {
            voiceSilencePaused = true;
            pausePlayback({ fromUser: false });
          }
        } else {
          if (voiceStatusPill.dataset.state !== 'speech') voiceStatusText.textContent = 'Hearing you';
          if (voiceSilencePaused) {
            voiceSilencePaused = false;
            if (!engine.playing && !state.endcardOpen && !state.countdownActive) engine.play();
          }
        }
      },
      onError: (error) => {
        if (state.voiceController !== controller) return;
        setVoiceUiStatus('error', { error });
        toast(friendlyErrorMessage(error, 'Speech recognition reported an error.'), {
          type: 'error',
          title: 'Voice following stopped',
        });
      },
    });
    state.voiceController = controller;
    setVoiceUiStatus('starting');
    const started = controller.start();
    if (!started && controller.active === false) {
      if (state.voiceController === controller) destroyVoiceController();
      setVoiceUiStatus(VoiceFollowController.isSupported() ? 'error' : 'unsupported');
      return false;
    }
    setStatus('voice');
    setVoiceUiStatus('listening');
    updateHint();
    broadcastRemote();
    return true;
  }

  function toggleVoiceFollow() {
    if (state.voiceController?.active) stopVoiceFollow();
    else beginVoiceFollow();
  }

  function openVoicePanel() {
    if (state.voiceOpen) return;
    state.voiceOpen = true;
    voicePanelEl.dataset.open = 'true';
    voiceButton.setAttribute('aria-pressed', 'true');
    syncVoicePanel();
    setVoiceUiStatus(state.voiceController?.active ? 'listening' : 'idle');
    if (!VoiceFollowController.isSupported()) {
      voiceToggle.disabled = true;
      setVoiceUiStatus('unsupported');
    } else {
      voiceToggle.disabled = false;
    }
    showControls({ scheduleHide: false });
    requestAnimationFrame(() => voiceToggle.focus({ preventScroll: true }));
  }

  function closeVoicePanel({ restoreFocus = true } = {}) {
    if (!state.voiceOpen) return;
    state.voiceOpen = false;
    voicePanelEl.dataset.open = 'false';
    voiceButton.setAttribute('aria-pressed', 'false');
    stopVoiceFollow();
    setVoiceUiStatus('idle');
    if (restoreFocus) voiceButton.focus({ preventScroll: true });
  }

  function toggleVoicePanel() {
    if (state.voiceOpen) closeVoicePanel();
    else openVoicePanel();
  }

  voiceToggle.addEventListener('click', toggleVoiceFollow);
  voiceClose.addEventListener('click', () => closeVoicePanel());
  voicePanelEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeVoicePanel();
  });
  voiceSyncers.push(syncVoicePanel);

  voiceApi = {
    get isOpen() {
      return state.voiceOpen;
    },
    get active() {
      return Boolean(state.voiceController?.active);
    },
    open: openVoicePanel,
    close: closeVoicePanel,
    sync: syncVoicePanel,
    syncCursorFromProgress() {
      if (!state.voiceController?.active || !state.voiceIndex?.tokens.length) return;
      const cursor = Math.min(
        state.voiceIndex.tokens.length - 1,
        Math.max(0, Math.floor(state.progress * state.voiceIndex.tokens.length)),
      );
      state.voiceController.setCursor(cursor);
    },
    destroy() {
      closeVoicePanel({ restoreFocus: false });
      destroyVoiceController();
    },
  };

  /* ============================================================
     Camera and local recording
     ============================================================ */

  let selectedVideoDeviceId = '';
  let selectedAudioDeviceId = '';
  let lastCameraErrorAt = 0;
  let lastCameraErrorMessage = '';

  function cameraErrorMessage(error) {
    const name = error?.name || '';
    if (!navigator.mediaDevices?.getUserMedia) {
      return 'Camera access needs a browser with getUserMedia and a secure context (HTTPS or localhost). Preview and recording are unavailable here.';
    }
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Camera or microphone permission was denied. Allow access from the browser’s site settings, then try again.';
    }
    if (name === 'NotFoundError') {
      return 'No camera or microphone was found. Connect a device and try again.';
    }
    if (name === 'OverconstrainedError') {
      return 'The selected quality or device is not supported by this camera. Try another camera or a lower quality.';
    }
    if (name === 'NotReadableError' || name === 'AbortError') {
      return 'The camera is already in use by another application or tab. Close it there, then try again.';
    }
    return friendlyErrorMessage(error, 'The camera or microphone could not be started.');
  }

  function reportCameraError(error) {
    const message = cameraErrorMessage(error);
    const now = Date.now();
    if (message === lastCameraErrorMessage && now - lastCameraErrorAt < 1600) return;
    lastCameraErrorMessage = message;
    lastCameraErrorAt = now;
    toast(message, { type: 'error', title: 'Camera unavailable', duration: 9000 });
  }

  const cameraVideo = h('video', {
    autoplay: true,
    muted: true,
    playsinline: true,
    'aria-label': 'Live camera preview',
  });
  cameraVideo.hidden = true;
  const cameraRecDot = h('span', { class: 'camera-dock__rec', 'aria-hidden': 'true' });
  const cameraBarText = h('span', { class: 'camera-dock__state', text: 'Camera off' });
  const cameraDuration = h('span', { class: 'camera-dock__duration', text: '00:00' });
  const cameraCloseButton = h('button', {
    type: 'button',
    class: 'camera-dock__close',
    'aria-label': 'Close camera panel',
    html: icon('x', { size: 13 }),
  });
  const cameraBar = h(
    'div',
    { class: 'camera-dock__bar' },
    cameraRecDot,
    cameraBarText,
    cameraDuration,
    cameraCloseButton,
  );

  const cameraQualityField = createSelect({
    label: 'Recording quality',
    value: getSettings().recording.videoQuality,
    options: Object.entries(RECORDING_QUALITIES).map(([value, quality]) => ({ value, label: quality.label })),
    onChange: (value) => {
      settingsStore.update({ recording: { videoQuality: value } });
      if (state.recorder?.previewing) startCameraPreview();
    },
  });
  const cameraQualitySelect = cameraQualityField.querySelector('select');
  const cameraMicSwitch = createSwitch({
    label: 'Record microphone audio',
    description: 'Uses the selected microphone. Turn off for a silent screen recording.',
    checked: getSettings().recording.includeMic,
    onChange: (checked) => {
      settingsStore.update({ recording: { includeMic: checked } });
      selectedAudioDeviceId = '';
      if (state.recorder?.previewing) startCameraPreview();
    },
  });
  const cameraMicCheckbox = cameraMicSwitch.querySelector('input');
  const cameraDeviceField = createSelect({
    label: 'Camera',
    value: '',
    options: [{ value: '', label: 'Default camera' }],
    onChange: (value) => {
      selectedVideoDeviceId = value;
      if (state.recorder?.previewing) startCameraPreview();
    },
  });
  const cameraDeviceSelect = cameraDeviceField.querySelector('select');
  const cameraDeviceWrap = cameraDeviceField;
  const microphoneDeviceField = createSelect({
    label: 'Microphone',
    value: '',
    options: [{ value: '', label: 'Default microphone' }],
    onChange: (value) => {
      selectedAudioDeviceId = value;
      if (state.recorder?.previewing) startCameraPreview();
    },
  });
  const microphoneDeviceSelect = microphoneDeviceField.querySelector('select');
  const microphoneDeviceWrap = microphoneDeviceField;

  const cameraEnableButton = button('Enable camera', {
    iconName: 'video',
    variant: 'primary',
    size: 'sm',
  });
  const cameraDisableButton = button('Stop camera', {
    iconName: 'camera',
    size: 'sm',
  });
  const cameraRecordButton = button('Record', {
    iconName: 'record',
    size: 'sm',
  });
  const cameraPauseButton = button('Pause', {
    iconName: 'pause',
    size: 'sm',
  });
  const cameraStopRecordButton = button('Stop & keep', {
    iconName: 'stop',
    size: 'sm',
  });
  const cameraSupportNote = h('div', { class: 'camera-dock__note' });

  const cameraSetup = h(
    'div',
    { class: 'camera-dock__setup' },
    cameraQualityField,
    cameraMicSwitch,
    cameraDeviceWrap,
    microphoneDeviceWrap,
    h('div', { class: 'camera-dock__buttons' }, cameraEnableButton, cameraDisableButton, cameraRecordButton, cameraPauseButton, cameraStopRecordButton),
    cameraSupportNote,
  );

  const cameraResultVideo = h('video', { controls: true, playsinline: true, preload: 'metadata' });
  const cameraResultMeta = h('div', { class: 'camera-dock__result-meta' });
  const cameraDownloadLink = h('a', {
    class: 'btn btn--sm btn--primary',
    target: '_blank',
    rel: 'noopener',
  });
  cameraDownloadLink.append(iconSpan('download', { size: 13 }), h('span', { text: 'Download' }));
  const cameraDiscardButton = button('Discard', {
    iconName: 'trash',
    size: 'sm',
  });
  const cameraResult = h(
    'div',
    { class: 'camera-dock__result', hidden: true },
    h('div', { class: 'camera-dock__result-head', text: 'Last take · stays in this tab' }),
    cameraResultVideo,
    cameraResultMeta,
    h('div', { class: 'camera-dock__buttons' }, cameraDownloadLink, cameraDiscardButton),
  );

  const cameraPanelEl = h(
    'section',
    {
      class: 'camera-dock',
      hidden: true,
      role: 'dialog',
      'aria-modal': 'false',
      'aria-label': 'Camera and local recording',
    },
    cameraBar,
    cameraVideo,
    cameraSetup,
    cameraResult,
  );
  screen.append(cameraPanelEl);

  const supportedMimeTypes = getSupportedMimeTypes();

  function updateCameraSupportNote() {
    if (!isCameraRecordingSupported()) {
      cameraSupportNote.textContent =
        'Camera preview and recording need getUserMedia, MediaRecorder, and a secure HTTPS or localhost context. This browser does not provide them, so these controls are unavailable.';
      return;
    }
    const preference = getSettings().recording.preferredMime;
    const mime = pickMimeType(preference);
    cameraSupportNote.textContent = supportedMimeTypes.length
      ? `This browser supports ${supportedMimeTypes.map(describeMime).slice(0, 3).join(', ')}. The take will use ${describeMime(mime)}. Recordings stay in memory until you download or discard them.`
      : 'This browser does not report supported recording formats. The take will use the browser’s default container. Recordings stay in memory until you download or discard them.';
  }

  function setCameraBar(status, text) {
    cameraPanelEl.dataset.state = status;
    cameraBarText.textContent = text;
    const live = status === 'recording';
    cameraRecDot.classList.toggle('camera-dock__rec--live', live);
    cameraDuration.hidden = status !== 'recording' && status !== 'paused';
  }

  function canPauseRecording() {
    return typeof globalThis.MediaRecorder?.prototype?.pause === 'function';
  }

  function renderCameraState() {
    const recorder = state.recorder;
    const previewing = Boolean(recorder?.previewing);
    const recording = Boolean(recorder?.recording);
    const paused = Boolean(recorder?.paused);
    state.cameraRecording = recording;
    cameraVideo.hidden = !previewing;
    cameraEnableButton.hidden = previewing;
    cameraDisableButton.hidden = !previewing;
    cameraRecordButton.hidden = !previewing || recording;
    cameraPauseButton.hidden = !recording || !canPauseRecording();
    cameraStopRecordButton.hidden = !recording;
    cameraPauseButton.innerHTML = '';
    cameraPauseButton.append(
      iconSpan(paused ? 'play' : 'pause', { size: 13 }),
      h('span', { text: paused ? 'Resume' : 'Pause' }),
    );
    cameraQualitySelect.disabled = recording;
    cameraMicCheckbox.disabled = recording;
    cameraDeviceSelect.disabled = recording || !previewing;
    microphoneDeviceSelect.disabled = recording || !previewing || !getSettings().recording.includeMic;
    cameraRecordButton.disabled = !previewing || recording;
    cameraPauseButton.disabled = !recording;
    cameraStopRecordButton.disabled = !recording;
    if (state.cameraLastRecording) renderCameraResult(state.cameraLastRecording);
    else cameraResult.hidden = true;
    if (!state.cameraOpen) return;
    cameraPanelEl.hidden = false;
  }

  function fillDeviceSelect(select, devices, defaultLabel, selected) {
    const previous = selected || select.value;
    select.replaceChildren(h('option', { value: '', text: defaultLabel }));
    for (const device of devices) {
      select.append(h('option', { value: device.deviceId, text: device.label }));
    }
    select.value = [...select.options].some((option) => option.value === previous) ? previous : '';
  }

  function ensureRecorder() {
    if (state.recorder) return state.recorder;
    state.recorder = new CameraRecorder({
      onStatus: (status, detail) => {
        if (state.destroyed) return;
        if (status === 'requesting') {
          setCameraBar('requesting', 'Requesting camera access…');
        } else if (status === 'ready') {
          state.cameraRecording = false;
          setCameraBar('ready', `Camera ready${detail?.hasAudio ? ' · microphone on' : ' · silent'}`);
          if (state.recorder?.stream && cameraVideo.srcObject !== state.recorder.stream) {
            cameraVideo.srcObject = state.recorder.stream;
            cameraVideo.play?.().catch(() => {});
          }
        } else if (status === 'recording') {
          state.cameraRecording = true;
          setCameraBar('recording', `Recording · ${describeMime(detail?.mimeType || '')}`);
        } else if (status === 'paused') {
          state.cameraRecording = true;
          setCameraBar('paused', 'Recording paused');
        } else if (status === 'recorded') {
          state.cameraRecording = false;
          setCameraBar('recorded', 'Take ready');
          if (detail?.recording) {
            state.cameraLastRecording = detail.recording;
            renderCameraResult(detail.recording);
          }
        } else if (status === 'closed') {
          state.cameraRecording = false;
          setCameraBar('closed', 'Camera off');
          cameraVideo.srcObject = null;
          cameraVideo.hidden = true;
        } else if (status === 'disconnected') {
          state.cameraRecording = false;
          setCameraBar('disconnected', 'Camera disconnected');
          cameraVideo.srcObject = null;
          cameraVideo.hidden = true;
        } else if (status === 'microphone-disconnected') {
          cameraBarText.textContent = 'Microphone disconnected';
        } else if (status === 'error') {
          state.cameraRecording = false;
          setCameraBar('error', 'Camera error');
          if (detail?.error) reportCameraError(detail.error);
        }
        renderCameraState();
      },
      onDuration: (_milliseconds, label) => {
        cameraDuration.textContent = label;
      },
      onError: (error) => {
        if (state.destroyed) return;
        reportCameraError(error);
      },
      onRecordingReady: (recording) => {
        if (state.destroyed) return;
        state.cameraLastRecording = recording;
        state.cameraRecording = false;
        renderCameraResult(recording);
        renderCameraState();
        toast(`Your take is ready (${recording.durationLabel}, ${formatBytes(recording.size)}). Download it before leaving the reader.`, {
          type: 'success',
          title: 'Recording complete',
          duration: 8000,
        });
      },
      onDevices: ({ cameras, microphones }) => {
        if (state.destroyed) return;
        fillDeviceSelect(cameraDeviceSelect, cameras, 'Default camera', selectedVideoDeviceId);
        fillDeviceSelect(microphoneDeviceSelect, microphones, 'Default microphone', selectedAudioDeviceId);
        selectedVideoDeviceId = cameraDeviceSelect.value;
        selectedAudioDeviceId = microphoneDeviceSelect.value;
      },
    });
    return state.recorder;
  }

  async function startCameraPreview() {
    if (!isCameraRecordingSupported()) {
      updateCameraSupportNote();
      setCameraBar('unsupported', 'Camera unavailable');
      renderCameraState();
      return false;
    }
    const recorder = ensureRecorder();
    if (recorder.recording) return false;
    cameraEnableButton.disabled = true;
    setButtonBusy(cameraEnableButton, true, 'Starting…');
    setCameraBar('requesting', 'Requesting camera access…');
    try {
      const recording = getSettings().recording;
      await recorder.startPreview({
        quality: recording.videoQuality,
        includeMic: recording.includeMic,
        videoDeviceId: selectedVideoDeviceId,
        audioDeviceId: recording.includeMic ? selectedAudioDeviceId : '',
      });
      if (state.destroyed) return false;
      cameraVideo.srcObject = recorder.stream;
      cameraVideo.hidden = false;
      cameraVideo.play?.().catch(() => {});
      selectedVideoDeviceId = recorder.videoDeviceId || selectedVideoDeviceId;
      selectedAudioDeviceId = recorder.audioDeviceId || selectedAudioDeviceId;
      renderCameraState();
      return true;
    } catch (error) {
      if (state.destroyed) return false;
      setCameraBar('error', 'Camera unavailable');
      reportCameraError(error);
      cameraVideo.hidden = true;
      cameraVideo.srcObject = null;
      renderCameraState();
      return false;
    } finally {
      setButtonBusy(cameraEnableButton, false);
      cameraEnableButton.disabled = false;
      renderCameraState();
    }
  }

  function stopCameraPreview() {
    const recorder = state.recorder;
    if (!recorder) return;
    recorder.stopPreview();
    cameraVideo.srcObject = null;
    cameraVideo.hidden = true;
    state.cameraRecording = false;
    setCameraBar('closed', 'Camera off');
    renderCameraState();
  }

  async function startCameraRecording() {
    const recorder = ensureRecorder();
    if (!recorder.previewing) {
      const started = await startCameraPreview();
      if (!started) return;
    }
    cameraRecordButton.disabled = true;
    setButtonBusy(cameraRecordButton, true, 'Starting…');
    try {
      const started = await recorder.startRecording({ mimePreference: getSettings().recording.preferredMime });
      if (!started) {
        toast('A recording is already in progress.', { type: 'info' });
        return;
      }
      state.cameraRecording = true;
      setCameraBar('recording', 'Recording');
      renderCameraState();
    } catch (error) {
      state.cameraRecording = false;
      setCameraBar('error', 'Recording failed');
      reportCameraError(error);
      renderCameraState();
    } finally {
      setButtonBusy(cameraRecordButton, false);
      renderCameraState();
    }
  }

  function toggleCameraPause() {
    const recorder = state.recorder;
    if (!recorder?.recording) return;
    if (recorder.paused) {
      if (!recorder.resume()) toast('This browser could not resume the recording.', { type: 'warning' });
    } else if (!recorder.pause()) {
      toast('This browser does not support pausing a recording. Continue, or stop and keep the take.', { type: 'info' });
    }
    renderCameraState();
  }

  async function stopCameraRecording() {
    const recorder = state.recorder;
    if (!recorder?.recording) return;
    cameraStopRecordButton.disabled = true;
    setButtonBusy(cameraStopRecordButton, true, 'Finishing…');
    try {
      await recorder.stopRecording();
    } catch (error) {
      reportCameraError(error);
    } finally {
      state.cameraRecording = false;
      setButtonBusy(cameraStopRecordButton, false);
      renderCameraState();
    }
  }

  function recordingFileName(recording) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `${sanitizeFileName(script.title, 'teleprompter')}-${stamp}.${recording.extension || 'webm'}`;
  }

  function renderCameraResult(recording = null) {
    if (!recording) {
      cameraResult.hidden = true;
      cameraResultVideo.removeAttribute('src');
      cameraResultVideo.load?.();
      return;
    }
    if (cameraResultVideo.src !== recording.url) cameraResultVideo.src = recording.url;
    cameraResultMeta.textContent = `${recording.durationLabel} · ${formatBytes(recording.size)} · ${describeMime(recording.mimeType)}`;
    cameraDownloadLink.href = recording.url;
    cameraDownloadLink.download = recordingFileName(recording);
    cameraResult.hidden = false;
  }

  cameraDiscardButton.addEventListener('click', async () => {
    if (!state.cameraLastRecording) return;
    const confirmed = await confirmDialog({
      title: 'Discard this recording?',
      message: 'The take exists only in this browser tab. Discarding it cannot be undone.',
      confirmLabel: 'Discard take',
      danger: true,
      iconName: 'trash',
    });
    if (!confirmed) return;
    try {
      URL.revokeObjectURL(state.cameraLastRecording.url);
    } catch {
      // The URL may already have been released.
    }
    state.cameraLastRecording = null;
    cameraResultVideo.removeAttribute('src');
    cameraResultVideo.load?.();
    cameraResult.hidden = true;
    toast('Recording discarded.', { type: 'info' });
  });

  cameraEnableButton.addEventListener('click', () => startCameraPreview());
  cameraDisableButton.addEventListener('click', () => stopCameraPreview());
  cameraRecordButton.addEventListener('click', () => startCameraRecording());
  cameraPauseButton.addEventListener('click', () => toggleCameraPause());
  cameraStopRecordButton.addEventListener('click', () => stopCameraRecording());

  function openCameraPanel() {
    if (state.cameraOpen) return;
    state.cameraOpen = true;
    cameraPanelEl.hidden = false;
    cameraButton.setAttribute('aria-pressed', 'true');
    updateCameraSupportNote();
    renderCameraState();
    if (!isCameraRecordingSupported()) {
      setCameraBar('unsupported', 'Camera unavailable');
      cameraEnableButton.disabled = true;
    } else {
      cameraEnableButton.disabled = false;
    }
    showControls({ scheduleHide: false });
    requestAnimationFrame(() => {
      const target = state.cameraLastRecording ? cameraResultVideo : state.recorder?.previewing ? cameraDisableButton : cameraEnableButton;
      target?.focus?.({ preventScroll: true });
    });
  }

  async function closeCameraPanel({ restoreFocus = true } = {}) {
    if (!state.cameraOpen) return false;
    if (state.recorder?.recording) {
      const confirmed = await confirmDialog({
        title: 'Stop recording and close the camera?',
        message: 'The camera is still recording. Closing the panel stops the take and keeps it available until you leave the reader.',
        confirmLabel: 'Stop and close',
        danger: true,
        details: ['Reopen the camera panel to download the finished take before leaving.'],
      });
      if (!confirmed) return false;
    }
    if (state.recorder?.recording) {
      try {
        await state.recorder.stopRecording();
      } catch (error) {
        reportCameraError(error);
      }
    }
    if (state.recorder?.previewing) state.recorder.stopPreview();
    cameraVideo.srcObject = null;
    cameraVideo.hidden = true;
    state.cameraRecording = false;
    state.cameraOpen = false;
    cameraPanelEl.hidden = true;
    cameraButton.setAttribute('aria-pressed', 'false');
    setCameraBar('closed', 'Camera off');
    if (restoreFocus) cameraButton.focus({ preventScroll: true });
    return true;
  }

  function toggleCameraPanel() {
    if (state.cameraOpen) closeCameraPanel();
    else openCameraPanel();
  }

  cameraCloseButton.addEventListener('click', () => closeCameraPanel());
  cameraPanelEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeCameraPanel();
  });

  cameraApi = {
    get isOpen() {
      return state.cameraOpen;
    },
    isRecording() {
      return Boolean(state.recorder?.recording || state.cameraRecording);
    },
    open: openCameraPanel,
    close: closeCameraPanel,
    sync: renderCameraState,
    destroy() {
      if (!state.cameraOpen) {
        // Cleanup still needs to release media.
      }
      try {
        if (state.recorder?.recording) state.recorder.stopRecording().catch(() => {});
        state.recorder?.stopPreview?.({ silent: true });
      } catch {
        // Stopping tracks is best effort during navigation.
      }
      cameraVideo.srcObject = null;
      cameraResultVideo.removeAttribute('src');
      const last = state.cameraLastRecording;
      if (last?.url) setTimeout(() => URL.revokeObjectURL(last.url), 30_000);
      try {
        state.recorder?.destroy?.();
      } catch {
        // The page may be closing.
      }
      state.recorder = null;
      state.cameraLastRecording = null;
      state.cameraRecording = false;
      state.cameraOpen = false;
      cameraPanelEl.hidden = true;
      cameraButton.setAttribute('aria-pressed', 'false');
    },
  };

  /* ============================================================
     Same-browser remote control
     ============================================================ */

  const remoteStatusDot = h('span', { class: 'reader-status-dot', 'aria-hidden': 'true' });
  const remoteStatusText = h('span', { text: 'Remote session closed' });
  const remoteStatusPill = h(
    'div',
    { class: 'remote-panel__status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    remoteStatusDot,
    remoteStatusText,
  );
  const remoteClose = h('button', {
    type: 'button',
    class: 'reader-btn reader-btn--icon',
    'aria-label': 'Close remote control',
    html: icon('x', { size: 14 }),
  });
  const remoteTitle = h('div', { class: 'remote-panel__title', text: 'Remote control' });
  const remoteQr = h('div', { class: 'remote-panel__qr' });
  const remoteCode = h('div', { class: 'remote-panel__code', text: '------' });
  const remoteCodeHint = h('div', { class: 'remote-panel__note', text: 'Pairing code' });
  const remoteLink = h('input', {
    class: 'input',
    type: 'text',
    readonly: true,
    'aria-label': 'Remote controller link',
    placeholder: 'Open the panel to create a session',
  });
  const remoteLive = h('div', { class: 'remote-panel__live', 'aria-live': 'polite' });
  const remoteCopyButton = button('Copy link', { iconName: 'copy', size: 'sm' });
  const remoteOpenButton = button('Open controller', { iconName: 'externalLink', size: 'sm' });
  const remoteRevokeButton = button('End session', { iconName: 'x', size: 'sm' });
  const remoteUnsupported = h('div', {
    class: 'remote-panel__note',
    hidden: true,
    text: 'This browser does not provide BroadcastChannel. The local remote cannot connect. Keyboard and Bluetooth keyboard controls still work in the reader.',
  });
  const remotePanelEl = h(
    'section',
    {
      class: 'remote-panel',
      'data-open': 'false',
      role: 'dialog',
      'aria-modal': 'false',
      'aria-label': 'Remote control',
    },
    h('div', { class: 'remote-panel__head' }, h('div', {}, remoteTitle, remoteStatusPill), remoteClose),
    remoteQr,
    remoteCode,
    remoteCodeHint,
    remoteLink,
    remoteLive,
    h('div', { class: 'remote-panel__actions' }, remoteCopyButton, remoteOpenButton, remoteRevokeButton),
    remoteUnsupported,
    h('div', {
      class: 'remote-panel__note',
      text: 'This remote uses BroadcastChannel and works only between tabs or windows of this same browser profile on this device. A phone camera scan cannot connect without a network transport or server, which this local-first build does not include. The session ends when you close this panel or leave the reader.',
    }),
  );
  screen.append(remotePanelEl);

  function setRemoteStatus(status, detail = {}) {
    const labels = {
      idle: 'No active session',
      waiting: 'Waiting for a controller',
      connected: 'Controller connected',
      closed: 'Session ended',
      unsupported: 'Remote unavailable',
    };
    remoteStatusPill.dataset.state = status;
    remoteStatusDot.dataset.state = status;
    remoteStatusText.textContent = labels[status] || 'Waiting for a controller';
    remoteStatusPill.dataset.connected = String(Boolean(detail.connected));
    remoteRevokeButton.disabled = !state.remoteSession;
  }

  async function renderRemoteQr(session) {
    remoteQr.replaceChildren(h('div', { class: 'remote-panel__note', text: 'Generating QR code…' }));
    const url = buildRemoteUrl(session);
    remoteLink.value = url;
    remoteCode.textContent = session.code || '------';
    remoteLive.textContent = 'Waiting for a controller in this browser profile.';
    try {
      const module = await import('qrcode');
      if (state.destroyed || !state.remoteSession || state.remoteSession.sessionId !== session.sessionId) return;
      const QRCode = module.default || module;
      const canvas = h('canvas', {
        width: '304',
        height: '304',
        'aria-label': 'QR code containing the remote controller link',
        role: 'img',
      });
      await QRCode.toCanvas(canvas, url, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 304,
        color: { dark: '#0b1220', light: '#ffffff' },
      });
      if (state.destroyed || !state.remoteSession || state.remoteSession.sessionId !== session.sessionId) return;
      remoteQr.replaceChildren(canvas);
    } catch (error) {
      if (state.destroyed) return;
      console.warn('Could not generate the remote QR code', error);
      remoteQr.replaceChildren(
        h('div', {
          class: 'remote-panel__note',
          text: 'The QR code could not be generated. Use Copy link or Open controller instead.',
        }),
      );
    }
  }

  function stopRemoteSession({ reason = 'user' } = {}) {
    clearInterval(state.remoteInterval);
    state.remoteInterval = null;
    if (state.remoteHost) {
      try {
        state.remoteHost.stop();
      } catch {
        // The channel may already be closed.
      }
    }
    state.remoteHost = null;
    state.remoteSession = null;
    state.remoteQrUrl = '';
    state.remoteQrObjectUrl = '';
    remoteQr.replaceChildren();
    remoteLink.value = '';
    remoteCode.textContent = '------';
    remoteLive.textContent = '';
    setRemoteStatus('closed');
    remoteButton.setAttribute('aria-pressed', 'false');
    if (reason === 'revoked') toast('Remote session ended. Any paired controller is disconnected.', { type: 'info' });
  }

  function startRemoteSession() {
    if (!isRemoteSupported()) {
      setRemoteStatus('unsupported');
      remoteUnsupported.hidden = false;
      remoteCopyButton.disabled = true;
      remoteOpenButton.disabled = true;
      remoteRevokeButton.disabled = true;
      remoteQr.hidden = true;
      remoteLink.hidden = true;
      remoteCode.hidden = true;
      remoteCodeHint.hidden = true;
      return false;
    }
    remoteUnsupported.hidden = true;
    remoteQr.hidden = false;
    remoteLink.hidden = false;
    remoteCode.hidden = false;
    remoteCodeHint.hidden = false;
    stopRemoteSession({ reason: 'replace' });
    const session = createRemoteSession();
    try {
      const host = new RemoteHost({
        session,
        getState: remoteState,
        onCommand: (command) => handleRemoteCommand(command),
        onStatus: (status, detail) => {
          setRemoteStatus(status, detail);
          if (status === 'connected') {
            remoteLive.textContent = 'Connected. Commands act on this reader immediately.';
          } else if (status === 'waiting') {
            remoteLive.textContent = 'Waiting for a controller in this browser profile.';
          } else if (status === 'closed') {
            remoteLive.textContent = 'Session ended.';
          }
        },
      });
      state.remoteSession = session;
      state.remoteHost = host;
      host.start();
      setRemoteStatus('waiting', { connected: false });
      state.remoteInterval = setInterval(() => {
        if (state.remoteHost) state.remoteHost.broadcastState(remoteState());
      }, 2500);
      remoteCopyButton.disabled = false;
      remoteOpenButton.disabled = false;
      remoteRevokeButton.disabled = false;
      renderRemoteQr(session);
      broadcastRemote();
      return true;
    } catch (error) {
      state.remoteSession = null;
      state.remoteHost = null;
      setRemoteStatus('unsupported');
      remoteLive.textContent = friendlyErrorMessage(error, 'The remote session could not start.');
      toast(friendlyErrorMessage(error, 'The remote session could not start.'), {
        type: 'error',
        title: 'Remote unavailable',
      });
      return false;
    }
  }

  function openRemotePanel() {
    if (state.remoteOpen) return;
    state.remoteOpen = true;
    remotePanelEl.dataset.open = 'true';
    remoteButton.setAttribute('aria-pressed', 'true');
    showControls({ scheduleHide: false });
    startRemoteSession();
    requestAnimationFrame(() => {
      const target = isRemoteSupported() ? remoteCopyButton : remoteClose;
      target?.focus?.({ preventScroll: true });
    });
  }

  function closeRemotePanel({ restoreFocus = true, reason = 'user' } = {}) {
    if (!state.remoteOpen) return;
    state.remoteOpen = false;
    remotePanelEl.dataset.open = 'false';
    remoteButton.setAttribute('aria-pressed', 'false');
    stopRemoteSession({ reason });
    if (restoreFocus) remoteButton.focus({ preventScroll: true });
  }

  function toggleRemotePanel() {
    if (state.remoteOpen) closeRemotePanel();
    else openRemotePanel();
  }

  remoteClose.addEventListener('click', () => closeRemotePanel());
  remoteRevokeButton.addEventListener('click', () => {
    closeRemotePanel({ restoreFocus: false, reason: 'revoked' });
    remoteButton.focus({ preventScroll: true });
  });
  remoteCopyButton.addEventListener('click', async () => {
    if (!state.remoteSession) return;
    const copied = await copyText(buildRemoteUrl(state.remoteSession));
    toast(
      copied
        ? 'Controller link copied. It works in another window of this browser profile while the reader stays open.'
        : 'The link could not be copied automatically. Select it and copy it manually.',
      { type: copied ? 'success' : 'warning', title: copied ? 'Link copied' : 'Copy failed' },
    );
  });
  remoteOpenButton.addEventListener('click', () => {
    if (!state.remoteSession) return;
    const opened = window.open(buildRemoteUrl(state.remoteSession), '_blank', 'noopener,noreferrer');
    if (!opened) {
      toast('The controller window was blocked. Allow pop-ups for this site, or copy the link and open it in another tab.', {
        type: 'warning',
        title: 'Could not open controller',
      });
    }
  });
  remoteLink.addEventListener('focus', () => remoteLink.select());
  remotePanelEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeRemotePanel();
  });

  remoteApi = {
    get isOpen() {
      return state.remoteOpen;
    },
    open: openRemotePanel,
    close: closeRemotePanel,
    sync: () => setRemoteStatus(state.remoteHost?.connected ? 'connected' : state.remoteSession ? 'waiting' : 'closed'),
    renderState(remoteStateValue) {
      if (!remoteStateValue) return;
      if (state.remoteOpen) {
        remoteLive.textContent = `${Math.round((remoteStateValue.progress || 0) * 100)}% through · ${remoteStateValue.speed || '—'} wpm · ${remoteStateValue.playing ? 'playing' : remoteStateValue.status || 'paused'}`;
      }
    },
    destroy() {
      closeRemotePanel({ restoreFocus: false });
      stopRemoteSession({ reason: 'closed' });
    },
  };

  resizeObserver = new ResizeObserver(() => {
    if (!state.initialized || state.destroyed) return;
    scheduleLayoutMeasure();
  });
  resizeObserver.observe(scroll);
  resizeObserver.observe(content);

  listen(scroll, 'scroll', () => {
    if (state.destroyed || !state.initialized) return;
    if (Math.abs(scroll.scrollTop - engine.position) > 2) {
      engine.syncPosition(scroll.scrollTop);
      paintProgress(scroll.scrollTop);
      voiceApi?.syncCursorFromProgress?.();
      if (engine.playing && getReader().pauseOnManualScroll) {
        pausePlayback();
        showControls({ scheduleHide: false });
      }
      schedulePositionPersist(500);
    }
  }, { passive: true });

  listen(scroll, 'wheel', () => {
    if (engine.playing && getReader().pauseOnManualScroll) {
      pausePlayback();
      showControls({ scheduleHide: false });
    }
  }, { passive: true });

  listen(scroll, 'touchstart', () => {
    if (engine.playing && getReader().pauseOnManualScroll) {
      pausePlayback();
      showControls({ scheduleHide: false });
    }
  }, { passive: true });

  listen(screen, 'pointermove', onUserMouseMove, { passive: true });

  function progressPositionFromEvent(event) {
    const rect = progressBar.getBoundingClientRect();
    if (!rect.width) return state.progress;
    return clamp((event.clientX - rect.left) / rect.width, 0, 1);
  }

  let draggingProgress = false;
  listen(progressBar, 'pointerdown', (event) => {
    if (event.button != null && event.button !== 0) return;
    draggingProgress = true;
    progressBar.setPointerCapture?.(event.pointerId);
    seekProgress(progressPositionFromEvent(event));
    event.preventDefault();
  });
  listen(progressBar, 'pointermove', (event) => {
    if (!draggingProgress) return;
    seekProgress(progressPositionFromEvent(event));
  });
  listen(progressBar, 'pointerup', (event) => {
    if (!draggingProgress) return;
    draggingProgress = false;
    progressBar.releasePointerCapture?.(event.pointerId);
    schedulePositionPersist(0);
  });
  listen(progressBar, 'pointercancel', () => {
    draggingProgress = false;
  });

  listen(document, 'fullscreenchange', updateFullscreenButton);
  listen(document, 'webkitfullscreenchange', updateFullscreenButton);

  listen(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (state.initialized) persistPosition();
      state.remoteInterval && broadcastRemote();
    } else {
      scheduleLayoutMeasure();
    }
  });

  const beforeUnloadHandler = (event) => {
    if (!state.cameraRecording) return;
    event.preventDefault();
    event.returnValue = '';
  };
  listen(window, 'beforeunload', beforeUnloadHandler);

  requestAnimationFrame(() => requestAnimationFrame(initializeReader));
  const initializeFallbackTimer = setTimeout(initializeReader, 220);
  listeners.push({
    target: { removeEventListener: () => clearTimeout(initializeFallbackTimer) },
    type: 'timer',
    handler: () => {},
    options: undefined,
  });

  return {
    element: screen,
    pageTitle: script.title,
    guard: leaveGuard,
    cleanup,
  };
}
