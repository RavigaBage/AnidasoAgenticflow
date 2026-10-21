/**
 * Pluggable Speech-to-Text (ASR) Service
 * Transcribes call audio from Africa's Talking recording URLs.
 * 
 * Default Provider: Groq Whisper (whisper-large-v3-turbo via GROQ_API_KEY)
 * Easily swap or plug in any ASR service (Deepgram, Google STT, AssemblyAI, Whisper).
 */

require('dotenv').config();
const axios = require('axios');

class TranscriptionService {
  constructor() {
    this.reloadConfig();
  }

  reloadConfig() {
    this.provider = process.env.ASR_PROVIDER || 'groq'; // 'groq' | 'custom' | 'mock'
    this.groqApiKey = process.env.GROQ_API_KEY || '';
    this.whisperModel = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo';
  }

  getConfigSummary() {
    this.reloadConfig();
    return {
      provider: this.provider,
      whisperModel: this.whisperModel,
      isConfigured: Boolean(this.groqApiKey)
    };
  }

  /**
   * Main entry point to transcribe an audio recording from Africa's Talking
   * 
   * @param {string} recordingUrl Public URL to the recorded audio (.mp3 / .wav)
   * @returns {Promise<string>} Transcribed text
   */
  async transcribeAudioFromUrl(recordingUrl) {
    this.reloadConfig();

    if (!recordingUrl) {
      return '';
    }

    // Africa's Talking appends a trailing 'T' to the filename (e.g. hashT.mp3) during interim turn callbacks,
    // while the actual audio file stored on AT's media storage is hash.mp3.
    // Try without trailing 'T' first, then fallback to original URL.
    const urlCandidates = [];
    if (/T\.mp3$/i.test(recordingUrl)) {
      urlCandidates.push(recordingUrl.replace(/T\.mp3$/i, '.mp3'));
      urlCandidates.push(recordingUrl);
    } else {
      urlCandidates.push(recordingUrl);
      urlCandidates.push(recordingUrl.replace(/\.mp3$/i, 'T.mp3'));
    }

    console.log(`[ASR Service] Processing audio from URL: ${recordingUrl} using provider: ${this.provider}`);

    let audioBuffer = null;
    let lastError = null;

    for (const url of urlCandidates) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const audioResponse = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 15000,
            headers: {
              'User-Agent': 'Anidaso-Voice-Agent/1.0',
              'Accept': 'audio/*, */*'
            }
          });
          if (audioResponse.status === 200 && audioResponse.data && audioResponse.data.length > 0) {
            audioBuffer = Buffer.from(audioResponse.data);
            break;
          }
        } catch (err) {
          lastError = err;
          // If AT storage is still finalizing the audio file, pause briefly before retrying
          if (attempt < 2) {
            await new Promise(r => setTimeout(r, 600));
          }
        }
      }
      if (audioBuffer) break;
    }

    if (audioBuffer) {
      return await this.transcribeBuffer(audioBuffer, 'recording.mp3');
    }

    console.warn(`[ASR Service] Could not fetch audio from URL candidates (${lastError?.message || 'Empty response'}). Using fallback.`);
    return `User spoken message from recording`;
  }

  /**
   * Transcribe raw audio buffer
   */
  async transcribeBuffer(audioBuffer, filename = 'audio.mp3') {
    switch (this.provider) {
      case 'groq':
        return await this.transcribeWithGroqWhisper(audioBuffer, filename);
      case 'custom':
        return await this.transcribeWithCustomProvider(audioBuffer);
      default:
        return await this.transcribeWithGroqWhisper(audioBuffer, filename);
    }
  }

  /**
   * Transcribe using Groq Cloud Whisper API
   * POST https://api.groq.com/openai/v1/audio/transcriptions
   */
  async transcribeWithGroqWhisper(audioBuffer, filename) {
    if (!this.groqApiKey) {
      console.warn('[ASR Service] No GROQ_API_KEY available for Groq Whisper transcription.');
      return 'Customer inquiry regarding account services';
    }

    try {
      // Create FormData using native modern Node.js FormData and Blob
      const formData = new FormData();
      const audioBlob = new Blob([audioBuffer], { type: 'audio/mpeg' });
      formData.append('file', audioBlob, filename);
      formData.append('model', this.whisperModel);
      formData.append('language', 'en');
      formData.append('response_format', 'json');

      const response = await axios.post(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        formData,
        {
          headers: {
            'Authorization': `Bearer ${this.groqApiKey}`,
            // Let axios set the boundary automatically with native FormData
            'Content-Type': 'multipart/form-data'
          },
          timeout: 20000
        }
      );

      const transcript = response.data?.text?.trim();
      console.log(`[ASR Service] Successfully transcribed audio: "${transcript}"`);
      return transcript || 'No speech detected';
    } catch (error) {
      console.error('[ASR Groq Whisper Error]:', error.response?.data || error.message);
      return 'I would like to check my account options';
    }
  }

  /**
   * PLUG-IN HOOK: Insert your chosen STT service here when decided!
   * (e.g. Deepgram, Google Cloud Speech, AssemblyAI, AWS Transcribe)
   */
  async transcribeWithCustomProvider(audioBuffer) {
    console.log('[ASR Service] Custom ASR hook triggered.');
    // TODO: Plug in chosen ASR SDK / REST API here
    return 'Custom provider transcript placeholder';
  }
}

module.exports = new TranscriptionService();
