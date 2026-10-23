/**
 * Same-origin remote control for the reader.
 *
 * Transport: BroadcastChannel. This is deliberately honest about its scope:
 * it can control a reader in another tab or window of the *same browser
 * profile* on the same device. It cannot create a network connection to a
 * phone on its own. A QR code can carry the pairing URL, but a phone camera
 * scan will only work when a real network transport exists. No third-party
 * service is involved.
 *
 * Pairing is explicit: a random session id names the channel, and a random
 * token must match on every message. Closing the reader revokes the session.
 */

export const REMOTE_PROTOCOL_VERSION = 1;
export const REMOTE_COMMANDS = Object.freeze([
  'playPause',
  'play',
  'pause',
  'restart',
  'stop',
  'speedUp',
  'speedDown',
  'jumpBack',
  'jumpForward',
  'jumpStart',
  'jumpEnd',
]);

const CHANNEL_PREFIX = 'atp-remote';

function randomHex(bytes = 18) {
  const data = new Uint8Array(bytes);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(data);
  else for (let index = 0; index < bytes; index += 1) data[index] = Math.floor(Math.random() * 256);
  return [...data].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function channelName(sessionId) {
  return `${CHANNEL_PREFIX}:${sessionId}`;
}

export function isRemoteSupported() {
  return typeof BroadcastChannel !== 'undefined';
}

/** Creates a short-lived pairing session. The token stays in the URL hash. */
export function createRemoteSession() {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  return {
    sessionId: `session-${randomHex(9)}`,
    token: randomHex(18),
    code,
    createdAt: Date.now(),
  };
}

export class RemoteHost {
  #channel = null;
  #session;
  #onCommand;
  #onStatus;
  #getState;
  #connected = false;
  #destroyed = false;

  constructor({ session, onCommand, onStatus = null, getState = null }) {
    if (!isRemoteSupported()) throw new Error('Remote control is not supported in this browser.');
    if (!session?.sessionId || !session?.token) throw new Error('A remote session is required.');
    this.#session = session;
    this.#onCommand = onCommand;
    this.#onStatus = onStatus;
    this.#getState = typeof getState === 'function' ? getState : null;
  }

  get session() {
    return this.#session;
  }

  get connected() {
    return this.#connected;
  }

  start() {
    if (this.#channel || this.#destroyed) return;
    this.#channel = new BroadcastChannel(channelName(this.#session.sessionId));
    this.#channel.addEventListener('message', (event) => this.#handleMessage(event.data));
    this.#setStatus('waiting');
  }

  #handleMessage(message) {
    if (this.#destroyed || !message || message.version !== REMOTE_PROTOCOL_VERSION) return;
    if (message.token !== this.#session.token) return;
    if (message.type === 'hello' || message.type === 'ping') {
      if (!this.#connected) {
        this.#connected = true;
        this.#setStatus('connected');
      }
      // Always answer with the current reader state so a newly opened
      // controller renders immediately instead of waiting for the next tick.
      const state = this.#getState?.();
      if (state) this.broadcastState(state);
      return;
    }
    if (message.type === 'bye') {
      this.#connected = false;
      this.#setStatus('waiting');
      return;
    }
    if (message.type === 'command' && typeof message.command === 'string') {
      if (!REMOTE_COMMANDS.includes(message.command)) return;
      if (!this.#connected) {
        this.#connected = true;
        this.#setStatus('connected');
      }
      this.#onCommand?.(message.command, message.payload || {}, message);
    }
  }

  #setStatus(status) {
    try {
      this.#onStatus?.(status, { connected: this.#connected });
    } catch (error) {
      console.error('Remote status handler failed', error);
    }
  }

  broadcastState(state) {
    if (!this.#channel || this.#destroyed || !state) return;
    try {
      this.#channel.postMessage({
        version: REMOTE_PROTOCOL_VERSION,
        type: 'state',
        token: this.#session.token,
        state,
        sentAt: Date.now(),
      });
    } catch {
      // A closing page can make postMessage throw; the controller will time out.
    }
  }

  stop() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    try {
      this.#channel?.postMessage({ version: REMOTE_PROTOCOL_VERSION, type: 'bye', token: this.#session.token });
    } catch {
      // Best effort.
    }
    this.#channel?.close();
    this.#channel = null;
    this.#connected = false;
    this.#setStatus('closed');
  }
}

