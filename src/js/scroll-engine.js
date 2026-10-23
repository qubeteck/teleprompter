import { clamp } from './utils.js';

/**
 * Converts reading speed (words per minute) and document geometry into
 * pixels per second. Speed therefore stays consistent when font size or the
 * viewport changes, and does not depend on display refresh rate.
 */
export function computePlaybackMetrics({ maxScroll, wordCount, wpm = 140, direction = 'forward' }) {
  const bounds = Math.max(0, Number(maxScroll) || 0);
  const words = Math.max(0, Number(wordCount) || 0);
  const speed = clamp(wpm, 20, 600);
  const totalSeconds = words > 0 ? (words / speed) * 60 : Math.max(1, bounds / 100);
  const pixelsPerSecond = bounds > 0 ? bounds / totalSeconds : 0;
  return {
    maxScroll: bounds,
    wordCount: words,
    wpm: speed,
    totalSeconds,
    pixelsPerSecond,
    signedPixelsPerSecond: direction === 'reverse' ? -pixelsPerSecond : pixelsPerSecond,
  };
}

export function positionToProgress(position, maxScroll, direction = 'forward') {
  if (!maxScroll || maxScroll <= 0) return direction === 'reverse' ? 1 : 0;
  const raw = clamp(position / maxScroll, 0, 1);
  return direction === 'reverse' ? 1 - raw : raw;
}

export function progressToPosition(progress, maxScroll, direction = 'forward') {
  if (!maxScroll || maxScroll <= 0) return 0;
  const clamped = clamp(progress, 0, 1);
  const raw = direction === 'reverse' ? 1 - clamped : clamped;
  return raw * maxScroll;
}

/**
 * requestAnimationFrame-based scroll engine. Injecting the scheduler makes
 * the engine unit-testable, and the single-loop guard prevents duplicate
 * animation loops when play is pressed repeatedly.
 */
export class ScrollEngine {
  #playing = false;
  #rafId = null;
  #lastTimestamp = null;
  #position = 0;
  #destroyed = false;
  #maxDeltaMs;

  constructor({
    getMaxScroll,
    getPixelsPerSecond,
    getPosition = () => this.#position,
    setPosition,
    onTick = null,
    onStateChange = null,
    onReachEnd = null,
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (id) => cancelAnimationFrame(id),
    maxDeltaMs = 100,
  } = {}) {
    if (typeof getMaxScroll !== 'function') throw new TypeError('getMaxScroll is required');
    if (typeof getPixelsPerSecond !== 'function') throw new TypeError('getPixelsPerSecond is required');
    if (typeof setPosition !== 'function') throw new TypeError('setPosition is required');
    this.getMaxScroll = getMaxScroll;
    this.getPixelsPerSecond = getPixelsPerSecond;
    this.getPosition = getPosition;
    this.setPosition = setPosition;
    this.onTick = onTick;
    this.onStateChange = onStateChange;
    this.onReachEnd = onReachEnd;
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.#maxDeltaMs = maxDeltaMs;
    this.#position = Math.max(0, Number(this.getPosition()) || 0);
  }

  get playing() {
    return this.#playing;
  }

  get position() {
    return this.#position;
  }

  get progress() {
    const max = this.getMaxScroll();
    return max > 0 ? clamp(this.#position / max, 0, 1) : 0;
  }

  syncPosition(value = this.getPosition()) {
    this.#position = clamp(Number(value) || 0, 0, this.getMaxScroll());
    return this.#position;
  }

  seekTo(value) {
    const max = this.getMaxScroll();
    this.#position = clamp(Number(value) || 0, 0, Math.max(0, max));
    this.setPosition(this.#position);
    this.onTick?.(this.#snapshot());
    return this.#position;
  }

  seekProgress(progress) {
    return this.seekTo(clamp(progress, 0, 1) * this.getMaxScroll());
  }

  startOrResumeFromEdge() {
    const max = this.getMaxScroll();
    const pps = this.getPixelsPerSecond();
    if (max <= 0) return false;
    if (pps < 0 && this.#position <= 0.5) {
      this.seekTo(max);
    } else if (pps > 0 && this.#position >= max - 0.5) {
      this.seekTo(0);
    }
    return true;
  }

  play() {
    if (this.#destroyed) return false;
    if (this.#playing) return true;
    if (!this.startOrResumeFromEdge()) return false;
    this.#playing = true;
    this.#lastTimestamp = null;
    this.onStateChange?.('playing');
    this.#schedule();
    return true;
  }

  pause() {
    if (!this.#playing) return false;
    this.#playing = false;
    this.#lastTimestamp = null;
    if (this.#rafId != null) {
      this.cancelFrame(this.#rafId);
      this.#rafId = null;
    }
    this.onStateChange?.('paused');
    return true;
  }

  toggle() {
    return this.#playing ? (this.pause(), false) : this.play();
  }

  reset({ toEnd = false } = {}) {
    const wasPlaying = this.#playing;
    if (wasPlaying) this.pause();
    const max = this.getMaxScroll();
    this.seekTo(toEnd ? max : 0);
    this.onStateChange?.('reset');
    return this.#position;
  }

  #snapshot() {
    const max = this.getMaxScroll();
    return {
      position: this.#position,
      maxScroll: max,
      progress: max > 0 ? clamp(this.#position / max, 0, 1) : 0,
      playing: this.#playing,
    };
  }

  #schedule() {
    if (!this.#playing || this.#destroyed) return;
    this.#rafId = this.requestFrame((timestamp) => this.#frame(timestamp));
  }

  #frame(timestamp) {
    if (!this.#playing || this.#destroyed) return;
    this.#rafId = null;
    const max = Math.max(0, this.getMaxScroll());

    if (max <= 0) {
      this.pause();
      this.onReachEnd?.(this.#snapshot());
      return;
    }

    let delta = 0;
    if (this.#lastTimestamp != null) {
      delta = Math.min(Math.max(0, timestamp - this.#lastTimestamp), this.#maxDeltaMs);
    }
    this.#lastTimestamp = timestamp;

    const pixelsPerSecond = Number(this.getPixelsPerSecond()) || 0;
    let next = this.#position + (pixelsPerSecond * delta) / 1000;

    if (next <= 0) {
      next = 0;
    }
    if (next >= max) {
      next = max;
    }

    this.#position = clamp(next, 0, max);
    this.setPosition(this.#position);
    this.onTick?.(this.#snapshot());

    const atEnd = pixelsPerSecond < 0 ? this.#position <= 0.25 : this.#position >= max - 0.25;
    if (atEnd) {
      this.#playing = false;
      this.#lastTimestamp = null;
      this.onStateChange?.('finished');
      this.onReachEnd?.(this.#snapshot());
      return;
    }

    this.#schedule();
  }

  destroy() {
    this.#destroyed = true;
    if (this.#playing) this.pause();
    this.#rafId = null;
    this.#lastTimestamp = null;
  }
}
