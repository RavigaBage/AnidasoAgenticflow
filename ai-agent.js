/**
 * AI Agent Service using Groq API
 * Conversational Slot-Filling & Agentic Action Triggering for MTN Ghana MoMo Services.
 * Reads menus and required data from services_script/mtn_momo_ivr_script.json.
 * 
 * True Agentic Architecture:
 * - Pure LLM-driven reasoning: No hardcoded regex or programmatic intercepts.
 * - Anti-Fraud Security Guard: The AI reasons about recipient phone numbers, looks up KYC
 *   via verify_kyc_mtn, gathers all missing fields first, and only confirms reference/approval ONCE
 *   after all required data (number, amount, reference) has been collected.
 * - Active Call Session Memory: Retains conversation context, caller number, history,
 *   DTMF digits, and executed actions, discarded immediately upon call termination.
 */

require('dotenv').config();
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const actionExecutor = require('./action-executor');

/**
 * CallSessionMemory
 * Maintains in-memory state and context for an active phone call session.
 * Discarded immediately when the call terminates.
 */
class CallSessionMemory {
  constructor(sessionId, initialContext = {}) {
    this.sessionId = sessionId;
    this.callerNumber = initialContext.callerNumber || 'Unknown';
    this.destinationNumber = initialContext.destinationNumber || 'Unknown';
    this.direction = initialContext.direction || 'Inbound';
    this.startTime = initialContext.startTime || new Date().toISOString();
    this.startTimeMs = Date.now();
    this.lastActiveTime = new Date().toISOString();

    // DTMF history in this call
    this.dtmfHistory = initialContext.dtmfHistory ? [...initialContext.dtmfHistory] : [];
    if (initialContext.dtmfDigits && !this.dtmfHistory.includes(initialContext.dtmfDigits)) {
      this.dtmfHistory.push(initialContext.dtmfDigits);
    }

    // Extracted slot values during this call (updated as actions execute)
    this.slots = {
      service: null, // 'send_money' | 'check_balance' | 'cash_out' | 'verify_kyc'
      recipientNumber: null,
      recipientNetwork: null,
      statedRecipientName: null,
      verifiedKycName: null,
      kycVerifiedNumber: null,
      discrepancyWarning: null,
      amount: null,
      reference: null,
      confirmed: false
    };

    // Actions executed during this call session
    this.executedActions = [];

    // Conversation turns in this session: [{ turnIndex, user, ai, actionExecuted, timestamp }]
    this.turns = [];

    // Messages array formatted for Groq / OpenAI completions API
    this.llmMessages = [];
  }

  updateContext(context = {}) {
    if (context.callerNumber && context.callerNumber !== 'Unknown') {
      this.callerNumber = context.callerNumber;
    }
    if (context.destinationNumber && context.destinationNumber !== 'Unknown') {
      this.destinationNumber = context.destinationNumber;
    }
    if (context.direction) {
      this.direction = context.direction;
    }
    if (context.dtmfDigits && !this.dtmfHistory.includes(context.dtmfDigits)) {
      this.dtmfHistory.push(context.dtmfDigits);
    }
    if (Array.isArray(context.dtmfHistory)) {
      this.dtmfHistory = [...new Set([...this.dtmfHistory, ...context.dtmfHistory])];
    }
    this.lastActiveTime = new Date().toISOString();
  }

  recordTurn(userSpeech, aiReply, actionExecuted = null) {
    this.turns.push({
      turnIndex: this.turns.length + 1,
      timestamp: new Date().toISOString(),
      user: userSpeech,
      ai: aiReply,
      actionExecuted
    });
    this.lastActiveTime = new Date().toISOString();
  }

