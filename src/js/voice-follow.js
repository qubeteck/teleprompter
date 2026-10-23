import { normalizeWord, tokenizeWordsWithOffsets } from './utils.js';

/**
 * Optional voice-following.
 *
 * SpeechRecognition quality varies heavily by browser, accent, language, and
 * whether the browser uses a network service. The matcher is deliberately
 * conservative: it only advances on final recognition chunks, searches ahead
 * in the script, tolerates a few skipped words, and refuses to jump backwards.
 * Manual scrolling remains authoritative and resets the cursor.
 */

function getSpeechRecognition() {
  return globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
}

function wordSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 4 && b.length >= 4) {
    if (a.startsWith(b.slice(0, 4)) || b.startsWith(a.slice(0, 4))) return 0.62;
    if (a.length === b.length) {
      let differences = 0;
      for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) differences += 1;
        if (differences > 1) return 0;
      }
      return differences === 1 ? 0.7 : 0;
    }
  }
  return 0;
}

/**
 * Scores a spoken phrase against the script beginning at a candidate anchor.
 * Returns the final matched token index so the reader can scroll to it.
 */
export function matchSpokenPhrase(scriptTokens, spokenTokens, { cursor = 0, sensitivity = 0.55 } = {}) {
  if (!Array.isArray(scriptTokens) || !Array.isArray(spokenTokens) || !spokenTokens.length) return null;
  if (!scriptTokens.length) return null;
  const aggressive = Math.max(0, Math.min(1, Number(sensitivity) || 0.55));
  const maxSkip = aggressive > 0.72 ? 3 : 2;
  const searchStart = Math.max(0, cursor - 5);
  const searchEnd = Math.min(scriptTokens.length, cursor + (aggressive > 0.7 ? 180 : 110));
  const threshold = 0.66 - aggressive * 0.26;
  const minimumMatched = spokenTokens.length === 1 ? 1 : 2;

  let best = null;
  for (let anchor = searchStart; anchor < searchEnd; anchor += 1) {
    const similarity = wordSimilarity(scriptTokens[anchor], spokenTokens[0]);
    if (!similarity) continue;
    let scriptIndex = anchor;
    let matched = similarity;
    let lastMatched = anchor;
    const skipped = 0;

    for (let spokenIndex = 1; spokenIndex < spokenTokens.length; spokenIndex += 1) {
      const spoken = spokenTokens[spokenIndex];
      let found = -1;
      let foundWeight = 0;
      for (let skip = 0; skip <= maxSkip; skip += 1) {
        const candidateIndex = scriptIndex + 1 + skip;
        if (candidateIndex >= scriptTokens.length || candidateIndex >= searchEnd) break;
        const candidate = scriptTokens[candidateIndex];
        const weight = wordSimilarity(candidate, spoken);
        if (weight) {
          found = candidateIndex;
          foundWeight = weight;
          break;
        }
      }
      if (found >= 0) {
        matched += foundWeight;
        lastMatched = found;
        scriptIndex = found;
      } else {
        // Keep the anchor intact but let later words try a small forward step.
        scriptIndex = Math.min(scriptIndex + 1, searchEnd - 1);
      }
    }

    const score = matched / Math.max(1, spokenTokens.length);
    const distancePenalty = Math.abs(anchor - cursor) / 900;
    const adjusted = score - distancePenalty;
    if (matched >= minimumMatched && score >= threshold && (!best || adjusted > best.adjusted)) {
      best = {
        anchor,
        endIndex: lastMatched,
        score,
        adjusted,
        matched,
        skipped,
        spokenLength: spokenTokens.length,
      };
    }
  }
  return best;
}

export class VoiceFollowController {
  #recognition = null;
  #active = false;
  #destroyed = false;
  #restartTimer = null;
  #fatal = false;
  #speaking = false;
  #pendingTokens = [];
  #cursor = 0;
  #scriptTokens = [];
  #language;
  #sensitivity;
  #pauseOnSilence;
  #onStatus;
  #onTranscript;
  #onMatch;
  #onSilenceChange;
  #onError;

