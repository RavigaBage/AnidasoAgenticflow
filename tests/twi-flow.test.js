process.env.NODE_ENV = 'test';
require('dotenv').config();
const ivrEngine = require('../ivr-engine');
const transcription = require('../transcription');
const hciLab = require('../hci-lab-service');

async function testTwiFlow() {
  console.log('🧪 [TEST] Starting Twi Language Flow & UG HCI Lab ASR tests...\n');

  // Test 1: Configuration check
  console.log('[1] Checking UG HCI Lab ASR configuration...');
  const cfg = transcription.getConfigSummary();
  if (!cfg.ugHciLabConfigured) {
    throw new Error('FAIL: UG_HCI_LAB_API_KEY is not configured in transcription service');
  }
  console.log('  PASS  UG HCI Lab is configured');

  // Test 2: Turn 0 greeting offers Twi (Option 2)
  console.log('\n[2] Testing Turn 0 welcome greeting...');
  const session1 = {
    sessionId: 'test-twi-turn0-' + Date.now(),
    step: 0,
    language: 'en',
    callerNumber: '+233553838464',
    destinationNumber: '+233308048097',
    direction: 'Inbound',
    dtmfHistory: [],
    conversation: [],
    events: []
  };
  const t0Result = await ivrEngine.handleAiAgentTurn(session1, null, null, null);
  if (!t0Result.xml.includes('Twi, press 2')) {
    throw new Error('FAIL: Turn 0 greeting does not offer Twi (Option 2)');
  }
  console.log('  PASS  Turn 0 offers Twi option');

  // Test 3: Pressing 2 switches to Twi and returns Twi greeting
  console.log('\n[3] Testing Option 2 (DTMF) language switch to Twi...');
  const session2 = {
    sessionId: 'test-twi-dtmf-' + Date.now(),
    step: 1,
    language: 'en',
    callerNumber: '+233553838464',
    destinationNumber: '+233308048097',
    direction: 'Inbound',
    dtmfHistory: [],
    conversation: [],
    events: []
  };
  const t1Result = await ivrEngine.handleAiAgentTurn(session2, null, '2#', null);
  if (session2.language !== 'twi') {
    throw new Error(`FAIL: Session language should be 'twi', got '${session2.language}'`);
  }
  if (!['groq', 'ug_hci'].includes(session2.asrProvider)) {
    throw new Error(`FAIL: Session ASR provider should be 'groq' or 'ug_hci', got '${session2.asrProvider}'`);
  }
    if (t1Result.aiReply.includes('Akwaaba') || !t1Result.aiReply.includes('Welcome')) {
      throw new Error('Twi-selected session should keep the agent reply in English');
    }
    if (!t1Result.xml.includes('/audio/mock_twi.wav')) {
      throw new Error('Twi-selected session should use HCI TTS audio when available');
  }
  console.log(`  PASS  Option 2 cleanly switches session to Twi & ASR (${session2.asrProvider})`);

  // Test 4: Saying "twi" switches to Twi
  console.log('\n[4] Testing Spoken "Twi" language switch...');
  const session3 = {
    sessionId: 'test-twi-spoken-' + Date.now(),
    step: 1,
    language: 'en',
    callerNumber: '+233553838464',
    destinationNumber: '+233308048097',
    direction: 'Inbound',
    dtmfHistory: [],
    conversation: [],
    events: []
  };
  const tSpokenResult = await ivrEngine.handleAiAgentTurn(session3, null, null, 'I prefer Twi please');
  if (session3.language !== 'twi') {
    throw new Error(`FAIL: Session language should be 'twi', got '${session3.language}'`);
  }
  if (!['groq', 'ug_hci'].includes(session3.asrProvider)) {
    throw new Error(`FAIL: Session ASR provider should be 'groq' or 'ug_hci', got '${session3.asrProvider}'`);
  }
  console.log(`  PASS  Spoken "Twi" switches session to Twi & ASR (${session3.asrProvider})`);

  // Test 5: Verify Turn 2 in Twi session passes ASR provider
  console.log('\n[5] Testing Turn 2 ASR handover in Twi session...');
  const session4 = {
    sessionId: 'test-twi-turn2-' + Date.now(),
    step: 2,
    language: 'twi',
    asrProvider: transcription.twiProvider || 'groq',
    callerNumber: '+233553838464',
    destinationNumber: '+233308048097',
    direction: 'Inbound',
    dtmfHistory: ['2'],
    conversation: [],
    events: []
  };
  // Simulate Turn 2 caller speech
  const t2Result = await ivrEngine.handleAiAgentTurn(session4, null, null, 'Mepɛ sɛ memane sika aduonum kɔma Kwame Mensah');
  if (session4.language !== 'twi') {
    throw new Error(`FAIL: Session language should remain 'twi'`);
  }
  if (!t2Result.latencyBreakdown?.keysUsed?.audioWhisper) {
    throw new Error(`FAIL: Audio Whisper key should be recorded in keysUsed`);
  }
  console.log(`  PASS  Turn 2 in Twi session uses active provider: ${t2Result.latencyBreakdown?.keysUsed?.audioWhisper}`);

  console.log('\n🎉 ALL TWI FLOW TESTS PASSED!\n');
  process.exit(0);
}

testTwiFlow().catch(err => {
  console.error('\n❌ TEST FAILED:', err.message);
  process.exit(1);
});
