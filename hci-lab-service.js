/**
 * University of Ghana HCI Lab Speech Technology Service
 * Implements ASR & TTS for Akan Twi with the 7-Pillar Quota Defense Blueprint.
 * 
 * Free-Tier Limits:
 * - ASR: 10 requests / day, 50 requests / week (Circuit breaker trips at 8 / day)
 * - TTS: 15 requests / day, 70 requests / week (Circuit breaker trips at 12 / day)
 * - TTS Max Length: 250 characters / request
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class HciLabService {
  constructor() {
    this.quotaFilePath = path.join(__dirname, 'hci-lab-quota.json');
    this.cacheDir = path.join(__dirname, 'public', 'audio', 'cache');
    this.reloadConfig();
    this.initCache();
    this.loadQuota();
  }

  reloadConfig() {
    this.apiKey = process.env.UG_HCI_LAB_API_KEY || '';
    this.baseUrl = (process.env.UG_HCI_LAB_URL || 'https://lab-subscription-platform.vercel.app').replace(/\/$/, '');
    this.publicBaseUrl = (process.env.PUBLIC_CALLBACK_URL
      ? process.env.PUBLIC_CALLBACK_URL.replace(/\/voice\/callback.*$/, '')
      : 'http://localhost:3000').replace(/\/$/, '');

    // Safety Thresholds (Stops before hitting provider hard limits)
    this.SAFETY_LIMITS = {
      MAX_DAILY_ASR: 8,    // Hard limit: 10
      MAX_WEEKLY_ASR: 45,  // Hard limit: 50
      MAX_DAILY_TTS: 12,   // Hard limit: 15
      MAX_WEEKLY_TTS: 60,  // Hard limit: 70
      MAX_TTS_CHARS: 250,  // Hard limit: 250
      MAX_CONCURRENCY: 2   // Maximum 2 concurrent requests across endpoints
    };

    this.activeRequests = 0;
  }

  /**
   * Pillar 6: Strict Test & CI Isolation
   * Automated unit/integration tests must NEVER consume live UG HCI Lab quota.
   */
  isTestEnvironment() {
    return process.env.NODE_ENV === 'test' || Boolean(process.env.CI) || Boolean(process.env.VITEST);
  }

  initCache() {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
    } catch (err) {
      console.warn('[HCI Lab] Error initializing audio cache directory:', err.message);
    }
  }

  loadQuota() {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const dayOfWeek = now.getUTCDay(); // 0 is Sunday, 1 is Monday

    // Calculate start of current week (Monday 00:00 UTC)
    const mondayOffset = (dayOfWeek + 6) % 7;
    const weekStart = new Date(now);
    weekStart.setUTCDate(now.getUTCDate() - mondayOffset);
    const currentWeekKey = weekStart.toISOString().slice(0, 10);

    let quota = {
      currentDay: today,
      currentWeek: currentWeekKey,
      dailyAsr: 0,
      dailyTts: 0,
      weeklyAsr: 0,
      weeklyTts: 0,
      totalCharsTts: 0,
      lastUpdated: now.toISOString()
    };

    if (fs.existsSync(this.quotaFilePath)) {
      try {
        const raw = fs.readFileSync(this.quotaFilePath, 'utf8');
        const saved = JSON.parse(raw);

        // Daily reset check (00:00 UTC)
        if (saved.currentDay === today) {
          quota.dailyAsr = saved.dailyAsr || 0;
          quota.dailyTts = saved.dailyTts || 0;
        } else {
          console.log(`[HCI Lab Quota] 🔄 Daily quota reset at 00:00 UTC (New day: ${today})`);
        }

        // Weekly reset check (Monday 00:00 UTC)
        if (saved.currentWeek === currentWeekKey) {
          quota.weeklyAsr = saved.weeklyAsr || 0;
          quota.weeklyTts = saved.weeklyTts || 0;
          quota.totalCharsTts = saved.totalCharsTts || 0;
        } else {
          console.log(`[HCI Lab Quota] 🔄 Weekly quota reset at Monday 00:00 UTC (New week: ${currentWeekKey})`);
        }
      } catch (err) {
        console.warn('[HCI Lab Quota] Error reading quota file, using fresh counters:', err.message);
      }
    }

    this.quota = quota;
    this.saveQuota();
  }

  saveQuota() {
    try {
      this.quota.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.quotaFilePath, JSON.stringify(this.quota, null, 2));
    } catch (err) {
      console.warn('[HCI Lab Quota] Could not save quota state:', err.message);
    }
  }

  getQuotaStatus() {
    this.loadQuota();
    return {
      dailyAsr: {
        used: this.quota.dailyAsr,
        safetyLimit: this.SAFETY_LIMITS.MAX_DAILY_ASR,
        hardLimit: 10,
        remaining: Math.max(0, this.SAFETY_LIMITS.MAX_DAILY_ASR - this.quota.dailyAsr),
        isLocked: this.quota.dailyAsr >= this.SAFETY_LIMITS.MAX_DAILY_ASR
      },
      dailyTts: {
        used: this.quota.dailyTts,
        safetyLimit: this.SAFETY_LIMITS.MAX_DAILY_TTS,
        hardLimit: 15,
        remaining: Math.max(0, this.SAFETY_LIMITS.MAX_DAILY_TTS - this.quota.dailyTts),
        isLocked: this.quota.dailyTts >= this.SAFETY_LIMITS.MAX_DAILY_TTS
      },
      weeklyAsr: {
        used: this.quota.weeklyAsr,
        safetyLimit: this.SAFETY_LIMITS.MAX_WEEKLY_ASR,
        hardLimit: 50
      },
      weeklyTts: {
        used: this.quota.weeklyTts,
        safetyLimit: this.SAFETY_LIMITS.MAX_WEEKLY_TTS,
        hardLimit: 70
      },
      isConfigured: Boolean(this.apiKey)
    };
  }

  isAsrAllowed() {
    if (!this.apiKey) return false;
    this.loadQuota();
    return (
      this.quota.dailyAsr < this.SAFETY_LIMITS.MAX_DAILY_ASR &&
      this.quota.weeklyAsr < this.SAFETY_LIMITS.MAX_WEEKLY_ASR
    );
  }

  isTtsAllowed() {
    if (!this.apiKey) return false;
    this.loadQuota();
    return (
      this.quota.dailyTts < this.SAFETY_LIMITS.MAX_DAILY_TTS &&
      this.quota.weeklyTts < this.SAFETY_LIMITS.MAX_WEEKLY_TTS
    );
  }

  /**
   * Speech-to-Text (ASR) via UG HCI Lab
   * POST /api/v1/asr
   */
  async transcribeAudio(audioBuffer, filename = 'recording.mp3') {
    // Pillar 6: Strict Test & CI Isolation
    if (this.isTestEnvironment()) {
      console.log('[HCI Lab ASR] 🛡️ [Pillar 6 Isolation] Test environment detected. Returning deterministic fixture (0 live quota burned).');
      return {
        success: true,
        circuitBreaker: false,
        transcript: 'Mepɛ sɛ memane sika aduonum kɔma Kwame Mensah',
        language: 'tw',
        mocked: true
      };
    }

    if (!this.apiKey) {
      console.warn('[HCI Lab ASR] No UG_HCI_LAB_API_KEY found.');
      return { success: false, circuitBreaker: false, transcript: '' };
    }

    if (!this.isAsrAllowed()) {
      console.warn(`[HCI Lab ASR] 🛑 Circuit Breaker engaged! Daily quota reached (${this.quota.dailyAsr}/${this.SAFETY_LIMITS.MAX_DAILY_ASR}). Falling back to Whisper with Akan vocabulary.`);
      return { success: false, circuitBreaker: true, transcript: '' };
    }

    if (this.activeRequests >= this.SAFETY_LIMITS.MAX_CONCURRENCY) {
      console.warn(`[HCI Lab ASR] ⏳ Concurrency limit reached (${this.activeRequests}/${this.SAFETY_LIMITS.MAX_CONCURRENCY}). Falling back to Whisper.`);
      return { success: false, circuitBreaker: false, transcript: '' };
    }

    this.activeRequests++;
    try {
      const endpoint = `${this.baseUrl}/api/v1/asr`;
      const blob = new Blob([audioBuffer], { type: 'audio/mpeg' });
      const formData = new FormData();
      formData.append('file', blob, filename);
      formData.append('language', 'twi');

      console.log(`🎙️ [HCI Lab ASR] Sending ${audioBuffer.length} bytes to ${endpoint} (Call ${this.quota.dailyAsr + 1}/${this.SAFETY_LIMITS.MAX_DAILY_ASR} today)...`);
      const response = await axios.post(endpoint, formData, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: 10000
      });

      this.quota.dailyAsr++;
      this.quota.weeklyAsr++;
      this.saveQuota();

      const transcript = (response.data?.transcript || response.data?.transcription || '').trim();
      console.log(`✅ [HCI Lab ASR Success] Recognized: "${transcript}" (Daily used: ${this.quota.dailyAsr}/${this.SAFETY_LIMITS.MAX_DAILY_ASR})`);
      return {
        success: true,
        circuitBreaker: false,
        transcript,
        language: response.data?.language || 'tw'
      };
    } catch (error) {
      const errData = error.response?.data;
      let errCode = '';
      let errMsg = error.message;

      if (errData) {
        try {
          const parsed = typeof errData === 'object' ? errData : JSON.parse(Buffer.isBuffer(errData) ? errData.toString('utf8') : errData);
          errCode = parsed.error?.code || parsed.code || '';
          errMsg = parsed.error?.message || parsed.message || JSON.stringify(parsed);
        } catch (e) {
          errMsg = String(errData);
        }
      }

      console.error(`❌ [HCI Lab ASR Error]: Status ${error.response?.status} - [${errCode}] ${errMsg}`);

      // Upstream quota handling (Pillar 7)
      if (errCode === 'daily_quota_exceeded') {
        console.warn('🛑 [HCI Lab] Upstream daily ASR quota exceeded. Engaging safety lock.');
        this.quota.dailyAsr = this.SAFETY_LIMITS.MAX_DAILY_ASR;
        this.saveQuota();
      } else if (errCode === 'weekly_quota_exceeded') {
        console.warn('🛑 [HCI Lab] Upstream weekly ASR quota exceeded. Engaging safety lock.');
        this.quota.weeklyAsr = this.SAFETY_LIMITS.MAX_WEEKLY_ASR;
        this.saveQuota();
      }

      return { success: false, circuitBreaker: false, transcript: '' };
    } finally {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    }
  }

  /**
   * Text-to-Speech (TTS) via UG HCI Lab with Permanent Disk Caching (Pillar 2)
   * POST /api/v1/tts
   */
  async synthesizeSpeech(text, customBaseUrl = null) {
    if (!text || !text.trim()) return null;

    const cleanText = text.trim();
    const hash = crypto.createHash('md5').update(cleanText).digest('hex');
    const cachedFilename = `twi_${hash}.wav`;
    const cachedFilePath = path.join(this.cacheDir, cachedFilename);
    const baseUrl = (customBaseUrl || this.publicBaseUrl).replace(/\/$/, '');
    const publicAudioUrl = `${baseUrl}/audio/cache/${cachedFilename}`;

    // Pillar 2: Check Local Disk Cache First (Consumes 0 Quota)
    if (fs.existsSync(cachedFilePath)) {
      console.log(`⚡ [HCI Lab TTS Cache Hit] Serving from local disk: ${cachedFilename} (0 API quota used!)`);
      return {
        audioUrl: publicAudioUrl,
        filePath: cachedFilePath,
        cached: true,
        quotaUsed: false
      };
    }

    // Pillar 6: Strict Test & CI Isolation
    if (this.isTestEnvironment()) {
      console.log('[HCI Lab TTS] 🛡️ [Pillar 6 Isolation] Test environment detected. Returning mock audio URL (0 live quota burned).');
      return {
        audioUrl: `${baseUrl}/audio/mock_twi.wav`,
        filePath: cachedFilePath,
        cached: true,
        quotaUsed: false
      };
    }

    // Check circuit breaker
    if (!this.isTtsAllowed()) {
      console.warn(`[HCI Lab TTS] 🛑 Circuit Breaker engaged! Daily quota reached (${this.quota.dailyTts}/${this.SAFETY_LIMITS.MAX_DAILY_TTS}). Falling back to telecom <Say>.`);
      return null;
    }

    if (this.activeRequests >= this.SAFETY_LIMITS.MAX_CONCURRENCY) {
      console.warn(`[HCI Lab TTS] ⏳ Concurrency limit reached (${this.activeRequests}/${this.SAFETY_LIMITS.MAX_CONCURRENCY}). Falling back to telecom <Say>.`);
      return null;
    }

    // Enforce 250 characters limit strictly
    let synthesisText = cleanText;
    if (synthesisText.length > this.SAFETY_LIMITS.MAX_TTS_CHARS) {
      console.warn(`[HCI Lab TTS] Text exceeds 250 chars (${synthesisText.length}). Truncating to 250 characters.`);
      synthesisText = synthesisText.slice(0, 247) + '...';
    }

    this.activeRequests++;
    try {
      const endpoint = `${this.baseUrl}/api/v1/tts`;
      console.log(`🎙️ [HCI Lab TTS] Synthesizing: "${synthesisText}" (Call ${this.quota.dailyTts + 1}/${this.SAFETY_LIMITS.MAX_DAILY_TTS} today)...`);

      const response = await axios.post(
        endpoint,
        {
          text: synthesisText,
          model_type: 'ss',
          speaker: 'PT'
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          responseType: 'arraybuffer',
          timeout: 12000
        }
      );

      // Verify binary WAV response
      if (response.status === 200 && response.data && response.data.length > 0) {
        fs.writeFileSync(cachedFilePath, Buffer.from(response.data));

        this.quota.dailyTts++;
        this.quota.weeklyTts++;
        this.quota.totalCharsTts += synthesisText.length;
        this.saveQuota();

        console.log(`✅ [HCI Lab TTS Success] Cached to ${cachedFilename} (${response.data.length} bytes, duration: ${response.headers['x-duration-sec'] || '?'}s)`);
        return {
          audioUrl: publicAudioUrl,
          filePath: cachedFilePath,
          cached: false,
          quotaUsed: true
        };
      }
      return null;
    } catch (error) {
      const errData = error.response?.data;
      let errCode = '';
      let errMsg = error.message;

      if (errData) {
        try {
          const parsed = typeof errData === 'object' ? errData : JSON.parse(Buffer.isBuffer(errData) ? errData.toString('utf8') : errData);
          errCode = parsed.error?.code || parsed.code || '';
          errMsg = parsed.error?.message || parsed.message || JSON.stringify(parsed);
        } catch (e) {
          errMsg = String(errData);
        }
      }

      console.error(`❌ [HCI Lab TTS Error]: Status ${error.response?.status} - [${errCode}] ${errMsg}`);

      // Upstream quota handling (Pillar 7)
      if (errCode === 'daily_quota_exceeded') {
        console.warn('🛑 [HCI Lab] Upstream daily TTS quota exceeded. Engaging safety lock.');
        this.quota.dailyTts = this.SAFETY_LIMITS.MAX_DAILY_TTS;
        this.saveQuota();
      } else if (errCode === 'weekly_quota_exceeded') {
        console.warn('🛑 [HCI Lab] Upstream weekly TTS quota exceeded. Engaging safety lock.');
        this.quota.weeklyTts = this.SAFETY_LIMITS.MAX_WEEKLY_TTS;
        this.saveQuota();
      }
      return null;
    } finally {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    }
  }
}

module.exports = new HciLabService();