  static isSupported() {
    return Boolean(getSpeechRecognition());
  }

  constructor({
    language = 'en-US',
    sensitivity = 0.55,
    pauseOnSilence = true,
    scriptTokens = [],
    cursor = 0,
    onStatus = null,
    onTranscript = null,
    onMatch = null,
    onSilenceChange = null,
    onError = null,
  } = {}) {
    this.#language = language || 'en-US';
    this.#sensitivity = Math.max(0.1, Math.min(1, Number(sensitivity) || 0.55));
    this.#pauseOnSilence = pauseOnSilence !== false;
    this.#scriptTokens = scriptTokens;
    this.#cursor = Math.max(0, Number(cursor) || 0);
    this.#onStatus = onStatus;
    this.#onTranscript = onTranscript;
    this.#onMatch = onMatch;
    this.#onSilenceChange = onSilenceChange;
    this.#onError = onError;
  }

  get supported() {
    return Boolean(getSpeechRecognition());
  }

  get active() {
    return this.#active;
  }

  setScriptTokens(tokens) {
    this.#scriptTokens = Array.isArray(tokens) ? tokens : [];
  }

  setCursor(index) {
    this.#cursor = Math.max(0, Math.min(this.#scriptTokens.length - 1, Number(index) || 0));
    this.#pendingTokens = [];
  }

  setSensitivity(value) {
    this.#sensitivity = Math.max(0.1, Math.min(1, Number(value) || 0.55));
  }

  setLanguage(language) {
    const next = String(language || 'en-US').slice(0, 20);
    if (next === this.#language) return;
    this.#language = next;
    if (this.#active) {
      this.#restartNow(true);
    }
  }

  setPauseOnSilence(value) {
    this.#pauseOnSilence = Boolean(value);
  }

  #emitStatus(status, detail = {}) {
    try {
      this.#onStatus?.(status, detail);
    } catch (error) {
      console.error('Voice status handler failed', error);
    }
  }

