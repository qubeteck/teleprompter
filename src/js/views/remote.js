import {
  isRemoteSupported,
  parseRemoteLink,
  RemoteController,
} from '../remote-control.js';
import { button, emptyState, h, iconSpan, toast } from '../ui.js';
import { formatDuration } from '../utils.js';

function statusLabel(status) {
  return {
    connecting: 'Looking for the teleprompter…',
    connected: 'Connected',
    disconnected: 'Disconnected',
    closed: 'Session closed',
    unsupported: 'Not supported',
  }[status] || 'Waiting for connection';
}

function controllerCard(ctx, session) {
  const card = h('div', { class: 'remote-controller__card' });
  const eyebrow = h('div', { class: 'hero__eyebrow', style: { marginBottom: '10px' } });
  eyebrow.append(iconSpan('smartphone', { size: 12 }), h('span', { text: 'Paired controller' }));
  card.append(eyebrow);
  card.append(h('h1', { style: { margin: '0', fontSize: '24px', letterSpacing: '-0.04em' }, text: 'Remote control' }));

  const scriptTitle = h('p', { class: 'muted', style: { margin: '5px 0 0', fontSize: '12px', minHeight: '18px' }, text: 'Waiting for a teleprompter to respond…' });
  card.append(scriptTitle);

  const status = h('div', { class: 'remote-controller__status', role: 'status', 'aria-live': 'polite' });
  const statusDot = h('span', { class: 'reader-status-dot' });
  const statusText = h('span', { text: statusLabel('connecting') });
  status.append(statusDot, statusText);
  card.append(status);

  const progressWrap = h('div', { class: 'remote-progress', 'aria-hidden': 'true' });
  const progressFill = h('div', { class: 'remote-progress__fill' });
  progressWrap.append(progressFill);
  card.append(progressWrap);

  const readout = h('div', { class: 'remote-readout' });
  const positionText = h('span', { text: '0%' });
  const speedText = h('span', { text: '— wpm' });
  const remainingText = h('span', { text: '— left' });
  readout.append(positionText, speedText, remainingText);
  card.append(readout);

  const pad = h('div', { class: 'remote-controller__pad' });
  const commandButtons = [];
  const addCommand = (label, command, { icon = null, variant = '', title = '' } = {}) => {
    const control = button(label, {
      iconName: icon,
      variant,
      title: title || label,
      onClick: () => {
        controller?.sendCommand(command);
      },
    });
    control.disabled = true;
    commandButtons.push(control);
    pad.append(control);
    return control;
  };

  addCommand('− Speed', 'speedDown', { icon: 'chevronDown', title: 'Decrease speed' });
  const playButton = addCommand('Play', 'playPause', { icon: 'play', variant: 'primary', title: 'Play or pause' });
  addCommand('+ Speed', 'speedUp', { icon: 'chevronUp', title: 'Increase speed' });
  addCommand('Back 10s', 'jumpBack', { icon: 'arrowLeft', title: 'Jump back ten seconds' });
  addCommand('Restart', 'restart', { icon: 'restart', title: 'Return to the beginning' });
  addCommand('Forward 10s', 'jumpForward', { icon: 'arrowRight', title: 'Jump forward ten seconds' });
  addCommand('Start', 'jumpStart', { icon: 'chevronUp', title: 'Jump to the beginning of the script' });
  addCommand('Stop', 'stop', { icon: 'stop', title: 'Stop and reset' });
  addCommand('End', 'jumpEnd', { icon: 'chevronDown', title: 'Jump to the end of the script' });
  card.append(pad);

  const note = h('p', { class: 'field-hint', style: { marginTop: '14px', lineHeight: '1.6' } });
  note.textContent =
    'This controller talks directly to the reader through this browser profile. Nothing is sent to a server. The session ends when the reader closes.';
  card.append(note);

  const footer = h('div', { class: 'btn-row', style: { marginTop: '14px' } });
  footer.append(
    button('Open library', { iconName: 'library', onClick: () => ctx.navigate('/library') }),
    button('Open dashboard', { iconName: 'dashboard', onClick: () => ctx.navigate('/') }),
  );
  card.append(footer);

  let controller = null;
  let destroyed = false;

  const setConnected = (connected, label = null) => {
    status.dataset.connected = String(connected);
    statusText.textContent = label || (connected ? 'Connected' : 'Waiting for the teleprompter…');
    for (const control of commandButtons) control.disabled = !connected;
  };

  const connect = () => {
    try {
      controller = new RemoteController({
        sessionId: session.sessionId,
        token: session.token,
        onStatus: (state) => {
          if (destroyed) return;
          if (state === 'connected') setConnected(true, 'Connected');
          else if (state === 'disconnected' || state === 'closed') setConnected(false, state === 'closed' ? 'Session closed' : 'Teleprompter disconnected');
          else setConnected(false, statusLabel(state));
        },
        onState: (state) => {
          if (destroyed) return;
          setConnected(true);
          scriptTitle.textContent = state.title ? `Controlling “${state.title}”` : 'Connected to the teleprompter';
          const progress = Math.max(0, Math.min(1, Number(state.progress) || 0));
          progressFill.style.transform = `scaleX(${progress.toFixed(4)})`;
          positionText.textContent = `${Math.round(progress * 100)}%`;
          speedText.textContent = state.speed ? `${state.speed} wpm` : '— wpm';
          remainingText.textContent = Number.isFinite(state.remainingSeconds) ? `${formatDuration(state.remainingSeconds)} left` : '— left';
          const playing = Boolean(state.playing);
          playButton.innerHTML = '';
          playButton.append(iconSpan(playing ? 'pause' : 'play', { size: 16 }), h('span', { text: playing ? 'Pause' : 'Play' }));
          playButton.dataset.playing = String(playing);
          if (state.status === 'countdown') {
            statusText.textContent = 'Starting…';
            status.dataset.connected = 'true';
          }
        },
      });
      controller.connect();
    } catch (error) {
      setConnected(false, error.message || 'Could not connect');
      toast(error.message || 'The controller could not connect.', { type: 'error', title: 'Remote connection failed' });
    }
  };

  connect();

  return {
    element: card,
    cleanup: () => {
      destroyed = true;
      controller?.destroy();
      controller = null;
    },
  };
}

