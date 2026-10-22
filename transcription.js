/**
 * Pluggable Speech-to-Text (ASR) Service
 * Transcribes call audio from Africa's Talking recording URLs.
 * 
 * Default Provider: Groq Whisper (whisper-large-v3-turbo via GROQ_API_KEY)
 * Easily swap or plug in any ASR service (Deepgram, Google STT, AssemblyAI, Whisper).
 */

require('dotenv').config();
const axios = require('axios');
const hciLabService = require('./hci-lab-service');

class TranscriptionService {
  constructor() {
    this.reloadConfig();
  }

  reloadConfig() {
    this.provider = process.env.ASR_PROVIDER || 'groq'; // 'groq' | 'ug_hci' | 'custom' | 'mock'
    // Prioritize dedicated audio/speech key (GROQ_TTS_KEY or GROQ_STT_KEY), fallback to GROQ_API_KEY
    this.groqApiKey = process.env.GROQ_TTS_KEY || process.env.GROQ_STT_KEY || process.env.GROQ_API_KEY || '';
    this.keySource = process.env.GROQ_TTS_KEY ? 'GROQ_TTS_KEY (dedicated speech/audio)' : (process.env.GROQ_STT_KEY ? 'GROQ_STT_KEY (dedicated speech/audio)' : 'GROQ_API_KEY (shared)');
    this.whisperModel = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo';

    // University of Ghana HCI Lab Speech API for Ghanaian languages (Twi / Akan)
    this.ugHciLabApiKey = process.env.UG_HCI_LAB_API_KEY || '';
    this.ugHciLabUrl = process.env.UG_HCI_LAB_URL || 'https://lab-subscription-platform.vercel.app';
  }

  getConfigSummary() {
    this.reloadConfig();
    return {
      provider: this.provider,
      whisperModel: this.whisperModel,
      keySource: this.keySource,
      isConfigured: Boolean(this.groqApiKey),
      ugHciLabConfigured: Boolean(this.ugHciLabApiKey),
      hciLabQuota: hciLabService.getQuotaStatus()
    };
  }