export class RemoteController {
  #channel = null;
  #sessionId;
  #token;
  #onState;
  #onStatus;
  #connected = false;
  #lastStateAt = 0;
  #pingTimer = null;
  #staleTimer = null;
  #destroyed = false;

  constructor({ sessionId, token, onState = null, onStatus = null }) {
    if (!isRemoteSupported()) throw new Error('Remote control is not supported in this browser.');
    if (!sessionId || !token) throw new Error('This controller link is missing its pairing token.');
    this.#sessionId = sessionId;
    this.#token = token;
    this.#onState = onState;
    this.#onStatus = onStatus;
  }

  connect() {
    if (this.#channel || this.#destroyed) return;
    this.#channel = new BroadcastChannel(channelName(this.#sessionId));
    this.#channel.addEventListener('message', (event) => this.#handleMessage(event.data));
    this.#setStatus('connecting');
    this.#send({ type: 'hello', requestState: true });
    this.#pingTimer = setInterval(() => {
      if (this.#destroyed) return;
      this.#send({ type: 'ping' });
      if (this.#connected && Date.now() - this.#lastStateAt > 6500) {
        this.#connected = false;
        this.#setStatus('disconnected');
      }
    }, 2500);
  }

  #handleMessage(message) {
    if (this.#destroyed || !message || message.version !== REMOTE_PROTOCOL_VERSION) return;
    if (message.token !== this.#token) return;
    if (message.type === 'bye') {
      this.#connected = false;
      this.#setStatus('disconnected');
      return;
    }
    if (message.type === 'state' && message.state) {
      this.#lastStateAt = Date.now();
      if (!this.#connected) {
        this.#connected = true;
        this.#setStatus('connected');
      }
      try {
        this.#onState?.(message.state, message.sentAt);
      } catch (error) {
        console.error('Remote state handler failed', error);
      }
    }
  }

  #setStatus(status) {
    try {
      this.#onStatus?.(status, { connected: this.#connected });
    } catch (error) {
      console.error('Remote status handler failed', error);
    }
  }

  sendCommand(command, payload = {}) {
    if (!REMOTE_COMMANDS.includes(command)) return false;
    this.#send({ type: 'command', command, payload });
    return true;
  }

  #send(message) {
    if (!this.#channel || this.#destroyed) return;
    try {
      this.#channel.postMessage({ version: REMOTE_PROTOCOL_VERSION, token: this.#token, ...message });
    } catch {
      // The page may be closing.
    }
  }

  disconnect() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    clearInterval(this.#pingTimer);
    clearTimeout(this.#staleTimer);
    this.#pingTimer = null;
    this.#staleTimer = null;
    this.#send({ type: 'bye' });
    this.#channel?.close();
    this.#channel = null;
    this.#connected = false;
    this.#setStatus('disconnected');
  }

  destroy() {
    this.disconnect();
  }
}

/** Builds a controller URL from the current app location (hash routing). */
export function buildRemoteUrl(session) {
  const base = `${globalThis.location?.origin || ''}${globalThis.location?.pathname || '/'}`;
  const query = new URLSearchParams({
    session: session.sessionId,
    token: session.token,
    code: session.code,
  });
  return `${base}#/remote?${query.toString()}`;
}

/** Extracts pairing parameters from a controller URL or hash. */
export function parseRemoteLink(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value), globalThis.location?.href || 'https://local.invalid/');
    const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
    const [path, query = ''] = hash.split('?');
    if (!path.includes('/remote')) return null;
    const params = new URLSearchParams(query);
    const sessionId = params.get('session');
    const token = params.get('token');
    if (!sessionId || !token) return null;
    return { sessionId, token, code: params.get('code') || '' };
  } catch {
    return null;
  }
}
