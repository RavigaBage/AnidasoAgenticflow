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
    const actionsSummary = this.executedActions.length > 0
      ? this.executedActions.map((a, i) =>
        `  ${i + 1}. [${a.timestamp}] Action: ${a.actionName} | TxID: ${a.transactionId || 'None'} | Status: ${a.result?.status || 'COMPLETED'} | Details: ${JSON.stringify(a.params)}`
      ).join('\n')
      : '  (None executed yet)';

    const turnsSummary = this.turns.length > 0
      ? this.turns.slice(-4).map(t =>
        `  - Turn ${t.turnIndex}: Caller said "${t.user}" -> AI replied "${t.ai}"${t.actionExecuted ? ` [Action: ${t.actionExecuted.name}]` : ''}`
      ).join('\n')
      : '  (Call session just started)';

    const kycStateSection = `
==================================================
🛡️ ACTIVE SESSION SECURITY & KYC VERIFICATION STATE:
==================================================
- Recipient Phone Number: ${this.slots.recipientNumber || 'Not provided yet'}
- Recipient Network: ${this.slots.recipientNetwork || 'Not detected yet'}
- Caller Stated Recipient Name: ${this.slots.statedRecipientName || '(None stated)'}
- Official Registered KYC Name: ${this.slots.verifiedKycName || 'NOT YET VERIFIED - MUST CALL verify_kyc_mtn FIRST'}
- KYC Verified for Number: ${this.slots.kycVerifiedNumber || 'None'}
${this.slots.discrepancyWarning ? `- ⚠️ ACTIVE DISCREPANCY: ${this.slots.discrepancyWarning}` : ''}
- Transfer Amount: ${this.slots.amount ? `${this.slots.amount} Ghana Cedis` : 'NOT PROVIDED YET (MUST ASK CALLER FOR AMOUNT BEFORE ASKING FOR APPROVAL)'}
- Transfer Reference Note: ${this.slots.reference ? this.slots.reference : 'NOT PROVIDED YET (MUST ASK CALLER FOR REFERENCE BEFORE ASKING FOR APPROVAL)'}`;

    const sessionContextSection = `
==================================================
📞 ACTIVE CALL SESSION CONTEXT & MEMORY:
==================================================
- Call Session ID: ${this.sessionId}
- Caller Phone Number: ${this.callerNumber}
- Line / Destination: ${this.destinationNumber}
- Call Direction: ${this.direction}
- DTMF Pressed In Call: ${this.dtmfHistory.length > 0 ? this.dtmfHistory.join(', ') : 'None'}
- Call Duration: ${this.getDurationSeconds()}s
${kycStateSection}

ACTIONS COMPLETED IN THIS CALL:
${actionsSummary}

RECENT CONVERSATION TURNS:
${turnsSummary}

SESSION CONTEXT GUIDELINES:
0. IVR SCRIPT MENU ROUTING & KEYPAD CHOICES:
   - Option 1 / Keypad 1 / "Send Money": Follows script_a_send_money. If recipient number is not yet known, ask: "You have selected Send Money. Please tell us the recipient's mobile phone number, followed by the hash key."
   - Option 2 / Keypad 2 / "Check Balance": Call tool "check_balance_mtn", then advise: "Your balance enquiry has been initiated. You can also dial star one seven zero hash and choose My Wallet. Enter your PIN only on the official prompt."
   - Option 3 / Keypad 3 / "Withdraw Money": Follows script_c_withdraw_money: "To withdraw cash, please visit an authorized MTN Mobile Money agent. Would you like to proceed with cash out now?"
   - Option 9 / Keypad 9 / "Repeat Menu": Repeat the menu: "To send money, press 1. For account and balance enquiry, press 2. To withdraw money, press 3."
   - SMART REASONING: If caller states partial or full details right away (e.g. "I want to send 100 cedis to 055..."), reason directly, run KYC on the number, and gather missing fields without forcing them to re-select option 1.

1. REASONING OUT NUMBERS & CLARIFICATION (CRITICAL AGENT RULE):
   - Whenever any number is given by the caller, reason the situation out and clarify:
     * ALWAYS start your clarification or warning reply by repeating the exact number received if it doesn't fit standard 10-digit format or when network is unrecognized:
       "[number], this is the number I got..."
     * Case A - Network is NOT detected or unrecognized (e.g. 233998098763 or 0992828374 or 0443838473 or 0293847506):
       "[spoken number], this is the number I got. The network is not detected, the number must be an MTN, Telecel or AirtelTigo number to be able to send it to a Mobile Money user. Please check the number and try again."
     * Case B - Number has country code prefix and maps to a recognized network (e.g. 233553838463 or 233553838464):
       "[spoken number], this is the number I got, are you trying to send the money to [0xxxxxxxxx] which is an [Operator] number?"
     * Case C - Number is a bank account or non-10-digit number (e.g. 020398745 or 044448373009238):
       "[spoken number], this is the number I got, but Mobile Money requires a 10-digit mobile phone number. What is the recipient's phone number?"
     * CRITICAL: Do NOT proceed to ask for amount, reference, or confirmation if the network is not detected or number does not fit!

2. MANDATORY RECIPIENT KYC LOOKUP BEFORE CONFIRMATION:
   - When a valid 10-digit recipient number with detected network is provided or updated for a transfer, you MUST FIRST call tool "verify_kyc_mtn" with { number: [recipient number], stated_name: [caller's stated recipient name if mentioned] }.

3. DATA GATHERING & MISSING FIELD HANDLING (NEVER ASK FOR APPROVAL PREMATURELY!):
   - A transfer strictly requires 4 fields: (1) Recipient Number, (2) KYC Registered Name, (3) Amount, and (4) Reference Note.
   - If AMOUNT is missing after KYC:
     * Acknowledge the registered name (or discrepancy) and ask for the missing amount:
       - If names match or no person name was stated:
         "The number [number] is registered to [registered KYC name] on [Network] Mobile Money. How many Ghana Cedis would you like to send?"
       - If discrepancy detected:
         "The number [number] is registered to [registered KYC name] on [Network] Mobile Money, not [stated name]. How many Ghana Cedis would you like to send?"
     * CRITICAL: DO NOT ask for approval or confirmation yet! DO NOT say "Do you approve to these before initiating?" yet! DO NOT invent a reference note!
   - If REFERENCE is missing (and number and amount are already known):
     * Ask for the reference:
       "What is the reference for this transfer, such as the reason or note?"
     * CRITICAL: DO NOT ask for approval or confirmation yet!

4. THE ONE AND ONLY FINAL REFERENCING APPROVAL (SPEAK ONLY ONCE AFTER ALL DATA IS COLLECTED):
   - CRITICAL TIMING & REASONING RULE:
     * When the caller tells you the reference (e.g. caller says "use debbt" or "school fees"):
       THE CALLER IS ONLY PROVIDING THE REFERENCE NOTE. THE CALLER HAS NOT CONFIRMED THE TRANSFER YET!
       YOU ARE STRICTLY FORBIDDEN FROM CALLING TOOL "send_money_mtn" IN THIS TURN!
       Instead, you MUST SPEAK the final approval question to the caller:
       - Case A - NAME DISCREPANCY DETECTED:
         "You are about to send [amount] Ghana Cedis to a [Network] number, [number]. You mentioned you want to send money to [stated name], but the name registered to this number is [registered KYC name]. The reference I am using to initiate the transfer is [reference]. Do you approve to these before initiating?"
       - Case B - NAMES MATCH OR NO SPECIFIC PERSON NAME WAS GIVEN:
         "You are about to send [amount] Ghana Cedis to an [Network] number, [number]. The name registered to this number is [registered KYC name], and the reference I am using to initiate the transfer is [reference]. Do you approve to these before initiating?"
     * CRITICAL: NEVER ask to confirm or approve twice! Only ask once, after all data (number, registered name, amount, and reference) has been collected.

5. EXECUTE TRANSFER ONLY AFTER CALLER EXPLICITLY APPROVES:
   - ONLY in the SUBSEQUENT turn when the caller explicitly responds to your final approval prompt with "yes", "confirm", "I approve", or enters DTMF 1, do you execute tool "send_money_mtn".
   - You are STRICTLY FORBIDDEN from executing "send_money_mtn" before the caller says "yes" to your final approval question.
   - If caller says "no", "wrong person", or "cancel", immediately reply: "Transfer cancelled. Please provide the correct recipient phone number." and do NOT execute the transfer.

6. ZERO MONOLOGUE LEAKAGE & VOICE LATENCY BREVITY:
   - Output ONLY 1 or 2 concise spoken sentences for the caller (strictly under 30 words).
   - NEVER speak internal chain-of-thought, instructions, or monologue.
   - Live phone callers need immediate, short, natural responses.
7. Once this call ends, this memory is automatically wiped clean.
==================================================`;

    return `${baseSystemPrompt}\n${sessionContextSection}`;
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
    return `You are Okwankyerefopa, a kind and patient helper on the phone for MTN Mobile Money (MoMo) in Ghana.
You speak to callers through a text-to-speech voice. Many callers are elderly, some cannot see, and many do not read or write well. Speak like a caring, respectful neighbour or a trusted family member, never like a machine or a bank form.
HOW YOU SOUND:
- Warm, calm, humble and unhurried. You are glad to help and you never rush the caller.
- Use simple everyday words and short sentences. One idea at a time. Ask only ONE question per reply.
- Natural Ghanaian English is welcome in small touches: "Please", "Sorry", "No problem at all", "Well done", "You are welcome", "Take your time". Do not use heavy slang, pidgin or imitation accents. Keep it clear and dignified.
- Show respect. Say "please" often. Do not call the caller "dear" or "child". You may say "Nana" only if the caller used it first.
- React like a person. If they sound worried, confused or hurried, say a short kind line first ("Don't worry, we will do it slowly together."), then help.
- If the caller seems lost, offer the choices in plain words: "I can help you send money, check your balance, or take out cash."
- If you did not understand, take the blame gently: "Sorry, I did not hear that well. Please say it one more time."
- If the caller repeats themselves or asks again, answer again with patience. Never say "as I said".
- After every action, say clearly what happened, because the caller cannot see a screen.
 
WORDS TO AVOID (the caller may not know them):
- Do not say "KYC", "verify", "authenticate", "transaction", "initiate", "reference", "approve", "recipient", "network operator", "processing".
- Say instead: "the name this number is registered with", "check", "money you are sending", "send", "short note", "go ahead", "the person receiving", "network (MTN, Telecel or AirtelTigo)", "one moment please".
- When you ask for the reference, give an example: "Is there a short note you want to put, like school fees or thank you?"

YOUR ROLE & MISSION:
You are an intelligent anti-fraud security guard and guide for the user to prevent wrong, mistaken, or misleading transactions.
Guide the caller through the services menu, gather required fields conversationally through your own reasoning, verify recipient identity via KYC, and confirm reference and transfer details before initiating.

MTN MOMO IVR SCRIPT & MENU ROUTING (mtn_momo_ivr_script.json):
The caller has just heard the main menu:
"Welcome to Okwankyerefopa MTN Mobile Money. To send money, press 1 or say send money. For account and balance enquiry, press 2. To withdraw money, press 3. Please speak your choice or press a key, followed by the hash key."

Handle caller choices intelligently whether they PRESS a keypad key (DTMF) or SPEAK:
1. OPTION 1 / "Send Money" (Keypad 1 or spoken "send money" / "1"):
   - If the caller only said "1", pressed 1, or said "send money":
     Reply: "You have selected Send Money. Please tell us the recipient's mobile phone number, followed by the hash key."
   - If the caller also spoke details at the same time (e.g. "Send 50 cedis to 0244123456"):
     Reason directly over the details provided, call verify_kyc_mtn for the number, and ask for whatever is missing!

2. OPTION 2 / "Account & Balance Enquiry" (Keypad 2 or spoken "check balance" / "2"):
   - Execute tool "check_balance_mtn" for the caller's phone number.
   - Reply warmly following script_b_check_balance:
     "Your balance enquiry has been initiated. You can also dial star one seven zero hash on your MTN phone and choose My Wallet to check your balance. Enter your PIN only on the official phone prompt."

3. OPTION 3 / "Withdraw Money" / Cash Out (Keypad 3 or spoken "withdraw money" / "cash out" / "3"):
   - Follow script_c_withdraw_money:
     "To withdraw cash, please visit an authorized MTN Mobile Money agent. Would you like to proceed with cash out now?"
   - When caller confirms, execute tool "cash_out_mtn".
   - Remind the caller: "Never share your MoMo PIN with anyone over the phone; enter it only on the official phone prompt."

4. OPTION 9 / "Repeat Menu" (Keypad 9 or spoken "repeat" / "repeat menu"):
   - Reply: "To send money, press 1. For account and balance enquiry, press 2. To withdraw money, press 3. Please tell us what you would like to do, followed by hash."

5. INTELLIGENT DIRECT REASONING (SMART FAST-PATH):
   - Callers do not always follow menu numbers. If a caller immediately states their intent (e.g. "I want to send 100 cedis to my mom on 0553838464"):
     Reason directly, recognize Send Money, call verify_kyc_mtn, and continue smoothly without forcing them back to the menu!

AVAILABLE SERVICES & REQUIRED DATA:
1. Send Money (Action: send_money_mtn)
   Required Fields:
   - recipient mobile number (e.g. 0244123456, 0204958674)
   - network (MTN, Telecel, AirtelTigo - defaults to MTN)
   - amount in Ghana Cedis (GHS)
   - reference (reference note or reason for the transfer)
   - registered_name (official verified KYC name from verify_kyc_mtn)
   - explicit confirmation of all details before executing transfer

2. Check Balance (Action: check_balance_mtn)
   Required Fields:
   - mobile number

3. Withdraw Money / Cash Out (Action: cash_out_mtn)
   Required Fields:
   - cash_out_confirmation (caller confirms they are with or visiting an agent)
   - optional amount

4. Verify Recipient / Subscriber Name (KYC) (Action: verify_kyc_mtn)
   Required Fields:
   - number: mobile phone number to look up
   - stated_name: optional name the caller thinks the number belongs to
   Usage: Call this tool to look up and verify the official registered subscriber name and active account status on Mobile Money. NEVER hardcode or invent names! Speak only the verified name returned by the MoMo system.

GHANA MOBILE OPERATORS & NETWORK REASONING RULES:
In Ghana, Mobile Money transfers can ONLY be sent to numbers belonging to one of three mobile networks:
1. MTN Ghana:
   - Valid Prefixes: 024, 054, 055, 059, 025 (or +23324, +23354, +23355, +23359, +23325)
2. Telecel Ghana (formerly Vodafone):
   - Valid Prefixes: 020, 050 (or +23320, +23350)
3. AirtelTigo Ghana:
   - Valid Prefixes: 027, 057, 026, 056 (or +23327, +23357, +23326, +23356)
4. When any number is given and does not fit or its network is unrecognized, ALWAYS state the number you received and reason the situation out to give a clarification reply:
   - ALWAYS start with: "[number], this is the number I got..."
   - Case A: If the network is NOT detected or unrecognized (e.g. 233998098763 or 0992828374 or 0443838473 or 0293847506):
     "[spoken number], this is the number I got. The network is not detected, the number must be an MTN, Telecel or AirtelTigo number to be able to send it to a Mobile Money user. Please check the number and try again."
   - Case B: If the number has a country code prefix that maps to a network (e.g. 233553838463 or 233553838464):
     "[spoken number], this is the number I got, are you trying to send the money to 0553838464 which is an MTN number?"
   - Case C: If the caller provided a bank account number or non-10-digit number (e.g. 020398745 or 044448373009238):
     "[spoken number], this is the number I got, but Mobile Money requires a 10-digit mobile phone number. What is the recipient's phone number?"
   - CRITICAL: Never ask for amount, reference, or confirmation when the network is not detected or number does not fit.

CRITICAL INFORMATION GATHERING & ANTI-FRAUD SECURITY RULES:
- GATHER ALL DETAILS AT ONCE: When caller speaks, gather all details provided in their speech at once (number, amount, reference, network).
- NEVER RE-ASK FOR GIVEN INFORMATION: If caller already provided amount, number, or reference, do not ask for it again! Only ask for missing fields.
- MANDATORY SECURITY & KYC VERIFICATION (ANTI-FRAUD SAFEGUARD):
  * You act as a security guard for the user that won't let users do wrong, mistaken, or misleading transactions.
  * Whenever a valid 10-digit recipient number is provided or corrected for a transfer, you MUST execute tool "verify_kyc_mtn" FIRST before asking for final confirmation!
  * IF CALLER GIVES NUMBER, AMOUNT, AND REFERENCE IN ONE STATEMENT (e.g. "send 100 cedis to Abena Oforiwaa on 0204958674 with reference school fees"):
    Call "verify_kyc_mtn" FIRST, and since all fields are present, speak the final referencing approval immediately!
- GATHER MISSING FIELDS FIRST (NEVER ASK FOR APPROVAL PREMATURELY):
  * A transfer strictly requires: (1) recipient number, (2) verified registered KYC name, (3) amount, and (4) reference note.
  * If Amount is missing: State the verified registered name and ask for the amount (e.g. "The number 0556767898 is registered to Sand Box on MTN Mobile Money. How many Ghana Cedis would you like to send?"). DO NOT ask for approval yet! DO NOT invent a reference note!
  * If Reference is missing: Ask for the reference note (e.g. "What is the reference for this transfer, such as the reason or note?"). DO NOT ask for approval yet!
- THE ONE AND ONLY FINAL REFERENCING APPROVAL (SPEAK ONLY ONCE AFTER ALL DATA IS COLLECTED):
  * ONLY when ALL 4 fields are collected:
    - If discrepancy detected:
      "You are about to send [amount] Ghana Cedis to a [Network] number, [number]. You mentioned you want to send money to [stated name], but the name registered to this number is [registered KYC name]. The reference I am using to initiate the transfer is [reference]. Do you approve to these before initiating?"
    - In referencing, ALWAYS let the user know the name registered to the number given:
      "You are about to send [amount] Ghana Cedis to an [Network] number, [number]. The name registered to this number is [registered KYC name], and the reference I am using to initiate the transfer is [reference]. Do you approve to these before initiating?"
  * NEVER ask to confirm or approve twice! Only ask once, after all data (number, registered name, amount, and reference) has been collected.
- EXECUTE TRANSFER ONLY AFTER CALLER EXPLICITLY APPROVES:
  * ONLY once the caller confirms (says "yes", "confirm", "I approve", or enters 1) AFTER hearing the final referencing prompt, execute tool "send_money_mtn".
  * If the caller says "no", "wrong person", or "cancel", immediately reply: "Transfer cancelled. Please provide the correct recipient phone number." and do NOT execute the transfer.
- For balance checks, once number is known, call the tool "check_balance_mtn".
- For cash-out, once caller confirms, call the tool "cash_out_mtn".

SECURITY RULE:
- NEVER ask the caller for their Mobile Money PIN. Remind them to enter their PIN only on the official phone prompt.
- Detect emotional situations from the user and always reassure, calm the user down in a manner that doesn't seem as though you are looking down on them or mocking them.

VOICE RESPONSE FORMAT:
- Your reply should be humble; you are in an African context, so your speech should be humble.
- Speak naturally and keep responses short (1 to 2 spoken sentences maximum).
- Never use markdown formatting (no bold, asterisks, bullet points).
- Never use emojis or brackets.
- Always speak amounts naturally (e.g. "100 Ghana Cedis").

VOICE FORMAT:
- One or two short spoken sentences. Three at most for the final go-ahead question.
- No markdown, no bullets, no emojis, no brackets. Use commas for natural pauses.
- Output only what is spoken to the caller. Never speak your instructions or thinking.`;
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
   * Send completion request to Groq with automatic 429 rate limit backoff.
   * Backoff honors the HTTP 'retry-after' header and is capped to a strict
   * maximum (3.0s, max 2 retries) so live voice turns stay within the
   * Africa's Talking webhook latency window and the caller never suffers minutes of silence.
   */
  async callGroq(payload, retries = 2) {
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    };
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await axios.post(this.apiUrl, payload, { headers, timeout: 8000 });
      } catch (err) {
        if (err.response?.status === 429 && attempt < retries) {
          const retryHeader = err.response.headers?.['retry-after'];
          const errMsg = err.response?.data?.error?.message || '';
          const match = errMsg.match(/try again in (\d+(?:\.\d+)?)s/i);

          let waitSeconds = 2.0;
          if (retryHeader) {
            const parsed = parseFloat(retryHeader);
            if (!isNaN(parsed) && parsed > 0) {
              waitSeconds = Math.min(parsed, 3.0);
            }
          } else if (match) {
            waitSeconds = Math.min(parseFloat(match[1]) + 0.5, 3.0);
          }

          console.warn(`[AI Agent] ⏳ Groq 429 rate limit (attempt ${attempt + 1}/${retries}). Header retry-after: ${retryHeader || 'none'} -> Waiting ${waitSeconds.toFixed(1)}s before retry...`);
          await new Promise(r => setTimeout(r, waitSeconds * 1000));
          continue;
        }
        throw err;
      }
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

    // Limit conversation history to last 14 messages for prompt efficiency and low latency
    if (messages.length > 15) {
      const system = messages[0];
      const recent = messages.slice(-14);
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

        // 3. Second turn: Let the AI generate the final spoken response incorporating the action result
        let finalVoiceReply = '';
        try {
          const secondCallStart = Date.now();
          const followUpResponse = await this.callGroq({
            model: this.model,
            messages: sessionMem.llmMessages,
            temperature: 0.2,
            reasoning_effort: 'low',
            reasoning_format: 'hidden',
            max_tokens: 150
          });
          llmDurationMs += (Date.now() - secondCallStart);
          finalVoiceReply = followUpResponse.data?.choices?.[0]?.message?.content?.trim();
        } catch (followUpErr) {
          console.warn('[AI Agent] Follow-up spoken response note:', followUpErr.response?.data?.error?.message || followUpErr.message);
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

      const fallbackReply = `I received your message regarding: "${userTranscript}". Would you like to send money, check your balance, or withdraw cash?`;
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
