#!/usr/bin/env node
'use strict';

/**
 * Real-Time Call Test & Diagnostic Report Script
 * Simulates an incoming call turn to test the live voice pipeline,
 * verifies dual Groq key routing (GROQ_TTS_KEY vs GROQ_LLM_KEY),
 * and prints a complete real-time performance latency report.
 * 
 * Usage:
 *   node scripts/test-call.js
 *   node scripts/test-call.js "I want to send 20 cedis to 0244123456"
 */

require('dotenv').config();
const http = require('http');

const PORT = process.env.PORT || 3000;
const BASE = process.env.TEST_BASE_URL || `http://127.0.0.1:${PORT}`;
const userSpeech = process.argv[2] || 'I want to check my account balance';

console.log(`\n======================================================`);
console.log(`📞 [REAL-TIME CALL TEST RUNNER]`);
console.log(`Target Server: ${BASE}`);
console.log(`Simulated In : "${userSpeech}"`);
console.log(`======================================================\n`);

async function runTestCall() {
  const sessionId = `test-${Date.now()}`;
  const callerNumber = process.env.AT_PHONE_NUMBER || '+233553838464';

  let spawnedServer = null;
  try {
    await fetch(`${BASE}/health`);
  } catch (e) {
    console.log(`ℹ️ Server not running on ${BASE}. Booting local server for test...`);
    const { spawn } = require('child_process');
    const path = require('path');
    spawnedServer = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    for (let i = 0; i < 30; i++) {
      try {
        const check = await fetch(`${BASE}/health`);
        if (check.ok) {
          console.log(`✅ Local test server ready on ${BASE}\n`);
          break;
        }
      } catch (err) {}
      await new Promise(r => setTimeout(r, 300));
    }
  }

  try {
    console.log(`[Step 1] Initiating Call Webhook Turn 0 (Greeting & Menu)...`);
  const t0 = Date.now();
  const resGreeting = await fetch(`${BASE}/voice/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      sessionId,
      isActive: '1',
      direction: 'Inbound',
      callerNumber,
      destinationNumber: '+233308048097'
    }).toString()
  });

  const xmlGreeting = await resGreeting.text();
  console.log(`✅ Turn 0 Response (${Date.now() - t0}ms) HTTP ${resGreeting.status}`);
  console.log(`   XML: ${xmlGreeting.trim().replace(/\n/g, ' ')}\n`);

  console.log(`[Step 2] Sending Spoken Caller Audio Turn 1 ("${userSpeech}")...`);
  const t1 = Date.now();
  const resTurn1 = await fetch(`${BASE}/voice/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      sessionId,
      isActive: '1',
      direction: 'Inbound',
      callerNumber,
      destinationNumber: '+233308048097',
      simulatedSpeech: userSpeech
    }).toString()
  });

  const xmlTurn1 = await resTurn1.text();
  const turn1Duration = Date.now() - t1;
  console.log(`✅ Turn 1 Response (${turn1Duration}ms) HTTP ${resTurn1.status}`);

  // Fetch real-time diagnostic report
  console.log(`\n[Step 3] Fetching Real-Time Call Diagnostic Report from Server...`);
  const reportRes = await fetch(`${BASE}/api/call-report/${sessionId}`);
  if (reportRes.ok) {
    const { report } = await reportRes.json();
    console.log(`\n======================================================`);
    console.log(`📊 [REAL-TIME CALL REPORT] Session: ${report.sessionId}`);
    console.log(`------------------------------------------------------`);
    console.log(`Caller Number      : ${report.callerNumber}`);
    console.log(`Status             : ${report.status}`);
    console.log(`Total Turns        : ${report.turnsCount}`);
    console.log(`Average Latency    : ${report.averageTurnLatencyMs} ms ${report.targetSubTwoSeconds ? '✅ [SUB-2S TARGET MET]' : '⚠️ [OVER BUDGET]'}`);
    console.log(`Speech/ASR Key     : ${report.groqKeys?.audioWhisperKey || 'N/A'}`);
    console.log(`LLM Reasoning Key  : ${report.groqKeys?.llmReasoningKey || 'N/A'}`);
    console.log(`------------------------------------------------------`);
    console.log(`Turn Breakdown:`);
    (report.latencies || []).forEach((l, i) => {
      console.log(`  Turn ${l.turnIndex || i + 1}: Total ${l.totalTurnMs}ms (Download: ${l.downloadMs}ms, STT: ${l.sttMs}ms, LLM: ${l.llmMs}ms, Action: ${l.toolMs}ms)`);
    });
    console.log(`------------------------------------------------------`);
    console.log(`Spoken AI Reply:`);
    const lastTurn = report.conversation?.[report.conversation.length - 1];
    console.log(`  "${lastTurn?.aiResponse || 'No response recorded'}"`);
    console.log(`======================================================\n`);
  } else {
    console.log(`Could not fetch report JSON (status: ${reportRes.status})`);
  }

  // End session
  await fetch(`${BASE}/voice/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ sessionId, isActive: '0' }).toString()
  });
  console.log(`[Step 4] Session ended and cleaned up.`);
  } finally {
    if (spawnedServer) {
      spawnedServer.kill();
    }
  }
}

runTestCall().catch(err => {
  console.error(`\n❌ Error running test call:`, err.message);
  console.log(`Ensure the server is running on ${BASE} ('node server.js' or 'npm run dev').`);
});