  start() {
    if (this.#destroyed) return false;
    if (!this.supported) {
      this.#emitStatus('unsupported');
      return false;
    }
    if (this.#active) return true;
    this.#active = true;
    this.#fatal = false;
    this.#pendingTokens = [];
    this.#emitStatus('starting');
    this.#createRecognition();
    try {
      this.#recognition.start();
      return true;
    } catch (error) {
      // InvalidStateError usually means an existing recognition session is
      // still shutting down. Retry once shortly.
      if (error?.name === 'InvalidStateError') {
        this.#restartNow(true);
        return true;
      }
      this.#active = false;
      this.#onError?.(error);
      this.#emitStatus('error', { error });
      return false;
    }
  }

  #createRecognition() {
    const Constructor = getSpeechRecognition();
    if (!Constructor) return;
    const recognition = new Constructor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = this.#language;

    recognition.onstart = () => {
      if (!this.#active) return;
      this.#emitStatus('listening');
    };
    recognition.onaudiostart = () => {
      if (this.#active) this.#emitStatus('listening');
    };
    recognition.onspeechstart = () => {
      if (!this.#active) return;
      if (!this.#speaking) {
        this.#speaking = true;
        this.#emitStatus('speech');
        this.#onSilenceChange?.(false);
      }
    };
    recognition.onspeechend = () => {
      if (!this.#active) return;
      if (this.#speaking) {
        this.#speaking = false;
        this.#emitStatus('listening');
        if (this.#pauseOnSilence) this.#onSilenceChange?.(true);
      }
    };
    recognition.onresult = (event) => {
      if (!this.#active) return;
      let interim = '';
      let finalText = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript || '';
        if (result?.isFinal) finalText += ` ${transcript}`;
        else interim += ` ${transcript}`;
      }
      if (interim.trim()) {
        try {
          this.#onTranscript?.(interim.trim(), false);
        } catch (error) {
          console.error('Voice transcript handler failed', error);
        }
      }
      if (!finalText.trim()) return;
      this.#handleFinalText(finalText.trim());
    };
    recognition.onerror = (event) => {
      const code = event?.error || 'unknown';
      if (code === 'no-speech' || code === 'aborted') return;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        this.#fatal = true;
        this.#active = false;
        this.#emitStatus('denied', { code });
        this.#cleanupRecognition();
        return;
      }
      if (code === 'audio-capture') {
        this.#fatal = true;
        this.#active = false;
        this.#emitStatus('no-microphone', { code });
        this.#cleanupRecognition();
        return;
      }
      this.#emitStatus(code === 'network' ? 'network' : 'error', { code });
    };
    recognition.onend = () => {
      if (!this.#active || this.#destroyed || this.#fatal) return;
      this.#emitStatus('restarting');
      clearTimeout(this.#restartTimer);
      this.#restartTimer = setTimeout(() => this.#restartNow(false), 320);
    };

    this.#recognition = recognition;
  }

  #handleFinalText(text) {
    const tokens = tokenizeWordsWithOffsets(text)
      .map((token) => normalizeWord(token.word))
      .filter(Boolean);
    if (!tokens.length) return;
    this.#pendingTokens.push(...tokens);
    if (this.#pendingTokens.length > 28) this.#pendingTokens = this.#pendingTokens.slice(-16);

    const match = matchSpokenPhrase(this.#scriptTokens, this.#pendingTokens, {
      cursor: this.#cursor,
      sensitivity: this.#sensitivity,
    });
    if (!match) return;

    const nextCursor = Math.max(this.#cursor, match.endIndex + 1);
    this.#cursor = Math.min(nextCursor, this.#scriptTokens.length);
    this.#pendingTokens = [];
    try {
      this.#onTranscript?.(text, true);
    } catch (error) {
      console.error('Voice transcript handler failed', error);
    }
    try {
      this.#onMatch?.(match.endIndex, match);
    } catch (error) {
      console.error('Voice match handler failed', error);
    }
  }

  #restartNow(immediate = false) {
    if (!this.#active || this.#destroyed) return;
    clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    this.#cleanupRecognition();
    this.#createRecognition();
    const delay = immediate ? 0 : 120;
    this.#restartTimer = setTimeout(() => {
      if (!this.#active || this.#destroyed) return;
      try {
        this.#recognition?.start();
      } catch (error) {
        if (error?.name === 'InvalidStateError') {
          this.#restartTimer = setTimeout(() => this.#restartNow(false), 600);
          return;
        }
        this.#emitStatus('error', { error });
      }
    }, delay);
  }

  #cleanupRecognition() {
    if (!this.#recognition) return;
    try {
      this.#recognition.onstart = null;
      this.#recognition.onaudiostart = null;
      this.#recognition.onspeechstart = null;
      this.#recognition.onspeechend = null;
      this.#recognition.onresult = null;
      this.#recognition.onerror = null;
      this.#recognition.onend = null;
      this.#recognition.abort();
    } catch {
      // Some engines throw when aborting after a permission denial.
    }
    this.#recognition = null;
  }

  stop({ reason = 'user' } = {}) {
    if (!this.#active && !this.#recognition) return;
    this.#active = false;
    this.#speaking = false;
    clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    this.#cleanupRecognition();
    this.#pendingTokens = [];
    this.#emitStatus(reason === 'destroy' ? 'closed' : 'stopped');
  }

  destroy() {
    if (this.#destroyed) return;
    this.stop({ reason: 'destroy' });
    this.#destroyed = true;
    this.#onStatus = null;
    this.#onTranscript = null;
    this.#onMatch = null;
    this.#onSilenceChange = null;
    this.#onError = null;
  }
}