  recordAction(actionName, params = {}, result = {}) {
    this.executedActions.push({
      actionName,
      params,
      result,
      timestamp: new Date().toISOString(),
      transactionId: result.transactionId || result.financialTransactionId || null
    });

    if (actionName === 'send_money_mtn') {
      this.slots.service = 'send_money';
      if (params.number) this.slots.recipientNumber = params.number;
      if (params.network) this.slots.recipientNetwork = params.network;
      if (params.amount) this.slots.amount = params.amount;
      if (params.reference) this.slots.reference = params.reference;
      if (params.registered_name) this.slots.verifiedKycName = params.registered_name;
      if (params.confirm) this.slots.confirmed = true;
    } else if (actionName === 'check_balance_mtn') {
      this.slots.service = 'check_balance';
      if (params.number) this.slots.recipientNumber = params.number;
    } else if (actionName === 'cash_out_mtn') {
      this.slots.service = 'cash_out';
      if (params.amount) this.slots.amount = params.amount;
    } else if (actionName === 'verify_kyc_mtn') {
      if (this.slots.service !== 'send_money') {
        this.slots.service = 'verify_kyc';
      }
      if (params.number) {
        this.slots.recipientNumber = params.number;
        this.slots.kycVerifiedNumber = params.number;
      }
      if (params.stated_name) {
        this.slots.statedRecipientName = params.stated_name;
      }
      if (result.subscriberName) {
        this.slots.verifiedKycName = result.subscriberName;
      }
      if (result.discrepancyWarning) {
        this.slots.discrepancyWarning = result.discrepancyWarning;
      }
    }
    this.lastActiveTime = new Date().toISOString();
  }

  getDurationSeconds() {
    return Math.round((Date.now() - this.startTimeMs) / 1000);
  }

  buildSystemPrompt(baseSystemPrompt) {
    const kycState = [
      `Recipient: ${this.slots.recipientNumber || 'None'} (${this.slots.recipientNetwork || 'Unknown'})`,
      `KYC Registered Name: ${this.slots.verifiedKycName || 'NOT YET VERIFIED (call verify_kyc_mtn first)'}`,
      this.slots.statedRecipientName ? `Caller Stated Name: ${this.slots.statedRecipientName}` : null,
      this.slots.discrepancyWarning ? `DISCREPANCY: ${this.slots.discrepancyWarning}` : null,
      `Amount: ${this.slots.amount ? `${this.slots.amount} GHS` : 'None'}`,
      `Reference: ${this.slots.reference || 'None'}`,
      `Approval Given: ${this.slots.confirmed ? 'YES' : 'NO'}`
    ].filter(Boolean).join('\n- ');

    const sessionContext = `
==================================================
📞 ACTIVE CALL SESSION STATE:
- Caller: ${this.callerNumber} (Duration: ${this.getDurationSeconds()}s)
- ${kycState}
==================================================`;

    return `${baseSystemPrompt}\n${sessionContext}`;
  }

  getSummary() {
    return {
      sessionId: this.sessionId,
      callerNumber: this.callerNumber,
      destinationNumber: this.destinationNumber,
      direction: this.direction,
      startTime: this.startTime,
      durationSeconds: this.getDurationSeconds(),
      lastActiveTime: this.lastActiveTime,
      dtmfHistory: this.dtmfHistory,
      slots: this.slots,
      executedActions: this.executedActions,
      turnsCount: this.turns.length,
      turns: this.turns
    };
  }
}

class AiAgent {
  constructor() {
    this.memoryFilePath = path.join(__dirname, 'services-memory.json');
    this.scriptFilePath = path.join(__dirname, 'services_script', 'mtn_momo_ivr_script.json');
    this.sessionMemories = new Map(); // sessionId -> CallSessionMemory
    this.onMemoryChange = null; // Callback for server / WebSocket broadcast
    this.onActionExecuted = null; // Callback when an agentic action is triggered
    this.onMemoryDiscarded = null; // Callback when a call session memory is discarded
    this.reloadConfig();
    this.setupFileWatcher();

    // Auto-cleanup stale sessions that have had no activity for > 15 minutes
    setInterval(() => this.cleanupStaleSessions(), 60000);
  }

