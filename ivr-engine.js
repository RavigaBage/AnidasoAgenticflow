/**
 * Africa's Talking IVR & Call Session Engine
 * Handles session lifecycle, DTMF state machines, Pluggable ASR Transcription, and Groq AI Agent reasoning.
 */

const aiAgent = require('./ai-agent');
const transcriptionService = require('./transcription');
const hciLabService = require('./hci-lab-service');

/**
 * Escape XML-special characters so caller/AI-controlled text can be safely
 * interpolated into Africa's Talking XML responses (& < > " ').
 */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

class IvrEngine {
  constructor() {
    this.sessions = new Map(); // sessionId -> sessionData
    this.history = []; // Completed and past sessions
    this.mode = 'ai_agent'; // 'ai_agent' | 'interactive' | 'custom' | 'manual'
    this.customXml = `<Response>
  <Say voice="en-US-Standard-C">Hello from Africa's Talking Phone Simulator. This is a custom XML voice response.</Say>
</Response>`;
    this.pendingCallbacks = new Map(); // sessionId -> { resolve, timer } for manual operator mode
    this.audioMenuUrl = process.env.AUDIO_MENU_URL || ''; // Optional URL to pre-recorded menu audio
    this.totalSessionsCreated = 0;

    // Periodically purge ended/abandoned sessions so this.sessions cannot grow without bound
    this.sessionSweepTimer = setInterval(() => this.cleanupStaleSessions(), 10 * 60 * 1000);
    if (typeof this.sessionSweepTimer.unref === 'function') this.sessionSweepTimer.unref();
  }

