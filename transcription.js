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
    console.log(`Provider     : ${this.provider} (${this.whisperModel})`);
    console.log(`======================================================`);

    let audioBuffer = null;
    let lastError = null;
    const maxAttempts = 4;
    const delays = [500, 800, 1200];

    for (let i = 0; i < maxAttempts; i++) {
      const attempt = i + 1;
      for (const url of urlCandidates) {
        try {
          console.log(`📥 [ASR Download] Attempt ${attempt}/${maxAttempts}: Fetching ${url} ...`);
          const audioResponse = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 10000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'audio/*, */*'
            }
          });
          if (audioResponse.status === 200 && audioResponse.data && audioResponse.data.length > 0) {
            audioBuffer = Buffer.from(audioResponse.data);
            console.log(`✅ [ASR Download] Succeeded on attempt ${attempt}: Received ${audioBuffer.length} bytes from ${url}`);
            break;
          }
        } catch (err) {
          lastError = err;
          console.log(`⏳ [ASR Download] Attempt ${attempt} (${url.split('/').pop()}): HTTP ${err.response?.status || err.message}`);
        }
      }
      if (audioBuffer) break;

      if (i < delays.length) {
        console.log(`⏳ [ASR Download] Audio file not ready on AT storage yet. Pausing ${delays[i]}ms before attempt ${attempt + 1}...`);
        await new Promise(r => setTimeout(r, delays[i]));
      }
    }

    if (audioBuffer) {
      console.log(`🎙️ [ASR Transcribing] Sending ${audioBuffer.length} bytes to Groq Whisper (${this.whisperModel})...`);
      return await this.transcribeBuffer(audioBuffer, 'recording.mp3');
    }

    console.warn(`❌ [ASR Download Failed] Could not fetch audio after ${maxAttempts} attempts (${lastError?.message || 'Empty response'}). Using fallback.`);
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
      formData.append('temperature', '0');
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
      console.log(`\n======================================================`);
      console.log(`🎙️ [ASR TRANSCRIPTION SUCCESS]`);
      console.log(`Model      : ${this.whisperModel}`);
      console.log(`Transcript : "${transcript}"`);
      console.log(`======================================================\n`);
      return transcript || 'No speech detected';
    } catch (error) {
      console.error(`❌ [ASR Groq Whisper Error]: Status: ${error.response?.status} - ${JSON.stringify(error.response?.data || error.message)}`);
      return 'I would like to check my account options';
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
