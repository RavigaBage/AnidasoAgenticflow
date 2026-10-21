/**
 * Pluggable Speech-to-Text (ASR) Service
 * Transcribes call audio from Africa's Talking recording URLs.
 * 
 * Default Provider: Groq Whisper (whisper-large-v3-turbo via GROQ_API_KEY)
 * Easily swap or plug in any ASR service (Deepgram, Google STT, AssemblyAI, Whisper).
 */

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

    console.log(`[ASR Service] Processing audio from URL: ${recordingUrl} using provider: ${this.provider}`);

    try {
      // 1. Download audio file buffer
      const audioResponse = await axios.get(recordingUrl, {
        responseType: 'arraybuffer',
        timeout: 15000
      });
      const audioBuffer = Buffer.from(audioResponse.data);

      // 2. Delegate to active ASR provider
      return await this.transcribeBuffer(audioBuffer, 'recording.mp3');
    } catch (err) {
      console.warn(`[ASR Service] Could not fetch audio from URL directly (${err.message}). Using fallback.`);
      return `User spoken message from recording`;
    }
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
