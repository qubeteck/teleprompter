/**
 * Camera + microphone preview and local recording.
 *
 * No recording is uploaded anywhere. Media is held in memory as Blob chunks
 * until the user downloads it. Formats are chosen from what the browser
 * actually supports; callers must present the real MIME type to the user.
 */

export const RECORDING_QUALITIES = Object.freeze({
  '480p': { width: 854, height: 480, videoBitsPerSecond: 1_800_000, label: '480p · smaller file' },
  '720p': { width: 1280, height: 720, videoBitsPerSecond: 3_500_000, label: '720p · recommended' },
  '1080p': { width: 1920, height: 1080, videoBitsPerSecond: 6_000_000, label: '1080p · larger file' },
});

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=h264,opus',
  'video/webm',
  'video/mp4;codecs=h264,aac',
  'video/mp4',
];

export function isCameraRecordingSupported() {
  return Boolean(globalThis.navigator?.mediaDevices?.getUserMedia && typeof globalThis.MediaRecorder !== 'undefined');
}

export function getSupportedMimeTypes() {
  if (typeof globalThis.MediaRecorder === 'undefined') return [];
  return MIME_CANDIDATES.filter((mime) => {
    try {
      return globalThis.MediaRecorder.isTypeSupported?.(mime) ?? false;
    } catch {
      return false;
    }
  });
}

export function pickMimeType(preference = 'auto') {
  const supported = getSupportedMimeTypes();
  if (preference && preference !== 'auto') {
    if (supported.includes(preference)) return preference;
    const family = preference.split(';')[0];
    const match = supported.find((mime) => mime.startsWith(family));
    if (match) return match;
  }
  return supported[0] || '';
}

export function mimeExtension(mime = '') {
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogv';
  return 'webm';
}

