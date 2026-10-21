/**
 * Africa's Talking IVR & Call Session Engine
 * Handles session lifecycle, DTMF state machines, Pluggable ASR Transcription, and Groq AI Agent reasoning.
 */

const aiAgent = require('./ai-agent');
const transcriptionService = require('./transcription');

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
      session.step++;
      session.lastXmlResponse = aiResponseData.xml;
      return {
        session,
        xml: aiResponseData.xml,
        actionSummary: aiResponseData.summary,
        transcript: aiResponseData.transcript,
        aiReply: aiResponseData.aiReply
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
    const callbackUrl = process.env.PUBLIC_CALLBACK_URL || '';
    const callbackAttr = callbackUrl ? ` callbackUrl="${callbackUrl}"` : '';

    // Turn 0: Call just started. Greet with audio menu and begin recording user voice response
    if (session.step === 0 && !recordingUrl && !dtmfDigits && !simulatedSpeech) {
      let promptTag = `<Say voice="en-US-Standard-C">Welcome to Okwankyerefopa MTN Mobile Money. Please tell us what you would like to do, and press hash when you are done.</Say>`;
      
      // If user has a pre-recorded audio file menu configured in .env
      if (this.audioMenuUrl) {
        promptTag = `<Play url="${this.audioMenuUrl}"/>`;
      }

      const xml = `<Response>
  <Record finishOnKey="#" maxLength="15" timeout="3" trimSilence="true" playBeep="true"${callbackAttr}>
    ${promptTag}
  </Record>
</Response>`;

      return {
        xml,
        summary: 'Voice AI Greeting & Prompt (<Record> listening for user voice)',
        transcript: null,
        aiReply: null
      };
    }

    // Turn 1+: Process caller speech or keypad response
    let userSpeech = '';

    if (simulatedSpeech) {
      userSpeech = simulatedSpeech;
    } else if (recordingUrl) {
      // 1. Transcribe caller audio recording from AT
      if (typeof onAiProgress === 'function') {
        onAiProgress(session.sessionId, { stage: 'TRANSCRIBING', recordingUrl });
      }
      userSpeech = await transcriptionService.transcribeAudioFromUrl(recordingUrl);
    } else if (dtmfDigits) {
      // Fallback if user entered keypad digits
      userSpeech = `Option ${dtmfDigits}`;
    } else {
      userSpeech = 'Hello, can you help me?';
    }

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
      startTime: session.startTime
    };
    const agentResult = await aiAgent.generateVoiceReply(session.sessionId, userSpeech, callContext);
    const aiReply = typeof agentResult === 'object' && agentResult.reply ? agentResult.reply : agentResult;
    const actionExecuted = typeof agentResult === 'object' ? agentResult.actionExecuted : null;

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
    const xml = `<Response>
  <Record finishOnKey="#" maxLength="15" timeout="3" trimSilence="true" playBeep="false"${callbackAttr}>
    <Say voice="en-US-Standard-C">${aiReply} Please press hash when done.</Say>
  </Record>
</Response>`;

    return {
      xml,
      summary: actionExecuted ? `⚡ Executed [${actionExecuted.name}]: "${userSpeech}"` : `AI Response to "${userSpeech}"`,
      transcript: userSpeech,
      aiReply,
      actionExecuted
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
      totalSessionsCount: this.sessions.size,
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
      return true;
    }
    return false;
  }
}

module.exports = new IvrEngine();