  /**
   * Remove ended sessions from the active map (they remain in history) and
   * expire long-abandoned active sessions (e.g. missed isActive=0 callbacks).
   */
  cleanupStaleSessions(maxIdleMs = 2 * 60 * 60 * 1000) {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      const idleMs = now - new Date(session.updatedAt).getTime();
      if (!session.isActive || idleMs > maxIdleMs) {
        if (!this.history.some(h => h.sessionId === sessionId)) {
          this.history.unshift(session);
          if (this.history.length > 50) this.history.pop();
        }
        if (session.isActive) {
          session.isActive = false;
          session.status = 'COMPLETED';
          session.endTime = new Date().toISOString();
          aiAgent.clearSession(sessionId);
        }
        this.sessions.delete(sessionId);
      }
    }
  }

  /**
   * Register or update an active call session
   */
  getOrCreateSession(payload) {
    const {
      sessionId,
      isActive,
      direction,
      callerNumber,
      destinationNumber,
      dtmfDigits,
      recordingUrl,
      durationInSeconds,
      currencyCode,
      amount
    } = payload;

    let session = this.sessions.get(sessionId);

    if (!session) {
      session = {
        sessionId,
        direction: direction || 'Inbound',
        callerNumber: callerNumber || 'Unknown',
        destinationNumber: destinationNumber || 'Unknown',
        startTime: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isActive: isActive === '1' || isActive === 1 || isActive === true,
        events: [],
        dtmfHistory: [],
        conversation: [], // Holds [{ userTranscript, aiResponse, timestamp }]
        step: 0,
        status: isActive === '1' ? 'ACTIVE' : 'COMPLETED',
        recordings: [],
        durationInSeconds: 0,
        cost: null
      };
      this.sessions.set(sessionId, session);
      this.totalSessionsCreated++;
    }

    session.updatedAt = new Date().toISOString();
    session.isActive = isActive === '1' || isActive === 1 || isActive === true;

    if (dtmfDigits) {
      session.dtmfHistory.push(dtmfDigits);
    }
    if (recordingUrl && !session.recordings.includes(recordingUrl)) {
      session.recordings.push(recordingUrl);
    }
    if (durationInSeconds) {
      session.durationInSeconds = durationInSeconds;
    }
    if (amount && currencyCode) {
      session.cost = `${currencyCode} ${amount}`;
    }

    if (!session.isActive) {
      session.status = 'COMPLETED';
      session.endTime = new Date().toISOString();
      aiAgent.clearSession(sessionId);

      if (!this.history.some(h => h.sessionId === sessionId)) {
        this.history.unshift(session);
        if (this.history.length > 50) this.history.pop();
      }
      // Free memory: completed sessions live on in history, not the active map
      this.sessions.delete(sessionId);
    }

    session.events.push({
      timestamp: new Date().toISOString(),
      payload,
      step: session.step
    });

    return session;
  }

  /**
   * Generate Africa's Talking XML response based on session and configuration
   */
  async processEvent(payload, onOperatorPrompt, onAiProgress) {
    const session = this.getOrCreateSession(payload);
    const { isActive, dtmfDigits, recordingUrl } = payload;

    // If call has ended (isActive = 0), no further XML response needed
    if (!session.isActive || isActive === '0' || isActive === 0) {
      if (recordingUrl) {
        console.log(`[IVR] Call ended with final recording URL: ${recordingUrl}. Transcribing in background...`);
        transcriptionService.transcribeAudioFromUrl(recordingUrl).then(transcript => {
          console.log(`[IVR] Final recording transcript: "${transcript}"`);
          session.conversation.push({
            timestamp: new Date().toISOString(),
            userTranscript: transcript,
            aiResponse: '(Call ended before AI response)',
            actionExecuted: null
          });
        }).catch(err => {
          console.warn('[IVR] Error transcribing final recording:', err.message);
        });
      }
      const completionXml = `<Response></Response>`;
      session.lastXmlResponse = completionXml;
      return { session, xml: completionXml, actionSummary: 'Call session ended' };
    }

    // Manual Operator Mode
    if (this.mode === 'manual') {
      try {
        const manualXml = await this.waitForOperatorResponse(session.sessionId, onOperatorPrompt, payload);
        session.step++;
        session.lastXmlResponse = manualXml;
        return { session, xml: manualXml, actionSummary: 'Operator dispatched response' };
      } catch (err) {
        console.warn(`[IVR] Operator response timeout for ${session.sessionId}, falling back to AI agent.`);
      }
    }

    // Custom XML Mode
    if (this.mode === 'custom') {
      session.step++;
      session.lastXmlResponse = this.customXml;
      return { session, xml: this.customXml, actionSummary: 'Custom XML Template' };
    }

    // AI Agent Mode (Featured: Audio Menu -> Record -> Transcribe -> Groq LLM -> Speak & Loop)
    if (this.mode === 'ai_agent') {
      const aiResponseData = await this.handleAiAgentTurn(session, recordingUrl, dtmfDigits, payload.simulatedSpeech, onAiProgress);
      if (aiResponseData.isInitialGreeting) {
        session.step = 1;
      } else {
        session.step++;
      }
      session.lastXmlResponse = aiResponseData.xml;
      return {
        session,
        xml: aiResponseData.xml,
        actionSummary: aiResponseData.summary,
        transcript: aiResponseData.transcript,
        aiReply: aiResponseData.aiReply,
        actionExecuted: aiResponseData.actionExecuted,
        latencyBreakdown: aiResponseData.latencyBreakdown
      };
    }

    // Fallback: Standard Interactive IVR Menu Flow
    const response = this.generateInteractiveFlow(session, dtmfDigits);
    session.step++;
    session.lastXmlResponse = response.xml;
    return { session, xml: response.xml, actionSummary: response.summary };
  }

  /**
   * Handle Conversational Voice AI Flow
   */
  async handleAiAgentTurn(session, recordingUrl, dtmfDigits, simulatedSpeech, onAiProgress) {
    const turnStartMs = Date.now();
    const callbackUrl = process.env.PUBLIC_CALLBACK_URL || '';
    const callbackAttr = callbackUrl ? ` callbackUrl="${escapeXml(callbackUrl)}"` : '';

    // Quick-win telecom parameters: Africa's Talking requires an integer for timeout (e.g. 3)
    const rawTimeout = process.env.AT_RECORD_TIMEOUT || '3';
    const parsedTimeout = Math.round(parseFloat(rawTimeout)) || 3;
    const recordTimeout = String(Math.max(1, parsedTimeout));
    const recordMaxLength = String(Math.max(1, Math.round(parseFloat(process.env.AT_RECORD_MAX_LENGTH || '12')) || 12));

    const hasCallerInput = Boolean(recordingUrl || dtmfDigits || simulatedSpeech);

    // Initial Turn / Call Startup: Greet caller with Language Selection Menu
    // Handles both Africa's Talking "Ringing" and initial "Active" webhooks before caller has responded.
    if (!hasCallerInput) {
      let promptTag = `<Say voice="en-US-Standard-C">Welcome to Okwankyerefopa MTN Mobile Money. For English, press 1. For Twi, press 2.</Say>`;

      // If user has a pre-recorded audio file menu configured in .env
      if (this.audioMenuUrl) {
        promptTag = `<Play url="${escapeXml(this.audioMenuUrl)}"/>`;
      }

      // Pillar 4: Dual-mode language selection.
      // 1. If caller presses 1 or 2: <GetDigits> captures it instantly (0 ASR quota).
      // 2. If caller does not press a key: falls through to <Record> and prompts them to speak.
      const xml = `<Response>
  <GetDigits timeout="4" numDigits="1" finishOnKey="#"${callbackAttr}>
    ${promptTag}
  </GetDigits>
  <Record finishOnKey="#" maxLength="${recordMaxLength}" timeout="${recordTimeout}" trimSilence="true" playBeep="true"${callbackAttr}>
    <Say voice="en-US-Standard-C">Please say English or Twi after the beep.</Say>
  </Record>
</Response>`;

      const totalTurnMs = Date.now() - turnStartMs;
      return {
        xml,
        isInitialGreeting: true,
        summary: 'Voice AI Greeting & Language Menu (<GetDigits> DTMF + <Record> Voice Fallback)',
        transcript: null,
        aiReply: null,
        actionExecuted: null,
        latencyBreakdown: {
          turnIndex: 0,
          sessionId: session.sessionId,
          downloadMs: 0,
          audioBytes: 0,
          sttMs: 0,
          llmMs: 0,
          toolMs: 0,
          totalTurnMs,
          targetSubTwoSeconds: true
        }
      };
    }

    // Turn 1+: Process caller speech or keypad response
    let userSpeech = '';
    let asrMetrics = null;
    let isSilenceDetected = false;

    if (simulatedSpeech) {
      userSpeech = simulatedSpeech;
    } else if (recordingUrl) {
      // 1. Transcribe caller audio recording from AT (using UG HCI Lab for Twi, Groq for English)
      if (typeof onAiProgress === 'function') {
        onAiProgress(session.sessionId, { stage: 'TRANSCRIBING', recordingUrl });
      }
      const asrOptions = {
        includeMetrics: true,
        provider: session.asrProvider || (session.language === 'twi' ? 'ug_hci' : undefined),
        language: session.language || 'en'
      };
      const asrResult = await transcriptionService.transcribeAudioFromUrl(recordingUrl, asrOptions);
      if (typeof asrResult === 'object' && asrResult.transcript !== undefined) {
        userSpeech = asrResult.transcript || '';
        asrMetrics = asrResult.metrics;
        isSilenceDetected = Boolean(asrResult.isSilence) || !userSpeech.trim();
      } else {
        userSpeech = asrResult || '';
        isSilenceDetected = !userSpeech.trim();
      }

      if (dtmfDigits) {
        const cleanDigits = String(dtmfDigits).replace(/#/g, '').trim();
        if (cleanDigits) {
          userSpeech = userSpeech ? `${userSpeech} (Caller pressed key ${cleanDigits})` : `Option ${cleanDigits}`;
          isSilenceDetected = false;
        }
      }
    } else if (dtmfDigits) {
      // Fallback if user entered keypad digits without audio
      const cleanDigits = String(dtmfDigits).replace(/#/g, '').trim();
      userSpeech = `Option ${cleanDigits || dtmfDigits}`;
    } else {
      isSilenceDetected = true;
      userSpeech = '';
    }

    // Language Selection Handling: If caller selected Twi (Keypad 2 or spoken Akan)
    const cleanDigits = dtmfDigits ? String(dtmfDigits).replace(/#/g, '').trim() : '';
    const isTwiChosen = cleanDigits === '2' || cleanDigits.startsWith('2') || /\b(twi|akan|kasa|mepe|mepɛ|akwaaba|mane|sika)\b/i.test(userSpeech);
    const isEnglishChosen = cleanDigits === '1' || /\b(english|brofo)\b/i.test(userSpeech);

    if (isEnglishChosen && session.language !== 'en') {
      session.language = 'en';
      session.asrProvider = 'groq';
      console.log(`[IVR ENGINE] 🇬🇧 Caller selected ENGLISH! Switched ASR provider to Groq Whisper.`);
    }

    if (isTwiChosen && session.language !== 'twi') {
      session.language = 'twi';
      session.asrProvider = 'ug_hci';
      console.log(`[IVR ENGINE] 🇬🇭 Caller selected TWI! Switched ASR provider to UG_HCI_LAB_API_KEY.`);

      const twiGreeting = "Akwaaba ba Okwankyerefopa MTN Mobile Money. Sɛ worepɛ sɛ womane sika a, ka sɛ mane sika anaa mia baako. Sɛ worepɛ sɛ wohwɛ wo sika a, ka sɛ hwɛ sika anaa mia mmienu. Sɛ worepɛ sɛ woyi sika a, ka sɛ yi sika anaa mia mmiɛnsa. Yɛretie wo.";

      let twiPromptTag = `<Say voice="en-US-Standard-C">${escapeXml(twiGreeting)}</Say>`;
      try {
        const synth = await hciLabService.synthesizeSpeech(twiGreeting, callbackUrl);
        if (synth && synth.audioUrl) {
          twiPromptTag = `<Play url="${escapeXml(synth.audioUrl)}"/>`;
        }
      } catch (err) {
        console.warn('[IVR ENGINE] Error synthesizing Twi greeting:', err.message);
      }

      // Turn 1 Conversational Mode: Play native Twi greeting and immediately beep and record caller's spoken request
      const xml = `<Response>
  <Record finishOnKey="#" maxLength="${recordMaxLength}" timeout="${recordTimeout}" trimSilence="true" playBeep="true"${callbackAttr}>
    ${twiPromptTag}
  </Record>
</Response>`;

      const totalTurnMs = Date.now() - turnStartMs;
      const latencyBreakdown = {
        turnIndex: session.step,
        sessionId: session.sessionId,
        downloadMs: asrMetrics?.downloadDurationMs || 0,
        audioBytes: asrMetrics?.audioBytes || 0,
        sttMs: asrMetrics?.sttDurationMs || 0,
        llmMs: 0,
        toolMs: 0,
        totalTurnMs,
        targetSubTwoSeconds: true,
        keysUsed: {
          audioWhisper: 'UG_HCI_LAB_API_KEY (University of Ghana HCI Lab)',
          llmReasoning: 'Language Switch Fast-Path'
        }
      };

      session.latencies = session.latencies || [];
      session.latencies.push(latencyBreakdown);

      return {
        xml,
        summary: 'Language switched to Twi (UG HCI Lab ASR active)',
        transcript: userSpeech || 'Option 2 (Twi)',
        aiReply: twiGreeting,
        actionExecuted: null,
        latencyBreakdown
      };
    }

    // Silence Gate: If no speech and no DTMF was received, prompt caller directly without wasting LLM tokens
    if (isSilenceDetected && !dtmfDigits) {
      console.log(`[IVR ENGINE] 🔇 Silence/no-speech detected on Turn ${session.step}. Skipping LLM to prevent token burn and hallucination.`);
      const silenceReply = session.step === 1
        ? "I didn't hear your response. To send money, press 1 or say send money. For account balance, press 2. To withdraw cash, press 3. Please speak your choice or press a key."
        : "I didn't catch that. Please speak after the tone, or enter your choice on the keypad, followed by the hash key.";

      const xml = `<Response>
  <Record finishOnKey="#" maxLength="${recordMaxLength}" timeout="${recordTimeout}" trimSilence="true" playBeep="true"${callbackAttr}>
    <Say voice="en-US-Standard-C">${escapeXml(silenceReply)}</Say>
  </Record>
</Response>`;

      const totalTurnMs = Date.now() - turnStartMs;
      const latencyBreakdown = {
        turnIndex: session.step,
        sessionId: session.sessionId,
        downloadMs: asrMetrics?.downloadDurationMs || 0,
        audioBytes: asrMetrics?.audioBytes || 0,
        sttMs: asrMetrics?.sttDurationMs || 0,
        llmMs: 0,
        toolMs: 0,
        totalTurnMs,
        targetSubTwoSeconds: true,
        keysUsed: {
          audioWhisper: transcriptionService.keySource,
          llmReasoning: 'Skipped (Silence Gate)'
        }
      };

      session.latencies = session.latencies || [];
      session.latencies.push(latencyBreakdown);

      return {
        xml,
        summary: 'Silence detected (Re-prompted caller without LLM token burn)',
        transcript: '(silence)',
        aiReply: silenceReply,
        actionExecuted: null,
        latencyBreakdown
      };
    }

    console.log(`\n======================================================`);
    console.log(`🤖 [IVR ENGINE] Turn ${session.step} (Session: ${session.sessionId})`);
    console.log(`Caller Input  : "${userSpeech}"`);
    if (dtmfDigits) console.log(`Keypad Digits : ${dtmfDigits}`);
    if (recordingUrl) console.log(`Recording URL : ${recordingUrl}`);
    console.log(`======================================================\n`);

    if (typeof onAiProgress === 'function') {
      onAiProgress(session.sessionId, { stage: 'THINKING', transcript: userSpeech });
    }

    // 2. Pass transcript and call context to Groq AI Agent (with session memory & tool calling)
    const callContext = {
      callerNumber: session.callerNumber,
      destinationNumber: session.destinationNumber,
      direction: session.direction,
      dtmfDigits: dtmfDigits,
      dtmfHistory: session.dtmfHistory,
      durationInSeconds: session.durationInSeconds,
      startTime: session.startTime,
      language: session.language || 'en'
    };
    const agentResult = await aiAgent.generateVoiceReply(session.sessionId, userSpeech, callContext);
    const aiReply = typeof agentResult === 'object' && agentResult.reply ? agentResult.reply : agentResult;
    const actionExecuted = typeof agentResult === 'object' ? agentResult.actionExecuted : null;
    const agentMetrics = typeof agentResult === 'object' ? agentResult.metrics : null;

    console.log(`\n💬 [AI Spoken Reply Turn ${session.step}]: "${aiReply}"`);
    if (actionExecuted) {
      console.log(`⚡ [Action Triggered]: ${actionExecuted.name} | Params:`, actionExecuted.params, `| Status: ${actionExecuted.result?.status || 'COMPLETED'}`);
    }

    // Save to conversation history
    session.conversation.push({
      timestamp: new Date().toISOString(),
      userTranscript: userSpeech,
      aiResponse: aiReply,
      actionExecuted
    });

    if (actionExecuted) {
      session.events.push({
        timestamp: new Date().toISOString(),
        type: 'AGENTIC_ACTION_EXECUTED',
        actionExecuted
      });
    }

    if (typeof onAiProgress === 'function') {
      onAiProgress(session.sessionId, { stage: 'REPLYING', transcript: userSpeech, aiReply, actionExecuted });
    }

    // 3. Return XML to speak the AI answer back to caller and keep listening
    let spokenOutputTag = `<Say voice="en-US-Standard-C">${escapeXml(aiReply)}</Say>`;
    if (session.language === 'twi') {
      try {
        const synth = await hciLabService.synthesizeSpeech(aiReply, callbackUrl);
        if (synth && synth.audioUrl) {
          spokenOutputTag = `<Play url="${escapeXml(synth.audioUrl)}"/>`;
        }
      } catch (err) {
        console.warn('[IVR ENGINE] Error synthesizing Twi audio:', err.message);
      }
    }

    const xml = `<Response>
  <Record finishOnKey="#" maxLength="${recordMaxLength}" timeout="${recordTimeout}" trimSilence="true" playBeep="false"${callbackAttr}>
    ${spokenOutputTag}
  </Record>
</Response>`;

    const totalTurnMs = Date.now() - turnStartMs;
    const latencyBreakdown = {
      turnIndex: session.step,
      sessionId: session.sessionId,
      downloadMs: asrMetrics?.downloadDurationMs || 0,
      audioBytes: asrMetrics?.audioBytes || 0,
      sttMs: asrMetrics?.sttDurationMs || 0,
      llmMs: agentMetrics?.llmDurationMs || 0,
      toolMs: agentMetrics?.toolExecutionMs || 0,
      totalTurnMs,
      targetSubTwoSeconds: totalTurnMs < 2000,
      keysUsed: {
        audioWhisper: session.language === 'twi' ? 'UG_HCI_LAB_API_KEY (University of Ghana HCI Lab)' : transcriptionService.keySource,
        llmReasoning: aiAgent.keySource
      }
    };

    session.latencies = session.latencies || [];
    session.latencies.push(latencyBreakdown);

    console.log(`\n======================================================`);
    console.log(`⏱️  [VOICE PIPELINE LATENCY PROFILER] Turn ${session.step} (Session: ${session.sessionId})`);
    console.log(`------------------------------------------------------`);
    console.log(`1. Audio Download    : ${(latencyBreakdown.downloadMs).toString().padStart(5)} ms (${latencyBreakdown.audioBytes} bytes)`);
    console.log(`2. Groq Whisper (STT): ${(latencyBreakdown.sttMs).toString().padStart(5)} ms [${transcriptionService.keySource || 'GROQ_TTS_KEY'}]`);
    console.log(`3. Groq LLM Agent    : ${(latencyBreakdown.llmMs).toString().padStart(5)} ms [${aiAgent.keySource || 'GROQ_LLM_KEY'}]`);
    if (latencyBreakdown.toolMs > 0) {
      console.log(`4. MoMo Tool Action  : ${(latencyBreakdown.toolMs).toString().padStart(5)} ms`);
    }
    console.log(`------------------------------------------------------`);
    console.log(`⚡ TOTAL TURN TIME   : ${(totalTurnMs).toString().padStart(5)} ms ${totalTurnMs < 2000 ? '✅ [SUB-2S TARGET MET]' : '⚠️ [OVER 2S BUDGET]'}`);
    console.log(`======================================================\n`);

    return {
      xml,
      summary: actionExecuted ? `⚡ Executed [${actionExecuted.name}]: "${userSpeech}"` : `AI Response to "${userSpeech}"`,
      transcript: userSpeech,
      aiReply,
      actionExecuted,
      latencyBreakdown
    };
  }

  /**
   * Standard numeric IVR flow (fallback)
   */
  generateInteractiveFlow(session, dtmfDigits) {
    if (session.step === 0 || !dtmfDigits) {
      const xml = `<Response>
  <GetDigits timeout="25" finishOnKey="#" numDigits="1">
    <Say voice="en-US-Standard-C" playBeep="false">Welcome to the Africa's Talking Phone Simulator. Press 1 to check your account balance. Press 2 to hear sample audio playback. Press 3 to leave a voice recording. Press 0 to connect to customer support.</Say>
  </GetDigits>
  <Say voice="en-US-Standard-C">We did not receive any key input. Thank you for testing Africa's Talking. Goodbye.</Say>
</Response>`;
      return {
        xml,
        summary: 'Main Menu Prompt (<GetDigits>)'
      };
    }

    const digit = String(dtmfDigits).trim();

    switch (digit) {
      case '1': {
        const xml = `<Response>
  <Say voice="en-US-Standard-C">Your current simulated account balance is 4,750 Kenyan Shillings. Thank you for calling.</Say>
</Response>`;
        return { xml, summary: 'Option 1: Account Balance' };
      }
      case '2': {
        const xml = `<Response>
  <Say voice="en-US-Standard-C">Now playing sample audio.</Say>
  <Play url="https://actions.google.com/sounds/v1/alarms/alarm_clock.ogg"/>
  <Say voice="en-US-Standard-C">Playback completed.</Say>
</Response>`;
        return { xml, summary: 'Option 2: Audio Playback' };
      }
      case '3': {
        const xml = `<Response>
  <Record finishOnKey="#" maxLength="20" playBeep="true" trimSilence="true">
    <Say voice="en-US-Standard-C">Please leave your voice message after the beep.</Say>
  </Record>
</Response>`;
        return { xml, summary: 'Option 3: Voice Recording' };
      }
      case '0': {
        const xml = `<Response>
  <Say voice="en-US-Standard-C">Connecting you to an agent. Please hold.</Say>
  <Dial phoneNumbers="+254711082999" record="true" sequential="false" maxDuration="60"/>
</Response>`;
        return { xml, summary: 'Option 0: Dial Agent' };
      }
      default: {
        const xml = `<Response>
  <Say voice="en-US-Standard-C">You entered an unrecognized option ${digit}. Goodbye.</Say>
</Response>`;
        return { xml, summary: `Unrecognized DTMF: ${digit}` };
      }
    }
  }

  waitForOperatorResponse(sessionId, onOperatorPrompt, payload) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCallbacks.delete(sessionId);
        reject(new Error('Operator timeout'));
      }, 8000);

      this.pendingCallbacks.set(sessionId, { resolve, timer });

      if (typeof onOperatorPrompt === 'function') {
        onOperatorPrompt(sessionId, payload);
      }
    });
  }

  resolveOperatorResponse(sessionId, xml) {
    const pending = this.pendingCallbacks.get(sessionId);
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(xml);
      this.pendingCallbacks.delete(sessionId);
      return true;
    }
    return false;
  }

  setMode(mode, customXml = null) {
    if (['ai_agent', 'interactive', 'custom', 'manual'].includes(mode)) {
      this.mode = mode;
    }
    if (customXml) {
      this.customXml = customXml;
    }
  }

  getDashboardData() {
    return {
      mode: this.mode,
      customXml: this.customXml,
      activeSessions: Array.from(this.sessions.values()).filter(s => s.isActive),
      recentHistory: this.history.slice(0, 20),
      totalSessionsCount: this.totalSessionsCreated,
      pendingOperatorCount: this.pendingCallbacks.size,
      aiConfig: aiAgent.getConfigSummary(),
      asrConfig: transcriptionService.getConfigSummary()
    };
  }

  endSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.isActive = false;
      session.status = 'ENDED_MANUALLY';
      session.endTime = new Date().toISOString();
      aiAgent.clearSession(sessionId);
      if (!this.history.some(h => h.sessionId === sessionId)) {
        this.history.unshift(session);
      }
      this.sessions.delete(sessionId);
      return true;
    }
    return false;
  }

  getCallReport(sessionId) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = this.history.find(s => s.sessionId === sessionId);
    }
    if (!session) return null;

    const latencies = session.latencies || [];
    const avgLatencyMs = latencies.length > 0
      ? Math.round(latencies.reduce((acc, l) => acc + (l.totalTurnMs || 0), 0) / latencies.length)
      : 0;

    return {
      sessionId: session.sessionId,
      callerNumber: session.callerNumber,
      destinationNumber: session.destinationNumber,
      direction: session.direction,
      status: session.status || (session.isActive ? 'ACTIVE' : 'COMPLETED'),
      startTime: session.startTime,
      durationInSeconds: session.durationInSeconds,
      turnsCount: session.step || latencies.length,
      averageTurnLatencyMs: avgLatencyMs,
      targetSubTwoSeconds: avgLatencyMs < 2000,
      groqKeys: {
        audioWhisperKey: transcriptionService.keySource,
        llmReasoningKey: aiAgent.keySource
      },
      latencies,
      conversation: session.conversation
    };
  }

  getLatestCallReport() {
    // If active session exists, get latest active
    const active = Array.from(this.sessions.values()).pop();
    if (active) return this.getCallReport(active.sessionId);
    if (this.history.length > 0) return this.getCallReport(this.history[0].sessionId);
    return null;
  }
}

module.exports = new IvrEngine();