  /**
   * Main entry point to transcribe an audio recording from Africa's Talking
   * 
   * @param {string} recordingUrl Public URL to the recorded audio (.mp3 / .wav)
   * @returns {Promise<string>} Transcribed text
   */
  /**
   * Main entry point to transcribe an audio recording from Africa's Talking.
   * Supports an options object to return timing metrics alongside the transcript.
   * 
   * @param {string} recordingUrl Public URL to the recorded audio (.mp3 / .wav)
   * @param {object} [options] { includeMetrics: boolean }
   * @returns {Promise<string|{transcript: string, metrics: object}>}
   */
  async transcribeAudioFromUrl(recordingUrl, options = {}) {
    this.reloadConfig();
    const startTime = Date.now();

    const activeProvider = options.provider || (options.language === 'twi' ? 'ug_hci' : this.provider);
    const isTwi = options.language === 'twi' || activeProvider === 'ug_hci' || activeProvider === 'ug_hci_lab';

    const metrics = {
      downloadStartMs: startTime,
      downloadDurationMs: 0,
      audioBytes: 0,
      sttDurationMs: 0,
      totalDurationMs: 0,
      attempts: 0,
      provider: activeProvider,
      model: isTwi ? 'UG HCI Lab Akan/Twi ASR' : this.whisperModel,
      keySource: isTwi ? 'UG_HCI_LAB_API_KEY (University of Ghana HCI Lab)' : this.keySource
    };

    if (!recordingUrl) {
      metrics.totalDurationMs = Date.now() - startTime;
      return options.includeMetrics ? { transcript: '', metrics } : '';
    }

    // Africa's Talking appends a trailing 'T' to the filename (e.g. hashT.mp3) during interim turn callbacks,
    // while the actual audio file stored on AT's media storage is hash.mp3.
    const cleanUrl = recordingUrl.replace(/T\.mp3(\?.*)?$/i, '.mp3$1');
    const urlCandidates = [];
    if (cleanUrl !== recordingUrl) {
      urlCandidates.push(cleanUrl);
    }
    urlCandidates.push(recordingUrl);

    console.log(`\n======================================================`);
    console.log(`🎙️ [ASR SERVICE] Processing Audio Recording`);
    console.log(`Original URL : ${recordingUrl}`);
    console.log(`Candidate URL: ${cleanUrl}`);
    console.log(`Provider     : ${activeProvider} (${isTwi ? 'UG HCI Lab Twi' : this.whisperModel})`);
    console.log(`======================================================`);

    let audioBuffer = null;
    let lastError = null;
    const maxAttempts = 3;
    const delays = [250, 500]; // Lean backoff delays: audio is usually ready in < 500ms

    const downloadStart = Date.now();
    for (let i = 0; i < maxAttempts; i++) {
      const attempt = i + 1;
      metrics.attempts = attempt;
      for (const url of urlCandidates) {
        try {
          console.log(`📥 [ASR Download] Attempt ${attempt}/${maxAttempts}: Fetching ${url} ...`);
          const audioResponse = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 4000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'audio/*, */*'
            }
          });
          if (audioResponse.status === 200 && audioResponse.data && audioResponse.data.length > 0) {
            audioBuffer = Buffer.from(audioResponse.data);
            metrics.audioBytes = audioBuffer.length;
            metrics.downloadDurationMs = Date.now() - downloadStart;
            console.log(`✅ [ASR Download] Succeeded on attempt ${attempt}: Received ${audioBuffer.length} bytes in ${metrics.downloadDurationMs}ms`);
            break;
          }
        } catch (err) {
          lastError = err;
          console.log(`⏳ [ASR Download] Attempt ${attempt} (${url.split('/').pop()}): HTTP ${err.response?.status || err.message}`);
        }
      }
      if (audioBuffer) break;

      if (i < delays.length) {
        console.log(`⏳ [ASR Download] Pausing ${delays[i]}ms before attempt ${attempt + 1}...`);
        await new Promise(r => setTimeout(r, delays[i]));
      }
    }

    if (!audioBuffer) {
      metrics.downloadDurationMs = Date.now() - downloadStart;
      metrics.totalDurationMs = Date.now() - startTime;
      console.warn(`❌ [ASR Download Failed] Could not fetch audio after ${maxAttempts} attempts (${lastError?.message || 'Empty response'}).`);
      const fallback = '';
      return options.includeMetrics ? { transcript: fallback, isSilence: true, metrics } : fallback;
    }

    // Silence Gate: Audio smaller than 5.5KB is < 2.5 seconds of silence/noise.
    if (audioBuffer.length < 5500) {
      metrics.downloadDurationMs = Date.now() - downloadStart;
      metrics.totalDurationMs = Date.now() - startTime;
      console.log(`[ASR Service] 🔇 Audio is very short/silence (${audioBuffer.length} bytes < 5.5KB). Skipping STT to save tokens.`);
      return options.includeMetrics ? { transcript: '', isSilence: true, metrics } : '';
    }

    // 2. Transcribe buffer
    const sttStart = Date.now();
    console.log(`🎙️ [ASR Transcribing] Sending ${audioBuffer.length} bytes to ${isTwi ? 'UG HCI Lab (Twi ASR)' : `Groq Whisper (${this.whisperModel})`}...`);
    const rawTranscript = await this.transcribeBuffer(audioBuffer, 'recording.mp3', activeProvider);
    metrics.sttDurationMs = Date.now() - sttStart;
    metrics.totalDurationMs = Date.now() - startTime;

    const cleanText = (rawTranscript || '').trim();
    const normalized = cleanText.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const KNOWN_SILENCE_HALLUCINATIONS = new Set([
      'thank you',
      'thank you very much',
      'you',
      'bye',
      'subtitles by',
      'thanks for watching',
      'so',
      ''
    ]);

    let finalTranscript = cleanText;
    let isSilence = false;
    if (KNOWN_SILENCE_HALLUCINATIONS.has(normalized) || cleanText === '.') {
      console.log(`[ASR Service] 🔇 Filtered known Whisper silence hallucination: "${cleanText}" -> treating as silence`);
      finalTranscript = '';
      isSilence = true;
    }

    if (options.includeMetrics) {
      return { transcript: finalTranscript, isSilence, metrics };
    }
    return finalTranscript;
  }

  /**
   * Transcribe raw audio buffer
   */
  async transcribeBuffer(audioBuffer, filename = 'audio.mp3', provider = this.provider) {
    switch (provider) {
      case 'ug_hci':
      case 'ug_hci_lab':
        return await this.transcribeWithUgHciLab(audioBuffer, filename);
      case 'groq':
        return await this.transcribeWithGroqWhisper(audioBuffer, filename);
      case 'custom':
        return await this.transcribeWithCustomProvider(audioBuffer);
      default:
        return await this.transcribeWithGroqWhisper(audioBuffer, filename);
    }
  }

  /**
   * Transcribe audio using University of Ghana HCI Lab Speech API
   * Specialized for Ghanaian languages (Akan / Twi).
   * Backed by Quota Defense Circuit Breaker and Whisper fallback.
   * POST https://lab-subscription-platform.vercel.app/api/v1/asr
   */
  async transcribeWithUgHciLab(audioBuffer, filename = 'recording.mp3') {
    const result = await hciLabService.transcribeAudio(audioBuffer, filename);
    if (result && result.success && result.transcript) {
      return result.transcript;
    }

    if (result && result.circuitBreaker) {
      console.warn('[ASR Service] 🛡️ HCI Lab Quota Circuit Breaker active. Falling back to Groq Whisper with Akan vocabulary.');
    } else {
      console.warn('[ASR Service] ⚠️ HCI Lab ASR returned empty or failed. Falling back to Groq Whisper.');
    }

    // Graceful fallback to Whisper so caller is never hung up on
    return await this.transcribeWithGroqWhisper(audioBuffer, filename);
  }

  /**
   * Transcribe using Groq Cloud Whisper API with 429 rate limit awareness
   * POST https://api.groq.com/openai/v1/audio/transcriptions
   */
  async transcribeWithGroqWhisper(audioBuffer, filename) {
    if (!this.groqApiKey) {
      console.warn('[ASR Service] No GROQ_API_KEY available for Groq Whisper transcription.');
      return '';
    }

    const maxRetries = 1;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const formData = new FormData();
        const audioBlob = new Blob([audioBuffer], { type: 'audio/mpeg' });
        formData.append('file', audioBlob, filename);
        formData.append('model', this.whisperModel);
        formData.append('language', 'en');
        // Pin vocabulary prompt so Whisper recognizes Ghanaian MoMo terms instead of mishearing
        formData.append('prompt', 'MTN Mobile Money Ghana MoMo, cedis, Telecel, AirtelTigo, send money, cash out, balance enquiry, numbers');
        formData.append('temperature', '0');
        formData.append('response_format', 'json');

        const response = await axios.post(
          'https://api.groq.com/openai/v1/audio/transcriptions',
          formData,
          {
            headers: {
              'Authorization': `Bearer ${this.groqApiKey}`,
              'Content-Type': 'multipart/form-data'
            },
            timeout: 8000
          }
        );

        const transcript = response.data?.text?.trim();
        console.log(`\n======================================================`);
        console.log(`🎙️ [ASR TRANSCRIPTION SUCCESS]`);
        console.log(`Model      : ${this.whisperModel}`);
        console.log(`Transcript : "${transcript}"`);
        console.log(`======================================================\n`);
        return transcript || '';
      } catch (error) {
        if (error.response?.status === 429 && attempt < maxRetries) {
          const retryHeader = error.response.headers?.['retry-after'];
          const waitSeconds = retryHeader ? Math.min(parseFloat(retryHeader) || 1.5, 2.5) : 1.5;
          console.warn(`[ASR Groq Whisper] ⏳ 429 rate limit. Waiting ${waitSeconds}s before single retry...`);
          await new Promise(r => setTimeout(r, waitSeconds * 1000));
          continue;
        }
        console.error(`❌ [ASR Groq Whisper Error]: Status: ${error.response?.status} - ${JSON.stringify(error.response?.data || error.message)}`);
        return '';
      }
    }
  }

  /**
   * PLUG-IN HOOK: Insert your chosen STT service here when decided!
   * (e.g. Deepgram, Google Cloud Speech, AssemblyAI, AWS Transcribe)
   */
  async transcribeWithCustomProvider(audioBuffer) {
    // Fail loudly instead of returning a silent placeholder that would corrupt the AI dialog.
    throw new Error(
      'Custom ASR provider is not implemented. Set ASR_PROVIDER=groq with a valid GROQ_API_KEY, ' +
      'or implement transcribeWithCustomProvider() in transcription.js with your chosen STT service.'
    );
  }
}

module.exports = new TranscriptionService();
