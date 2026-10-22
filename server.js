require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { WebSocketServer, WebSocket } = require('ws');
const ivrEngine = require('./ivr-engine');
const atService = require('./africastalking-api');
const aiAgent = require('./ai-agent');
const transcriptionService = require('./transcription');
const momoService = require('./momo-api');
const hciLabService = require('./hci-lab-service');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Africa's Talking expects a fast XML response. If an AI turn (e.g. a Groq
// rate-limit retry) exceeds this budget, we answer with a keep-alive XML so
// the call does not time out / hang up in production.
const VOICE_WEBHOOK_TIMEOUT_MS = parseInt(process.env.VOICE_WEBHOOK_TIMEOUT_MS || '11000', 10);

// Enable trust proxy for Render reverse proxy headers (X-Forwarded-Proto, etc.)
app.set('trust proxy', 1);

// Middleware
app.use(cors());
// Africa's Talking sends POST callbacks as application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint for Render zero-downtime health monitoring
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    service: 'Okwankyerefopa MoMo Voice AI',
    timestamp: new Date().toISOString()
  });
});

// Store connected WebSocket clients
const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);

  // Send initial state upon connection
  ws.send(JSON.stringify({
    type: 'INITIAL_STATE',
    data: {
      config: atService.getConfigSummary(),
      dashboard: ivrEngine.getDashboardData(),
      publicCallbackUrl: process.env.PUBLIC_CALLBACK_URL || `http://localhost:${PORT}/voice/callback`,
      aiConfig: aiAgent.getConfigSummary(),
      asrConfig: transcriptionService.getConfigSummary(),
      servicesMemory: aiAgent.getServicesMemory(),
      momoConfig: momoService.getConfigSummary(),
      hciLabQuota: hciLabService.getQuotaStatus()
    }
  }));

  ws.on('close', () => {
    clients.delete(ws);
  });
});

/**
 * Broadcast event to all connected simulator UI clients
 */
