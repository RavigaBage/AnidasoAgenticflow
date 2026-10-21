/**
 * Phone Audio & DTMF Synthesizer Engine
 * Dual-tone Multi-Frequency (DTMF) generation using Web Audio API + SpeechSynthesis for AT <Say> actions.
 */

class PhoneAudioEngine {
  constructor() {
    this.audioCtx = null;
    this.isMuted = false;
    this.speechEnabled = true;

    // Standard DTMF Frequency matrix (Row Hz, Col Hz)
    this.dtmfFrequencies = {
      '1': [697, 1209],
      '2': [697, 1336],
      '3': [697, 1477],
      '4': [770, 1209],
      '5': [770, 1336],
      '6': [770, 1477],
      '7': [852, 1209],
      '8': [852, 1336],
      '9': [852, 1477],
      '*': [941, 1209],
      '0': [941, 1336],
      '#': [941, 1477]
    };
  }

  initContext() {
    if (!this.audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioContext();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  /**
   * Play standard dual-frequency DTMF tone
   */
  playDtmf(digit, durationMs = 180) {
    if (this.isMuted) return;
    this.initContext();

    const freqs = this.dtmfFrequencies[digit];
    if (!freqs) return;

    try {
      const now = this.audioCtx.currentTime;
      const osc1 = this.audioCtx.createOscillator();
      const osc2 = this.audioCtx.createOscillator();
      const gainNode = this.audioCtx.createGain();

      osc1.type = 'sine';
      osc2.type = 'sine';
      osc1.frequency.setValueAtTime(freqs[0], now);
      osc2.frequency.setValueAtTime(freqs[1], now);

      // Smooth attack and release envelope to prevent click artifacts
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.18, now + 0.015);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + (durationMs / 1000));

      osc1.connect(gainNode);
      osc2.connect(gainNode);
      gainNode.connect(this.audioCtx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + (durationMs / 1000));
      osc2.stop(now + (durationMs / 1000));
    } catch (err) {
      console.warn('Audio tone error:', err);
    }
  }

  /**
   * Speak Africa's Talking <Say> text content using browser TTS
   */
  speakText(text) {
    if (!this.speechEnabled || this.isMuted || !('speechSynthesis' in window)) return;
    if (!text || text.trim() === '') return;

    window.speechSynthesis.cancel(); // Cancel any ongoing speech
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.98;
    utterance.pitch = 1.0;

    // Pick a natural English voice if available
    const voices = window.speechSynthesis.getVoices();
    const naturalVoice = voices.find(v => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Google') || v.name.includes('Samantha')));
    if (naturalVoice) utterance.voice = naturalVoice;

    window.speechSynthesis.speak(utterance);
  }

  /**
   * Play audio file from URL (for <Play url="..."/>)
   */
  playAudioUrl(url) {
    if (this.isMuted || !url) return;
    try {
      const audio = new Audio(url);
      audio.volume = 0.6;
      audio.play().catch(e => console.warn('Could not play audio url:', e));
    } catch (e) {
      console.warn('Play url error:', e);
    }
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.isMuted) {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    }
    return this.isMuted;
  }

  toggleSpeech() {
    this.speechEnabled = !this.speechEnabled;
    if (!this.speechEnabled && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    return this.speechEnabled;
  }
}

window.phoneAudio = new PhoneAudioEngine();