function pairingHelp(ctx) {
  const card = h('div', { class: 'remote-controller__card' });
  const eyebrow = h('div', { class: 'hero__eyebrow', style: { marginBottom: '10px' } });
  eyebrow.append(iconSpan('qr', { size: 12 }), h('span', { text: 'Pairing required' }));
  card.append(eyebrow);
  card.append(h('h1', { style: { margin: '0', fontSize: '24px', letterSpacing: '-0.04em' }, text: 'Remote control' }));
  card.append(
    h('p', {
      class: 'muted',
      style: { margin: '7px 0 0', fontSize: '12px', lineHeight: '1.65' },
      text: 'Open the teleprompter, choose Remote in its top bar, then scan the QR code or open the pairing link. This transport uses BroadcastChannel, so it works between windows or tabs of the same browser profile on this device.',
    }),
  );

  if (!isRemoteSupported()) {
    card.append(
      h('div', {
        class: 'backup-banner',
        style: { marginTop: '16px' },
        text: 'This browser does not support BroadcastChannel, so the built-in same-device remote cannot connect. Keyboard and Bluetooth keyboard controls still work in the reader.',
      }),
    );
    const actions = h('div', { class: 'btn-row', style: { marginTop: '16px' } });
    actions.append(button('Open library', { iconName: 'library', variant: 'primary', onClick: () => ctx.navigate('/library') }));
    card.append(actions);
    return { element: card, cleanup: () => {} };
  }

  const form = h('form', { class: 'field', style: { marginTop: '16px' } });
  form.append(h('label', { class: 'label', for: 'remote-link', text: 'Paste a controller link' }));
  const input = h('input', {
    class: 'input',
    id: 'remote-link',
    type: 'url',
    placeholder: 'https://…/#/remote?session=…&token=…',
    autocomplete: 'off',
  });
  form.append(input);
  form.append(h('div', { class: 'field-hint', text: 'The link contains a short-lived pairing token. Treat it like a key while the reader is open.' }));
  const error = h('div', { class: 'field-error', hidden: true });
  form.append(error);

  const submit = button('Connect controller', {
    iconName: 'link',
    variant: 'primary',
    type: 'submit',
  });
  const row = h('div', { class: 'settings-actions', style: { marginTop: '10px' } }, submit);
  form.append(row);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const parsed = parseRemoteLink(input.value.trim());
    if (!parsed) {
      error.textContent = 'That is not a valid studio controller link. Open Remote in the reader and copy the full link.';
      error.hidden = false;
      input.focus();
      return;
    }
    error.hidden = true;
    const query = new URLSearchParams({ session: parsed.sessionId, token: parsed.token, code: parsed.code || '' });
    ctx.navigate(`/remote?${query.toString()}`);
  });
  card.append(form);

  const note = h('div', { class: 'backup-banner', style: { marginTop: '16px' } });
  note.append(iconSpan('info', { size: 16 }));
  note.append(
    h('div', {
      text: 'A phone camera scan cannot connect to this local BroadcastChannel. Cross-device control needs a separate network transport or server, which this local-first build does not include. The QR code is useful for opening the controller in another window of the same browser profile.',
    }),
  );
  card.append(note);

  const actions = h('div', { class: 'btn-row', style: { marginTop: '16px' } });
  actions.append(
    button('Browse scripts', { iconName: 'library', onClick: () => ctx.navigate('/library') }),
    button('Open dashboard', { iconName: 'dashboard', onClick: () => ctx.navigate('/') }),
  );
  card.append(actions);

  return { element: card, cleanup: () => {} };
}

export async function remoteView(ctx, routeContext) {
  const session = {
    sessionId: routeContext.query.session || '',
    token: routeContext.query.token || '',
    code: routeContext.query.code || '',
  };
  if (!session.sessionId || !session.token) {
    const help = pairingHelp(ctx);
    return { element: h('div', { class: 'remote-controller' }, help.element), pageTitle: 'Remote control', cleanup: help.cleanup };
  }

  if (!isRemoteSupported()) {
    const element = emptyState({
      iconName: 'warning',
      title: 'Remote control is not supported here',
      description: 'This browser does not provide BroadcastChannel. Keyboard and Bluetooth keyboard controls still work in the teleprompter.',
      actions: [
        { label: 'Open library', icon: 'library', primary: true, onClick: () => ctx.navigate('/library') },
        { label: 'Back to dashboard', icon: 'dashboard', onClick: () => ctx.navigate('/') },
      ],
    });
    return { element, pageTitle: 'Remote control' };
  }

  const controller = controllerCard(ctx, session);
  return {
    element: h('div', { class: 'remote-controller' }, controller.element),
    pageTitle: 'Remote control',
    cleanup: controller.cleanup,
  };
}
