'use strict';

/**
 * Smoke test — boots the real server on an ephemeral port and verifies the
 * critical paths fixed in this codebase:
 *   1. Health & dashboard endpoints respond
 *   2. MoMo service exposes the previously-missing methods
 *   3. Paid endpoints reject unauthenticated requests (401)
 *   4. Voice webhook turn-0 returns well-formed greeting XML
 *   5. Custom ASR provider fails loudly instead of returning a placeholder
 *   6. Ended sessions leave the active-session map (memory-leak fix)
 *
 * No external network calls are made: Groq/AT/MoMo credentials are not
 * exercised by any assertion below.
 */

const { spawn } = require('child_process');
const path = require('path');

const PORT = 3457;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_API_KEY = 'smoke-test-dashboard-key';

let failures = 0;
function check(name, condition, extra = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error('Server did not start in time');
}

async function postForm(url, fields) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString()
  });
}

(async () => {
  console.log('\n[smoke] Booting server on port', PORT, '...');
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DASHBOARD_API_KEY: TEST_API_KEY },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });

  try {
    await waitForServer();

    console.log('\n[1] Health & dashboard endpoints');
    const health = await fetch(`${BASE}/health`);
    check('GET /health returns 200', health.status === 200, `got ${health.status}`);
    const dashboard = await fetch(`${BASE}/api/dashboard`);
    const dashboardBody = await dashboard.json();
    check('GET /api/dashboard returns success payload', dashboard.status === 200 && dashboardBody.success === true);

    console.log('\n[2] MoMo service exposes previously-missing methods');
    const momo = require('../momo-api');
    for (const m of ['getTransferStatus', 'getRequestToPayStatus', 'createSandboxApiUser', 'createSandboxApiKey']) {
      check(`momoService.${m}() exists`, typeof momo[m] === 'function');
    }

    console.log('\n[3] Auth guard on paid endpoints (no key → 401)');
    const noKeyCall = await fetch(`${BASE}/api/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: '+254700000000' })
    });
    check('POST /api/call without key → 401', noKeyCall.status === 401, `got ${noKeyCall.status}`);
    const noKeyTransfer = await fetch(`${BASE}/api/call-transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'x', phoneNumber: '+254700000000' })
    });
    check('POST /api/call-transfer without key → 401', noKeyTransfer.status === 401, `got ${noKeyTransfer.status}`);
    const noKeySend = await fetch(`${BASE}/api/services/mtn/send-money`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: '0244123456', amount: 1 })
    });
    check('POST /api/services/mtn/send-money without key → 401', noKeySend.status === 401, `got ${noKeySend.status}`);
    const noKeyCashOut = await fetch(`${BASE}/api/services/mtn/cash-out`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: '0244123456', amount: 1 })
    });
    check('POST /api/services/mtn/cash-out without key → 401', noKeyCashOut.status === 401, `got ${noKeyCashOut.status}`);

    const badCall = await fetch(`${BASE}/api/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
      body: JSON.stringify({})
    });
    check('POST /api/call with key but missing "to" → 400', badCall.status === 400, `got ${badCall.status}`);

    console.log('\n[4] Voice webhook turn-0 greeting XML');
    const sessionId = `smoke-${Date.now()}`;
    const webhookRes = await postForm(`${BASE}/voice/callback`, {
      sessionId,
      isActive: '1',
      direction: 'Inbound',
      callerNumber: '+254711082000',
      destinationNumber: '+254711082000'
    });
    const xml = await webhookRes.text();
    check('POST /voice/callback returns 200', webhookRes.status === 200, `got ${webhookRes.status}`);
    check('XML content-type returned', (webhookRes.headers.get('content-type') || '').includes('xml'));
    check('Greeting XML is a well-formed Response document', /^<Response>[\s\S]*<\/Response>$/.test(xml.trim()));
    check('Greeting XML contains <Record> listening tag', xml.includes('<Record'));
    check('Greeting speaks the MTN menu prompt', xml.includes('Okwankyerefopa'));

    console.log('\n[5] Custom ASR provider fails loudly (no silent placeholder)');
    const transcription = require('../transcription');
    let customThrew = false;
    try { await transcription.transcribeWithCustomProvider(Buffer.alloc(0)); } catch (e) { customThrew = true; }
    check('transcribeWithCustomProvider() throws an explicit error', customThrew);

    console.log('\n[6] Session cleanup: ended calls leave the active sessions map');
    await postForm(`${BASE}/voice/callback`, { sessionId, isActive: '0' });
    const dash2 = await (await fetch(`${BASE}/api/dashboard`)).json();
    check('Completed session removed from activeSessions',
      !dash2.data.dashboard.activeSessions.some(s => s.sessionId === sessionId));
    check('Completed session preserved in recentHistory',
      dash2.data.dashboard.recentHistory.some(s => s.sessionId === sessionId));
  } catch (err) {
    failures++;
    console.error('\n[smoke] Unexpected failure:', err);
    console.error(serverLog);
  } finally {
    server.kill();
  }

  console.log(failures === 0 ? '\n✅ All smoke tests passed' : `\n❌ ${failures} smoke test(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