export function describeMime(mime = '') {
  if (!mime) return 'Browser default';
  if (mime.includes('vp9')) return 'WebM · VP9';
  if (mime.includes('vp8')) return 'WebM · VP8';
  if (mime.includes('h264') && mime.includes('mp4')) return 'MP4 · H.264';
  if (mime.includes('h264')) return 'WebM · H.264';
  if (mime.includes('mp4')) return 'MP4';
  if (mime.includes('webm')) return 'WebM';
  return mime;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export class CameraRecorder {
  #stream = null;
  #videoDeviceId = '';
  #audioDeviceId = '';
  #quality = '720p';
  #includeMic = true;
  #recorder = null;
  #chunks = [];
  #recording = false;
  #paused = false;
  #startedAt = 0;
  #elapsedMs = 0;
  #durationTimer = null;
  #stopPromise = null;
  #resolveStop = null;
  #rejectStop = null;
  #lastRecording = null;
  #destroyed = false;
  #onStatus;
  #onDuration;
  #onError;
  #onRecordingReady;
  #onDevices;

  constructor({ onStatus = null, onDuration = null, onError = null, onRecordingReady = null, onDevices = null } = {}) {
    this.#onStatus = onStatus;
    this.#onDuration = onDuration;
    this.#onError = onError;
    this.#onRecordingReady = onRecordingReady;
    this.#onDevices = onDevices;
  }

  get recording() {
    return this.#recording;
  }

  get paused() {
    return this.#paused;
  }

  get stream() {
    return this.#stream;
  }

  get lastRecording() {
    return this.#lastRecording;
  }

  get previewing() {
    return Boolean(this.#stream);
  }

  get videoDeviceId() {
    return this.#videoDeviceId;
  }

  get audioDeviceId() {
    return this.#audioDeviceId;
  }

  #status(status, detail = {}) {
    try {
      this.#onStatus?.(status, detail);
    } catch (error) {
      console.error('Camera status handler failed', error);
    }
  }

  #emitDuration() {
    const extra = this.#recording && !this.#paused ? Date.now() - this.#startedAt : 0;
    const duration = this.#elapsedMs + extra;
    try {
      this.#onDuration?.(duration, formatDuration(duration));
    } catch (error) {
      console.error('Recording duration handler failed', error);
    }
  }

  async startPreview({ quality = this.#quality, includeMic = this.#includeMic, videoDeviceId = this.#videoDeviceId, audioDeviceId = this.#audioDeviceId } = {}) {
    if (this.#destroyed) throw new Error('The camera module has been closed.');
    if (this.#recording) throw new Error('Stop recording before changing camera devices.');
    const mediaDevices = globalThis.navigator?.mediaDevices;
    if (!mediaDevices?.getUserMedia) throw new Error('This browser does not support camera access.');
    if (!quality || !RECORDING_QUALITIES[quality]) quality = '720p';
    const dimensions = RECORDING_QUALITIES[quality];

    this.stopPreview({ silent: true });
    this.#quality = quality;
    this.#includeMic = Boolean(includeMic);

    const constraints = {
      video: {
        width: { ideal: dimensions.width },
        height: { ideal: dimensions.height },
        frameRate: { ideal: 30, max: 30 },
        ...(videoDeviceId ? { deviceId: { exact: videoDeviceId } } : { facingMode: 'user' }),
      },
      audio: includeMic
        ? {
            echoCancellation: { ideal: true },
            noiseSuppression: { ideal: true },
            ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {}),
          }
        : false,
    };

    this.#status('requesting');
    try {
      this.#stream = await mediaDevices.getUserMedia(constraints);
    } catch (error) {
      this.#stream = null;
      this.#status('error', { error });
      try {
        this.#onError?.(error);
      } catch (handlerError) {
        console.error('Camera error handler failed', handlerError);
      }
      throw error;
    }

    const videoTrack = this.#stream.getVideoTracks()[0];
    const audioTrack = this.#stream.getAudioTracks()[0];
    this.#videoDeviceId = videoTrack?.getSettings?.().deviceId || videoDeviceId || '';
    this.#audioDeviceId = audioTrack?.getSettings?.().deviceId || audioDeviceId || '';

    videoTrack?.addEventListener?.('ended', () => {
      // The device was unplugged or access was revoked.
      if (this.#stream) {
        this.#status('disconnected');
        this.stopPreview({ silent: true });
      }
    });
    audioTrack?.addEventListener?.('ended', () => {
      if (this.#stream && this.#includeMic) this.#status('microphone-disconnected');
    });

    this.#status('ready', {
      hasAudio: this.#stream.getAudioTracks().length > 0,
      deviceId: this.#videoDeviceId,
      quality: this.#quality,
    });
    await this.refreshDevices();
    return this.#stream;
  }

  async refreshDevices() {
    const mediaDevices = globalThis.navigator?.mediaDevices;
    if (!mediaDevices?.enumerateDevices) return { cameras: [], microphones: [] };
    try {
      const devices = await mediaDevices.enumerateDevices();
      const cameras = devices
        .filter((device) => device.kind === 'videoinput')
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Camera ${index + 1}`,
        }));
      const microphones = devices
        .filter((device) => device.kind === 'audioinput')
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Microphone ${index + 1}`,
        }));
      this.#onDevices?.({ cameras, microphones });
      return { cameras, microphones };
    } catch {
      return { cameras: [], microphones: [] };
    }
  }

  async startRecording({ mimePreference = 'auto' } = {}) {
    if (this.#destroyed) throw new Error('The camera module has been closed.');
    if (this.#recording) return false;
    if (!this.#stream) throw new Error('Start the camera preview before recording.');
    if (typeof globalThis.MediaRecorder === 'undefined') throw new Error('This browser cannot record media.');

    const mimeType = pickMimeType(mimePreference);
    const dimensions = RECORDING_QUALITIES[this.#quality] || RECORDING_QUALITIES['720p'];
    const options = { videoBitsPerSecond: dimensions.videoBitsPerSecond };
    if (mimeType) options.mimeType = mimeType;

    let recorder;
    try {
      recorder = new MediaRecorder(this.#stream, options);
    } catch (error) {
      // Some browsers require the default container even when they report a
      // codec as supported. Fall back once, and surface the real error if that
      // also fails.
      try {
        recorder = new MediaRecorder(this.#stream);
      } catch {
        this.#onError?.(error);
        throw error;
      }
    }

    this.#chunks = [];
    this.#recorder = recorder;
    this.#recording = true;
    this.#paused = false;
    this.#elapsedMs = 0;
    this.#startedAt = Date.now();
    this.#stopPromise = null;

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.#chunks.push(event.data);
    };
    recorder.onstart = () => {
      this.#status('recording', { mimeType: recorder.mimeType || mimeType });
    };
    recorder.onpause = () => {
      this.#status('paused');
    };
    recorder.onresume = () => {
      this.#status('recording');
    };
    recorder.onerror = (event) => {
      const error = event?.error || new Error('The recording failed.');
      this.#status('error', { error });
      this.#onError?.(error);
      this.#finishRecording({ error });
    };
    recorder.onstop = () => {
      this.#finishRecording({});
    };

    clearInterval(this.#durationTimer);
    this.#durationTimer = setInterval(() => this.#emitDuration(), 400);
    this.#emitDuration();

    try {
      // A timeslice keeps memory use more even and gives the browser a chance
      // to flush data before a long recording ends.
      recorder.start(1000);
      this.#status('recording', { mimeType: recorder.mimeType || mimeType });
      return true;
    } catch (error) {
      this.#recording = false;
      clearInterval(this.#durationTimer);
      this.#recorder = null;
      this.#onError?.(error);
      throw error;
    }
  }

  pause() {
    if (!this.#recorder || this.#recorder.state !== 'recording') return false;
    if (typeof this.#recorder.pause !== 'function') return false;
    this.#recorder.pause();
    this.#elapsedMs += Date.now() - this.#startedAt;
    this.#paused = true;
    this.#emitDuration();
    return true;
  }

  resume() {
    if (!this.#recorder || this.#recorder.state !== 'paused') return false;
    if (typeof this.#recorder.resume !== 'function') return false;
    this.#recorder.resume();
    this.#startedAt = Date.now();
    this.#paused = false;
    return true;
  }

  stopRecording() {
    if (!this.#recorder) return Promise.resolve(this.#lastRecording);
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopPromise = new Promise((resolve, reject) => {
      this.#resolveStop = resolve;
      this.#rejectStop = reject;
    });
    if (this.#recorder.state === 'inactive') {
      this.#finishRecording({});
    } else {
      try {
        this.#elapsedMs += this.#recording && !this.#paused ? Date.now() - this.#startedAt : 0;
        this.#recorder.stop();
      } catch (error) {
        this.#finishRecording({ error });
      }
    }
    return this.#stopPromise;
  }

  #finishRecording({ error = null } = {}) {
    if (!this.#recording && !this.#recorder) return;
    clearInterval(this.#durationTimer);
    this.#durationTimer = null;
    const recorder = this.#recorder;
    const mimeType = recorder?.mimeType || pickMimeType();
    const totalDuration = this.#elapsedMs;
    this.#recording = false;
    this.#paused = false;
    this.#recorder = null;
    this.#elapsedMs = 0;
    this.#startedAt = 0;

    if (error) {
      this.#status('error', { error });
      this.#rejectStop?.(error);
      this.#resolveStop = null;
      this.#rejectStop = null;
      this.#stopPromise = null;
      this.#chunks = [];
      return;
    }

    const blob = new Blob(this.#chunks, { type: mimeType || 'video/webm' });
    this.#chunks = [];
    if (!blob.size) {
      const emptyError = new Error('The browser produced an empty recording. Try a shorter take or a different quality setting.');
      this.#status('error', { error: emptyError });
      this.#rejectStop?.(emptyError);
      this.#onError?.(emptyError);
      this.#resolveStop = null;
      this.#rejectStop = null;
      this.#stopPromise = null;
      return;
    }
    const url = URL.createObjectURL(blob);
    const recording = {
      blob,
      url,
      mimeType,
      durationMs: totalDuration,
      durationLabel: formatDuration(totalDuration),
      extension: mimeExtension(mimeType),
      createdAt: new Date().toISOString(),
      size: blob.size,
    };
    this.#lastRecording = recording;
    this.#status('recorded', { recording });
    try {
      this.#onRecordingReady?.(recording);
      this.#resolveStop?.(recording);
    } catch (handlerError) {
      console.error('Recording ready handler failed', handlerError);
      this.#rejectStop?.(handlerError);
    } finally {
      this.#resolveStop = null;
      this.#rejectStop = null;
      this.#stopPromise = null;
    }
  }

  stopPreview({ silent = false } = {}) {
    if (this.#recording) {
      // Keep the take; the caller is leaving the screen. The stop handler will
      // produce a downloadable blob.
      this.stopRecording().catch(() => {});
    }
    for (const track of this.#stream?.getTracks?.() || []) {
      try {
        track.stop();
      } catch {
        // Track already ended.
      }
    }
    this.#stream = null;
    clearInterval(this.#durationTimer);
    this.#durationTimer = null;
    if (!silent) this.#status('closed');
  }

  /** Releases the camera, stops any active take, and revokes old object URLs. */
  destroy() {
    if (this.#destroyed) return;
    this.stopPreview({ silent: true });
    this.#destroyed = true;
    clearInterval(this.#durationTimer);
    this.#durationTimer = null;
    this.#onStatus = null;
    this.#onDuration = null;
    this.#onError = null;
    this.#onDevices = null;
    // Delay revoking so a download action shown just after cleanup still works.
    const last = this.#lastRecording;
    if (last?.url) setTimeout(() => URL.revokeObjectURL(last.url), 30_000);
  }
}