  setupFileWatcher() {
    const watchHandler = (file) => (eventType) => {
      if (eventType === 'change' || eventType === 'rename') {
        console.log(`\n[AI Agent] 🔄 Hot-reloaded ${file} after change!`);
        this.reloadConfig();
        if (typeof this.onMemoryChange === 'function') {
          this.onMemoryChange(this.servicesMemory);
        }
      }
    };

    try {
      if (fs.existsSync(this.memoryFilePath)) {
        fs.watch(this.memoryFilePath, watchHandler('services-memory.json'));
      }
      if (fs.existsSync(this.scriptFilePath)) {
        fs.watch(this.scriptFilePath, watchHandler('mtn_momo_ivr_script.json'));
      }
    } catch (err) {
      console.warn('[AI Agent] File watcher notice:', err.message);
    }
  }

  reloadConfig() {
    // Prioritize dedicated LLM reasoning key (GROQ_LLM_KEY), fallback to GROQ_API_KEY
    this.apiKey = process.env.GROQ_LLM_KEY || process.env.GROQ_API_KEY || '';
    this.keySource = process.env.GROQ_LLM_KEY ? 'GROQ_LLM_KEY (dedicated LLM)' : 'GROQ_API_KEY (shared)';
    this.model = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
    this.fallbackModel = process.env.GROQ_FALLBACK_MODEL || 'qwen/qwen3.8-27b';
    this.apiUrl = 'https://api.groq.com/openai/v1/chat/completions';
    this.servicesMemory = this.loadServicesMemory();
    this.ivrScript = this.loadIvrScript();
    this.systemPrompt = this.buildSystemPrompt();

    // Hot-update system prompt for all ongoing active sessions
    for (const [sessionId, sessionMem] of this.sessionMemories.entries()) {
      if (sessionMem && sessionMem.llmMessages && sessionMem.llmMessages.length > 0) {
        sessionMem.llmMessages[0].content = sessionMem.buildSystemPrompt(this.systemPrompt);
      }
    }
  }

  getConfigSummary() {
    this.reloadConfig();
    return {
      model: this.model,
      fallbackModel: this.fallbackModel,
      keySource: this.keySource,
      isConfigured: Boolean(this.apiKey)
    };
  }