function broadcast(type, payload) {
  const message = JSON.stringify({ type, data: payload, timestamp: new Date().toISOString() });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// Automatically broadcast hot-reloaded memory changes to all connected UI clients
aiAgent.onMemoryChange = (newMemory) => {
  broadcast('SERVICES_MEMORY_UPDATED', newMemory);
};

// Automatically broadcast agentic action executions to all connected UI clients
aiAgent.onActionExecuted = (actionData) => {
  broadcast('AGENTIC_ACTION_TRIGGERED', actionData);
};

// Automatically broadcast session memory discard when a call ends
aiAgent.onMemoryDiscarded = (sessionId, summary) => {
  broadcast('SESSION_MEMORY_DISCARDED', { sessionId, summary });
};

// ==========================================
// AUTH GUARD FOR PAID / SENSITIVE ENDPOINTS
// ==========================================

/**
 * Protects endpoints that trigger billable Africa's Talking calls or move money.
 * - If DASHBOARD_API_KEY is set, clients must send it as the `x-api-key` header.
 * - If it is NOT set, only loopback (localhost) clients are allowed, so a public
 *   deployment cannot be abused to make paid calls on your account.
 */
function requireApiKey(req, res, next) {
  const expectedKey = process.env.DASHBOARD_API_KEY || '';
  const providedKey = req.get('x-api-key') || (req.query && req.query.apiKey) || '';

  if (expectedKey) {
    if (providedKey && providedKey === expectedKey) return next();
    return res.status(401).json({ success: false, error: 'Unauthorized. Provide a valid x-api-key header.' });
  }

  const ip = req.ip || '';
  const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (isLoopback) return next();
  return res.status(401).json({
    success: false,
    error: 'Unauthorized. Set DASHBOARD_API_KEY on the server and pass it as the x-api-key header.'
  });
}

// ==========================================
// AFRICA'S TALKING WEBHOOK CALLBACK ENDPOINT
// ==========================================
async function handleVoiceCallback(req, res) {
  const startTime = Date.now();
  const payload = req.body || {};

  console.log(`\n======================================================`);
  console.log(`[AT VOICE CALLBACK] ${new Date().toISOString()}`);
  console.log(`Session ID   : ${payload.sessionId}`);
  console.log(`Is Active    : ${payload.isActive}`);
  console.log(`Direction    : ${payload.direction}`);
  console.log(`Caller       : ${payload.callerNumber}`);
  console.log(`Destination  : ${payload.destinationNumber}`);
  console.log(`DTMF Digits  : ${payload.dtmfDigits || '(none)'}`);
  console.log(`Recording URL: ${payload.recordingUrl || '(none)'}`);
  console.log(`======================================================\n`);

  // Notify frontend UI about incoming AT webhook event
  broadcast('AT_WEBHOOK_EVENT', {
    headers: req.headers,
    payload,
    method: req.method,
    url: req.originalUrl
  });

  let responded = false;

  // Latency guard: respond with a keep-alive XML before AT times the webhook out
  const latencyTimer = setTimeout(() => {
    if (responded) return;
    responded = true;
    console.warn(`[AT VOICE CALLBACK] ⚠️ AI turn exceeded ${VOICE_WEBHOOK_TIMEOUT_MS}ms — sending keep-alive XML to prevent call timeout.`);

    const keepAliveCallback = process.env.PUBLIC_CALLBACK_URL || '';
    const keepAliveCallbackAttr = keepAliveCallback ? ` callbackUrl="${keepAliveCallback}"` : '';
    const keepAliveXml = `<Response>
  <Say voice="en-US-Standard-C">Sorry, that is taking a little longer than expected. Please repeat your request after the beep.</Say>
  <Record finishOnKey="#" maxLength="12" timeout="5" trimSilence="true" playBeep="true"${keepAliveCallbackAttr}>
    <Say voice="en-US-Standard-C">Please speak now.</Say>
  </Record>
</Response>`;

    res.set('Content-Type', 'application/xml; charset=utf-8');
    return res.status(200).send(keepAliveXml);
  }, VOICE_WEBHOOK_TIMEOUT_MS);

  try {
    // Process event through IVR Engine with AI Agent loop
    const { session, xml, actionSummary, transcript, aiReply, actionExecuted, latencyBreakdown } = await ivrEngine.processEvent(
      payload,
      (sessionId, pendingPayload) => {
        broadcast('OPERATOR_PROMPT_REQUIRED', {
          sessionId,
          payload: pendingPayload,
          timeoutSeconds: 8
        });
      },
      (sessionId, aiProgress) => {
        broadcast('AI_PROGRESS_UPDATE', {
          sessionId,
          ...aiProgress
        });
      }
    );

    if (responded) {
      // Africa's Talking already received the keep-alive response; nothing more we can send
      console.warn(`[AT VOICE CALLBACK] Late AI result for ${payload.sessionId} discarded (client already responded to).`);
      return;
    }
    responded = true;
    clearTimeout(latencyTimer);

    const executionTimeMs = Date.now() - startTime;

    // Broadcast our outgoing XML response, latency profiler breakdown, and AI transcript to simulator
    broadcast('AT_XML_RESPONSE', {
      sessionId: session.sessionId,
      xml,
      actionSummary,
      transcript,
      aiReply,
      actionExecuted,
      executionTimeMs,
      latencyBreakdown,
      session
    });

    // Set XML header required by Africa's Talking
    res.set('Content-Type', 'application/xml; charset=utf-8');
    return res.status(200).send(xml);
  } catch (err) {
    if (responded) {
      console.error('[AT VOICE CALLBACK ERROR] (after keep-alive was already sent):', err);
      return;
    }
    responded = true;
    clearTimeout(latencyTimer);
    console.error('[AT VOICE CALLBACK ERROR]:', err);
    const fallbackXml = `<Response><Say>An internal error occurred. Please try again later.</Say></Response>`;
    res.set('Content-Type', 'application/xml; charset=utf-8');
    return res.status(200).send(fallbackXml);
  }
}

// Support standard paths configured in AT Voice Dashboard and custom URL aliases
const voiceEndpoints = [
  '/voice/callback',
  '/voice/events',
  '/call/callback',
  '/callbackurl',
  '/eventsurl',
  '/callback',
  '/events'
];
voiceEndpoints.forEach((route) => {
  app.post(route, handleVoiceCallback);
  app.get(route, (req, res) => {
    res.send(`Africa's Talking Voice Webhook [${route}] is active and ready to receive POST callbacks.`);
  });
});

// ==========================================
// REST APIS FOR SIMULATOR DASHBOARD & ACTIONS
// ==========================================

// Get Dashboard Data
app.get('/api/dashboard', (req, res) => {
  res.json({
    success: true,
    data: {
      config: atService.getConfigSummary(),
      dashboard: ivrEngine.getDashboardData(),
      publicCallbackUrl: process.env.PUBLIC_CALLBACK_URL || `http://localhost:${PORT}/voice/callback`,
      aiConfig: aiAgent.getConfigSummary(),
      asrConfig: transcriptionService.getConfigSummary(),
      servicesMemory: aiAgent.getServicesMemory(),
      momoConfig: momoService.getConfigSummary()
    }
  });
});

// Get Integrated Services Memory
app.get('/api/services', (req, res) => {
  res.json({
    success: true,
    data: aiAgent.getServicesMemory()
  });
});

// Get Voice Latency & Streaming Investigation Report (JSON or Download)
app.get('/api/investigation-report', (req, res) => {
  const reportPath = path.join(__dirname, 'VOICE_LATENCY_AND_STREAMING_INVESTIGATION.md');
  if (fs.existsSync(reportPath)) {
    const content = fs.readFileSync(reportPath, 'utf8');
    return res.json({ success: true, filename: 'VOICE_LATENCY_AND_STREAMING_INVESTIGATION.md', content });
  }
  return res.status(404).json({ success: false, error: 'Investigation report file not found.' });
});

app.get('/api/investigation-report/download', (req, res) => {
  const reportPath = path.join(__dirname, 'VOICE_LATENCY_AND_STREAMING_INVESTIGATION.md');
  if (fs.existsSync(reportPath)) {
    res.setHeader('Content-Disposition', 'attachment; filename="VOICE_LATENCY_AND_STREAMING_INVESTIGATION.md"');
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    return res.sendFile(reportPath);
  }
  return res.status(404).send('Investigation report file not found.');
});

// Real-Time Live Call Testing Diagnostic Report (latest or by sessionId)
app.get('/api/call-report/latest', (req, res) => {
  const report = ivrEngine.getLatestCallReport();
  if (report) {
    return res.json({ success: true, report });
  }
  return res.json({
    success: true,
    message: 'No calls recorded yet. Place a call to see real-time diagnostics.',
    report: null
  });
});

app.get('/api/call-report/:sessionId', (req, res) => {
  const report = ivrEngine.getCallReport(req.params.sessionId);
  if (report) {
    return res.json({ success: true, report });
  }
  return res.status(404).json({ success: false, error: 'Session report not found.' });
});

// University of Ghana HCI Lab Speech API Quota & Circuit Breaker Status
app.get('/api/hci-lab/quota', (req, res) => {
  res.json({
    success: true,
    quota: hciLabService.getQuotaStatus(),
    targetPresentationDate: '2026-10-24'
  });
});

// Update Services Memory
app.post('/api/services', (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const memoryFilePath = path.join(__dirname, 'services-memory.json');
    fs.writeFileSync(memoryFilePath, JSON.stringify(req.body, null, 2), 'utf8');
    aiAgent.reloadConfig();
    broadcast('SERVICES_MEMORY_UPDATED', aiAgent.getServicesMemory());
    res.json({ success: true, message: 'Services memory updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update Engine Mode & Settings
app.post('/api/settings', (req, res) => {
  const { mode, customXml } = req.body;
  ivrEngine.setMode(mode, customXml);
  broadcast('SETTINGS_UPDATED', ivrEngine.getDashboardData());
  res.json({ success: true, mode: ivrEngine.mode });
});

// Operator manual XML response dispatch
app.post('/api/operator-action', (req, res) => {
  const { sessionId, xml } = req.body;
  if (!sessionId || !xml) {
    return res.status(400).json({ success: false, error: 'sessionId and xml are required' });
  }

  const handled = ivrEngine.resolveOperatorResponse(sessionId, xml);
  res.json({ success: handled, message: handled ? 'Dispatched to Africa\'s Talking callback' : 'No pending callback found or timed out' });
});

// Trigger Outbound Call via Africa's Talking API
app.post('/api/call', requireApiKey, async (req, res) => {
  const { to, from, clientRequestId, callActions } = req.body;

  if (!to) {
    return res.status(400).json({ success: false, error: 'Recipient phone number (to) is required.' });
  }

  try {
    const result = await atService.makeCall({ to, from, clientRequestId, callActions });
    broadcast('OUTBOUND_CALL_TRIGGERED', { result, to, from });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Trigger Call Transfer via Africa's Talking API
app.post('/api/call-transfer', requireApiKey, async (req, res) => {
  const { sessionId, phoneNumber, callLeg, holdMusicUrl } = req.body;

  if (!sessionId || !phoneNumber) {
    return res.status(400).json({ success: false, error: 'sessionId and phoneNumber are required' });
  }

  try {
    const result = await atService.transferCall({ sessionId, phoneNumber, callLeg, holdMusicUrl });
    broadcast('CALL_TRANSFER_TRIGGERED', { result, sessionId, phoneNumber });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// MTN MOBILE MONEY (MOMO) API ENDPOINTS
// ==========================================

// Get MoMo Configuration Summary
app.get('/api/services/mtn/config', (req, res) => {
  res.json({
    success: true,
    data: momoService.getConfigSummary()
  });
});

// MoMo Send Money / Transfer (Disbursement)
app.post('/api/services/mtn/send-money', requireApiKey, async (req, res) => {
  const { number, amount, reference, currency, network } = req.body;
  if (!number || !amount) {
    return res.status(400).json({ success: false, error: 'Recipient number and amount are required' });
  }

  try {
    const result = await momoService.sendMoney({
      number,
      amount,
      reference,
      currency
    });
    broadcast('MOMO_TRANSACTION_EXECUTED', { action: 'send_money', result });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// MoMo KYC / Basic User Info Lookup
app.post('/api/services/mtn/kyc', async (req, res) => {
  const { number, phoneNumber, product = 'collection' } = req.body;
  const targetNumber = number || phoneNumber || '0244123456';

  try {
    const result = await momoService.getBasicUserInfo(targetNumber, product);
    broadcast('MOMO_TRANSACTION_EXECUTED', { action: 'verify_kyc', result });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// MoMo Check Balance (Disbursement or Collection)
app.get('/api/services/mtn/check-balance', async (req, res) => {
  try {
    const product = req.query.product || 'disbursement';
    const result = await momoService.checkBalance(product);
    broadcast('MOMO_TRANSACTION_EXECUTED', { action: 'check_balance', result });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/services/mtn/check-balance', async (req, res) => {
  try {
    const product = req.body.product || 'disbursement';
    const result = await momoService.checkBalance(product);
    broadcast('MOMO_TRANSACTION_EXECUTED', { action: 'check_balance', result });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// MoMo Cash Out / Withdrawal (RequestToPay)
app.post('/api/services/mtn/cash-out', requireApiKey, async (req, res) => {
  const { number, amount, note, cash_out_confirmation } = req.body;
  try {
    const result = await momoService.withdrawCash({
      number,
      amount,
      note: note || 'Cash Out Withdrawal'
    });
    broadcast('MOMO_TRANSACTION_EXECUTED', { action: 'cash_out', result });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Check MoMo Transaction Status
app.get('/api/services/mtn/status/:referenceId', async (req, res) => {
  const { referenceId } = req.params;
  const type = req.query.type || 'transfer';
  try {
    const result = type === 'requesttopay'
      ? await momoService.getRequestToPayStatus(referenceId)
      : await momoService.getTransferStatus(referenceId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Provision Sandbox API User & Key
app.post('/api/services/mtn/provision-sandbox', async (req, res) => {
  const { subscriptionKey } = req.body;
  try {
    const userRes = await momoService.createSandboxApiUser(null, subscriptionKey);
    if (!userRes.success) {
      return res.status(userRes.status || 500).json(userRes);
    }
    const keyRes = await momoService.createSandboxApiKey(userRes.referenceId, subscriptionKey);
    res.json({
      success: true,
      apiUserId: userRes.referenceId,
      apiKey: keyRes.apiKey,
      message: 'Sandbox user and API Key provisioned. Add these to your .env to enable real sandbox calls.'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Local / Synthetic Event Simulator (Supports testing voice input to Groq AI)
app.post('/api/simulate-webhook', async (req, res) => {
  const {
    sessionId = `sim-session-${Date.now()}`,
    isActive = '1',
    direction = 'Inbound',
    callerNumber = '+254712345678',
    destinationNumber = process.env.AT_PHONE_NUMBER || '+254711082000',
    dtmfDigits = '',
    recordingUrl = '',
    simulatedSpeech = '',
    durationInSeconds = 0,
    amount = '0.00',
    currencyCode = 'KES'
  } = req.body;

  const simulatedPayload = {
    sessionId,
    isActive: String(isActive),
    direction,
    callerNumber,
    destinationNumber,
    dtmfDigits: String(dtmfDigits),
    recordingUrl,
    simulatedSpeech,
    durationInSeconds: Number(durationInSeconds),
    amount,
    currencyCode
  };

  // Broadcast synthetic event
  broadcast('AT_WEBHOOK_EVENT', {
    headers: { 'user-agent': 'AT-Simulator-Local/1.0', host: `localhost:${PORT}` },
    payload: simulatedPayload,
    isSimulated: true
  });

  try {
    const { session, xml, actionSummary, transcript, aiReply, actionExecuted } = await ivrEngine.processEvent(
      simulatedPayload,
      null,
      (sid, progress) => {
        broadcast('AI_PROGRESS_UPDATE', { sessionId: sid, ...progress, isSimulated: true });
      }
    );

    broadcast('AT_XML_RESPONSE', {
      sessionId: session.sessionId,
      xml,
      actionSummary,
      transcript,
      aiReply,
      actionExecuted,
      executionTimeMs: 45,
      session,
      isSimulated: true
    });

    return res.json({
      success: true,
      sessionId: session.sessionId,
      transcript,
      aiReply,
      actionExecuted,
      xml,
      actionSummary,
      session
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Test Groq AI response directly with a prompt
app.post('/api/test-ai', async (req, res) => {
  const promptText = req.body.prompt || req.body.callerSpeech;
  const sessionId = req.body.sessionId || `test-ai-${Date.now()}`;
  if (!promptText) return res.status(400).json({ success: false, error: 'Prompt or callerSpeech is required' });

  try {
    const callContext = {
      callerNumber: req.body.callerNumber || '+233244123456',
      destinationNumber: req.body.destinationNumber || '+254711082000',
      direction: req.body.direction || 'Inbound',
      dtmfDigits: req.body.dtmfDigits
    };
    const agentResult = await aiAgent.generateVoiceReply(sessionId, promptText, callContext);
    const reply = typeof agentResult === 'object' && agentResult.reply ? agentResult.reply : agentResult;
    const actionExecuted = typeof agentResult === 'object' ? agentResult.actionExecuted : null;
    const sessionMemory = aiAgent.getSessionMemorySummary(sessionId);
    res.json({ success: true, prompt: promptText, reply, actionExecuted, sessionMemory, model: aiAgent.model });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Inspect active call session memory
app.get('/api/session-memory/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const memory = aiAgent.getSessionMemorySummary(sessionId);
  if (!memory) {
    return res.status(404).json({ success: false, error: 'Session memory not found or already discarded' });
  }
  res.json({ success: true, memory });
});

// Manually end a session
app.post('/api/end-session', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId required' });

  const ended = ivrEngine.endSession(sessionId);
  aiAgent.discardSessionMemory(sessionId);
  broadcast('SESSION_ENDED', { sessionId });
  res.json({ success: ended });
});

// Start Server
const HOST = '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`\n======================================================`);
  console.log(`Africa's Talking Phone Simulator running!`);
  console.log(` Port: ${PORT} | Host: ${HOST}`);
  console.log(`Africa's Talking Webhook: /voice/callback`);
  console.log(`AI Engine: Groq (${aiAgent.model})`);
  console.log(` ASR Provider: ${transcriptionService.provider}`);
  console.log(` Current Mode: ${ivrEngine.mode}`);
  console.log(`======================================================\n`);
});