  loadServicesMemory() {
    try {
      if (fs.existsSync(this.memoryFilePath)) {
        const raw = fs.readFileSync(this.memoryFilePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn('[AI Agent] Could not load services-memory.json:', err.message);
    }
    return { organization: "Anidaso Telephony", availableServices: [] };
  }

  loadIvrScript() {
    try {
      if (fs.existsSync(this.scriptFilePath)) {
        const raw = fs.readFileSync(this.scriptFilePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn('[AI Agent] Could not load mtn_momo_ivr_script.json:', err.message);
    }
    return {};
  }

  buildSystemPrompt() {
    return `You are Okwankyerefopa, a humble, patient phone helper for MTN Mobile Money (MoMo) in Ghana.
VOICE & TONE:
- Speak respectfully and warmly in everyday Ghanaian English. Strictly 1 to 2 spoken sentences (under 30 words).
- Say "please" often. Never speak internal monologue or instructions. No markdown, emojis, or technical jargon (say "check", "send", "name registered to this number").

MENU & INTENT:
- 1 / "Send Money": gather recipient number, amount, reference, verify KYC, and confirm before sending.
- 2 / "Check Balance": call check_balance_mtn for caller line.
- 3 / "Withdraw Money": call cash_out_mtn once caller confirms.
- Direct Intent: If caller states what they want right away, reason directly without forcing menu options.

GHANA MOBILE NETWORKS:
- MTN: 024, 054, 055, 059, 025. Telecel: 020, 050. AirtelTigo: 027, 057, 026, 056.
- If number is unrecognized or not 10 digits: "[number], this is the number I got. Mobile Money requires a 10-digit MTN, Telecel, or AirtelTigo number. Please check the number."

SEND MONEY SEQUENCE & ANTI-FRAUD RULES:
1. Spoken Number: When a 10-digit number is spoken, call verify_kyc_mtn(number, stated_name).
2. Missing Fields:
   - If amount missing: state registered name (or discrepancy), ask for amount in Ghana Cedis.
   - If reference missing: ask for reference note (e.g. "What is the note for this transfer, like school fees or thank you?").
3. Final Approval (Speak ONCE only when number, name, amount, and reference are ALL known):
   "You are about to send [amount] Ghana Cedis to an [network] number, [number]. The name registered to this number is [name], and the reference is [reference]. Do you approve to these before initiating?"
4. Execution:
   - ONLY when caller explicitly confirms ("yes", "confirm", "I approve", or enters 1), call send_money_mtn(confirm=true).
   - If caller says "no" or "cancel": "Transfer cancelled. Please provide the correct recipient phone number."
5. Anti-Hallucination:
   - NEVER call tools or use phone numbers/amounts unless explicitly spoken by caller. Never invent data.`;
  }

  getConfigSummary() {
    this.reloadConfig();
    return {
      model: this.model,
      hasKey: Boolean(this.apiKey && this.apiKey.startsWith('gsk_')),
      provider: 'Groq Cloud',
      organization: this.servicesMemory.organization || 'Okwankyerefopa MTN MoMo',
      activeSessionMemoriesCount: this.sessionMemories.size
    };
  }

  getServicesMemory() {
    return this.loadServicesMemory();
  }

  /**
   * Retrieve or create CallSessionMemory for a given sessionId
   */
  getSessionMemory(sessionId, initialContext = {}) {
    this.reloadConfig();
    let sessionMem = this.sessionMemories.get(sessionId);

    if (!sessionMem) {
      sessionMem = new CallSessionMemory(sessionId, initialContext);
      sessionMem.llmMessages = [
        { role: 'system', content: sessionMem.buildSystemPrompt(this.systemPrompt) }
      ];
      this.sessionMemories.set(sessionId, sessionMem);
      console.log(`[AI Session Memory] 🆕 Created new session memory for: ${sessionId} (Caller: ${sessionMem.callerNumber})`);
    } else {
      if (initialContext && Object.keys(initialContext).length > 0) {
        sessionMem.updateContext(initialContext);
      }
      sessionMem.llmMessages[0] = {
        role: 'system',
        content: sessionMem.buildSystemPrompt(this.systemPrompt)
      };
    }

    return sessionMem;
  }

  getSessionMemorySummary(sessionId) {
    const mem = this.sessionMemories.get(sessionId);
    return mem ? mem.getSummary() : null;
  }

  getConversation(sessionId) {
    const mem = this.sessionMemories.get(sessionId);
    return mem ? mem.llmMessages : [];
  }

  /**
   * Discard session memory as soon as call ends
   */
  discardSessionMemory(sessionId) {
    if (this.sessionMemories.has(sessionId)) {
      const mem = this.sessionMemories.get(sessionId);
      const summary = {
        sessionId,
        callerNumber: mem.callerNumber,
        turnsCount: mem.turns.length,
        actionsCount: mem.executedActions.length,
        durationSeconds: mem.getDurationSeconds()
      };
      this.sessionMemories.delete(sessionId);
      console.log(`[AI Session Memory] 🧹 Discarded memory for session: ${sessionId} (Duration: ${summary.durationSeconds}s, Turns: ${summary.turnsCount}, Actions: ${summary.actionsCount})`);

      if (typeof this.onMemoryDiscarded === 'function') {
        this.onMemoryDiscarded(sessionId, summary);
      }
      return true;
    }
    return false;
  }

  clearSession(sessionId) {
    return this.discardSessionMemory(sessionId);
  }

  cleanupStaleSessions(maxAgeMs = 15 * 60 * 1000) {
    const now = Date.now();
    for (const [sessionId, mem] of this.sessionMemories.entries()) {
      if (now - new Date(mem.lastActiveTime).getTime() > maxAgeMs) {
        console.log(`[AI Session Memory] ⏱️ Auto-expiring stale session memory: ${sessionId}`);
        this.discardSessionMemory(sessionId);
      }
    }
  }

  /**
   * Send completion request to Groq with instant failover on 429 rate limits.
   * If the primary model hits a rate limit, it immediately attempts the fallbackModel
   * (e.g. llama-3.1-8b-instant) with 0ms sleep because Groq tracks limits per-model!
   */
  async callGroq(payload) {
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    };

    try {
      return await axios.post(this.apiUrl, payload, { headers, timeout: 7000 });
    } catch (err) {
      if (err.response?.status === 429 && this.fallbackModel && payload.model !== this.fallbackModel) {
        console.warn(`[AI Agent] ⚡ Groq 429 rate limit on ${payload.model}. Fast-failing over to ${this.fallbackModel} (0ms wait)...`);
        const fallbackPayload = {
          ...payload,
          model: this.fallbackModel
        };
        delete fallbackPayload.reasoning_format;
        delete fallbackPayload.reasoning_effort;
        try {
          return await axios.post(this.apiUrl, fallbackPayload, { headers, timeout: 6000 });
        } catch (fallbackErr) {
          console.warn(`[AI Agent] Fallback model error:`, fallbackErr.response?.data?.error?.message || fallbackErr.message);
          throw fallbackErr;
        }
      }
      throw err;
    }
  }

  /**
   * Process user speech, let the agent reason autonomously, and execute actions when triggered.
   * Returns reply, actionExecuted, and high-resolution latency metrics.
   */
  async generateVoiceReply(sessionId, userTranscript, callContext = {}) {
    this.reloadConfig();
    const startTime = Date.now();
    let toolExecutionMs = 0;

    if (!this.apiKey) {
      console.warn('[AI Agent] No GROQ_API_KEY found in .env');
      return {
        reply: `I received your request: "${userTranscript}". How else may I assist you today?`,
        actionExecuted: null,
        metrics: {
          llmDurationMs: 0,
          toolExecutionMs: 0,
          totalDurationMs: Date.now() - startTime
        }
      };
    }

    const sessionMem = this.getSessionMemory(sessionId, callContext);

    // Keep system prompt updated with the active session context and memory
    sessionMem.llmMessages[0] = {
      role: 'system',
      content: sessionMem.buildSystemPrompt(this.systemPrompt)
    };

    const messages = sessionMem.llmMessages;
    messages.push({ role: 'user', content: userTranscript });

    // Limit conversation history to last 8 messages for prompt efficiency and low latency
    if (messages.length > 9) {
      const system = messages[0];
      const recent = messages.slice(-8);
      sessionMem.llmMessages = [system, ...recent];
    }

    const tools = actionExecutor.getTools();

    try {
      // 1. Send conversation + tools to the LLM for agentic reasoning
      const firstCallStart = Date.now();
      const response = await this.callGroq({
        model: this.model,
        messages: sessionMem.llmMessages,
        tools,
        tool_choice: 'auto',
        temperature: 0.2,
        reasoning_effort: 'low',
        reasoning_format: 'hidden',
        max_tokens: 180
      });
      let llmDurationMs = Date.now() - firstCallStart;

      const choice = response.data?.choices?.[0];
      const message = choice?.message;

      // 2. Check if the AI Agent decided to trigger an Agentic Action
      if (message?.tool_calls && message.tool_calls.length > 0) {
        const toolCall = message.tool_calls[0];
        const actionName = toolCall.function.name;
        let actionParams = {};

        try {
          actionParams = JSON.parse(toolCall.function.arguments);
        } catch (e) {
          console.warn('[AI Agent] Could not parse tool arguments:', toolCall.function.arguments);
        }

        console.log(`[AI Agent] ⚡ Agent Reasoned Action: ${actionName} with params:`, actionParams);

        // Execute action through action-executor (live MTN MoMo sandbox API)
        const toolStart = Date.now();
        const actionResult = await actionExecutor.execute(actionName, actionParams, sessionId);
        toolExecutionMs = Date.now() - toolStart;

        // Record action in session memory
        sessionMem.recordAction(actionName, actionParams, actionResult);

        // Notify subscribers (server, WebSocket, live dashboard feed)
        if (typeof this.onActionExecuted === 'function') {
          this.onActionExecuted({
            actionName,
            params: actionParams,
            result: actionResult,
            sessionId
          });
        }

        // Add assistant tool_calls message and tool response into history
        messages.push(message);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: actionName,
          content: JSON.stringify(actionResult)
        });

        // 3. Spoken response: if tool provided a promptMessage, use it directly (0ms LLM, 0 tokens burned)
        let finalVoiceReply = actionResult.promptMessage || '';
        if (!finalVoiceReply) {
          try {
            const secondCallStart = Date.now();
            const followUpResponse = await this.callGroq({
              model: this.model,
              messages: sessionMem.llmMessages,
              temperature: 0.2,
              max_tokens: 120
            });
            llmDurationMs += (Date.now() - secondCallStart);
            finalVoiceReply = followUpResponse.data?.choices?.[0]?.message?.content?.trim();
          } catch (followUpErr) {
            console.warn('[AI Agent] Follow-up spoken response note:', followUpErr.response?.data?.error?.message || followUpErr.message);
          }
        }

        if (!finalVoiceReply || finalVoiceReply.startsWith('{') || finalVoiceReply.startsWith('`')) {
          finalVoiceReply = actionResult.promptMessage || `Your request has been initiated with reference ${actionResult.transactionId || 'pending'}.`;
        }

        finalVoiceReply = finalVoiceReply
          .replace(/<think>[\s\S]*?<\/think>/gi, '')
          .replace(/[*_#`~]/g, '')
          .replace(/\[.*?\]/g, '')
          .trim();
        messages.push({ role: 'assistant', content: finalVoiceReply });

        // Record turn in session memory
        sessionMem.recordTurn(userTranscript, finalVoiceReply, {
          name: actionName,
          params: actionParams,
          result: actionResult
        });

        return {
          reply: finalVoiceReply,
          actionExecuted: {
            name: actionName,
            params: actionParams,
            result: actionResult
          },
          metrics: {
            llmDurationMs,
            toolExecutionMs,
            totalDurationMs: Date.now() - startTime
          }
        };
      }

      // 4. No tool call: caller is in conversation, asking a question, or providing partial details
      let replyContent = message?.content?.trim();
      if (!replyContent) {
        replyContent = "I'm listening. Could you please specify if you would like to send money, check your balance, or withdraw cash?";
      }

      // Strip any internal thinking markers, markdown, or quotation marks
      let cleanVoiceReply = replyContent
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/^We have a call[\s\S]*?(?:So let's ask:|So we ask:)\s*"?/i, '')
        .replace(/[*_#`~]/g, '')
        .replace(/\[.*?\]/g, '')
        .replace(/^"+|"+$/g, '')
        .trim();

      messages.push({ role: 'assistant', content: cleanVoiceReply });
      sessionMem.recordTurn(userTranscript, cleanVoiceReply, null);

      return {
        reply: cleanVoiceReply,
        actionExecuted: null,
        metrics: {
          llmDurationMs,
          toolExecutionMs: 0,
          totalDurationMs: Date.now() - startTime
        }
      };

    } catch (error) {
      console.error('[AI Agent Error]:', error.response?.data || error.message);

      // Context-aware fallback so an in-progress transfer is never reset to top-level menu
      const s = sessionMem.slots;
      let fallbackReply = '';
      if (s.recipientNumber && s.amount && s.reference && s.verifiedKycName) {
        fallbackReply = `You are about to send ${s.amount} Ghana Cedis to an MTN number, ${s.recipientNumber}. The name registered to this number is ${s.verifiedKycName}, and the reference is ${s.reference}. Do you approve to these before initiating?`;
      } else if (s.recipientNumber && !s.amount) {
        fallbackReply = `The number ${s.recipientNumber} is registered to ${s.verifiedKycName || 'Mobile Money'}. How many Ghana Cedis would you like to send?`;
      } else if (s.recipientNumber && s.amount && !s.reference) {
        fallbackReply = `What is the reference note for sending ${s.amount} Ghana Cedis to ${s.recipientNumber}?`;
      } else {
        fallbackReply = `I'm listening. Would you like to send money, check your balance, or withdraw cash?`;
      }

      messages.push({ role: 'assistant', content: fallbackReply });
      sessionMem.recordTurn(userTranscript, fallbackReply, null);
      return {
        reply: fallbackReply,
        actionExecuted: null,
        metrics: {
          llmDurationMs: Date.now() - startTime,
          toolExecutionMs: 0,
          totalDurationMs: Date.now() - startTime
        }
      };
    }
  }
}

module.exports = new AiAgent();
