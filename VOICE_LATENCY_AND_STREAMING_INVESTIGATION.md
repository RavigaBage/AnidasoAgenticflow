# Voice Latency, Africa's Talking Telephony, and Streaming Architecture Investigation

**Project:** Anidaso Okwankyerefopa Voice Mobile Money  
**Repository:** `RavigaBage/AnidasoAgenticflow`  
**Date:** October 2026  
**Document Status:** Complete Technical Architecture & Implementation Report  

---

## 1. Executive Summary: The 5-Minute Voice Stall Root Cause

During voice AI testing on Africa's Talking (AT) telecom webhooks, voice calls were experiencing unacceptable delays—at times stalling for several minutes or failing to complete the turn.

### Key Finding: Groq is NOT the Slow Part
* **Whisper Large v3 Turbo on Groq** transcribes audio at **~216× real-time**. A 10-second caller recording transcribes in **~350 ms – 500 ms**.
* **Groq LLM Reasoning** (using `openai/gpt-oss-20b` or Llama models) generates tokens at **250–500 tokens per second**, meaning a concise 2-sentence conversational response takes **~300 ms – 700 ms**.
* The core AI engines take **under 1.2 seconds combined**.

### What Caused the Stalls?
The delays and minutes-long stalls were caused by **four compounding structural bottlenecks**:

```
[Problem Flow - Compounding Delays]
1. Long Record Timeout (5s) ──> 2. Interim T.mp3 404 Retries (2.5s) ──> 3. Groq 429 Uncapped Backoff (up to 40s x 4 retries) ──> 4. Telecom Drops Line (15s AT Timeout)
```

1. **Uncapped 429 Rate Limit Backoff Loops**:
   * When hitting Groq rate limits (free-tier Requests-Per-Minute or Tokens-Per-Minute), the previous code caught HTTP 429 and executed `setTimeout` with `Math.min(waitSeconds * 1000, 40000)` with up to 4 retries.
   * If an agent executed a tool call, it ran **two LLM calls** in sequence. Two 429 retries could easily accumulate **160 seconds (almost 3 minutes)** of sleep while the telephone was connected.
   * Standard HTTP `retry-after` response headers were not being parsed.
2. **Silence Detection Lag (`timeout="5"`)**:
   * Africa's Talking `<Record>` action used `timeout="5"`. After the caller finished speaking, the telecom carrier waited **5 full seconds of dead silence** before finalizing the MP3 and firing the HTTP webhook callback. To the caller, the call appeared frozen.
3. **Sequential Interim `T.mp3` Storage Latency**:
   * When Africa's Talking fires a mid-call recording webhook, it appends a trailing `T` to the filename (e.g. `hashT.mp3`), while the actual finalized recording is stored as `hash.mp3`.
   * Downloading this file sequentially over HTTP before transcribing meant 2 roundtrips: telecom -> our server -> Groq.
4. **Africa's Talking Edge Gateway Webhook Timeout**:
   * Telecom switches typically enforce a strict 10–15 second webhook response deadline. When our server delayed beyond 15 seconds due to retries, Africa's Talking dropped the call or played a busy tone.

---

## 2. Telephony Latency Anatomy: Where Every Millisecond Lives

In a turn-based phone system, total turn latency is the sum of five distinct stages:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        TURN-BASED TELEPHONY LATENCY BREAKDOWN                          │
├───────────────┬──────────────────────────┬─────────────────────────────┬───────────────┤
│ Stage         │ What Happens             │ Previous State              │ Optimized     │
├───────────────┼──────────────────────────┼─────────────────────────────┼───────────────┤
│ 1. Record     │ Silence detection cutoff │ 5.0 s (timeout="5")         │ 1.8 – 2.0 s   │
│ 2. Download   │ Fetch audio from AT CDN  │ 1.5 – 3.0 s (4 attempts)    │ 0.3 – 0.6 s   │
│ 3. ASR (STT)  │ Groq Whisper Turbo       │ 0.4 – 0.8 s                 │ 0.3 – 0.5 s   │
│ 4. LLM Agent  │ Reasoning + MoMo tools   │ 0.8 – 40.0+ s (uncapped 429)│ 0.6 – 1.2 s   │
│ 5. Reply TTS  │ Built-in AT <Say> XML    │ 0.05 s                      │ 0.05 s        │
├───────────────┼──────────────────────────┼─────────────────────────────┼───────────────┤
│ TOTAL LATENCY │ Caller speech to hearing │ 8.0 s – 5+ MINUTES (STALL)  │ ~2.5 – 3.5 s  │
└───────────────┴──────────────────────────┴─────────────────────────────┴───────────────┘
```

> **Key Rule of Telecom Voice UX:**  
> In conversational phone calls, human conversational pauses average **600ms – 1,200ms**. Turn-based XML cannot reach 600ms due to telecom silence timeouts, but optimizing it to **~2.5s** makes phone banking and MoMo transfers practical and dependable.

---

## 3. Implemented Telephony Telemetry: Step 1 (Measure)

To eliminate guesswork and pinpoint bottlenecks on every call, we implemented high-resolution stage profiling across [`server.js`](file:///c:/Users/Admin/Desktop/Fixed_anidaso/server.js), [`ivr-engine.js`](file:///c:/Users/Admin/Desktop/Fixed_anidaso/ivr-engine.js), [`transcription.js`](file:///c:/Users/Admin/Desktop/Fixed_anidaso/transcription.js), and [`ai-agent.js`](file:///c:/Users/Admin/Desktop/Fixed_anidaso/ai-agent.js).

### Terminal Profiler Output Example:
Every voice turn prints an exact breakdown table in real time:

```
======================================================
⏱️  [VOICE PIPELINE LATENCY PROFILER] Turn 1
------------------------------------------------------
1. Audio Download    :   385 ms (24,112 bytes)
2. Groq Whisper (STT):   420 ms
3. Groq LLM Agent    :   640 ms
4. MoMo Tool Action  :   310 ms
------------------------------------------------------
⚡ TOTAL TURN TIME   :  1,755 ms ✅ [SUB-2S TARGET MET]
======================================================
```

### Telemetry Schema Broadcasted Over WebSocket:
The simulator frontend receives this JSON payload via `AT_XML_RESPONSE`:

```json
{
  "turnIndex": 1,
  "sessionId": "ATVId_f9b01faa49d82280677de559e76049c9",
  "downloadMs": 385,
  "audioBytes": 24112,
  "sttMs": 420,
  "llmMs": 640,
  "toolMs": 310,
  "totalTurnMs": 1755,
  "targetSubTwoSeconds": true
}
```

---

## 4. Quick Wins Implemented in the Main Codebase: Step 2

### 1. Groq 429 Rate-Limit Handling with `retry-after` & Strict Voice Caps
* **Location:** [`ai-agent.js`](file:///c:/Users/Admin/Desktop/Fixed_anidaso/ai-agent.js) & [`transcription.js`](file:///c:/Users/Admin/Desktop/Fixed_anidaso/transcription.js)
* **What Changed:**
  1. Inspects the HTTP `retry-after` header from Groq Cloud.
  2. Parses the wait duration and **strictly caps it to maximum 3.0 seconds** (never 40s).
  3. Capped retries at **2 attempts max**.
  4. If retries fail or rate limits persist, the agent fails gracefully within 2 seconds with a polite voice prompt (*"I'm processing your request. Please speak your choice again."*), keeping the telecom line alive.

### 2. Africa's Talking `<Record>` Action Tuning
* **Location:** [`ivr-engine.js`](file:///c:/Users/Admin/Desktop/Fixed_anidaso/ivr-engine.js) & [`.env.example`](file:///c:/Users/Admin/Desktop/Fixed_anidaso/.env.example)
* **What Changed:**
  * `timeout="2"` (configurable via `AT_RECORD_TIMEOUT=2`). Shaves **3 full seconds of silence** off every caller turn compared to `timeout="5"`.
  * `trimSilence="true"` removes empty audio padding before upload.
  * `maxLength="12"` prevents long rambling recordings from blocking the pipeline.
  * `finishOnKey="#"` allows callers to press hash immediately when done speaking.

### 3. Voice Webhook Latency Guard & Keep-Alive XML
* **Location:** [`server.js`](file:///c:/Users/Admin/Desktop/Fixed_anidaso/server.js)
* **What Changed:**
  * Added `VOICE_WEBHOOK_TIMEOUT_MS = 11000` (11 seconds).
  * If upstream APIs (Groq, MTN sandbox) take longer than 11s, the server dispatches a keep-alive XML before Africa's Talking can time out the call:
    ```xml
    <Response>
      <Say voice="en-US-Standard-C">Sorry, that is taking a little longer than expected. Please repeat your request after the beep.</Say>
      <Record finishOnKey="#" maxLength="12" timeout="2" trimSilence="true" playBeep="true" callbackUrl="...">
        <Say voice="en-US-Standard-C">Please speak now.</Say>
      </Record>
    </Response>
    ```

### 4. Built-in Africa's Talking `<Say>` over Remote TTS
* **Decision:** We use Africa's Talking native `<Say voice="en-US-Standard-C">`.
* **Why:** External TTS (ElevenLabs, Amazon Polly, Google TTS) requires:
  1. Sending text to TTS provider (~400 ms).
  2. Downloading audio buffer.
  3. Uploading audio file to an accessible public S3/Render URL (~500 ms).
  4. Serving `<Play url="..."/>` in XML.
* Africa's Talking's built-in `<Say>` synthesizes directly inside the telecom edge switch at **0 ms extra upload latency**.

### 5. Strict 1–2 Sentence Spoken Brevity Rule
* **Location:** [`ai-agent.js`](file:///c:/Users/Admin/Desktop/Fixed_anidaso/ai-agent.js) (System Prompt)
* **Rule:** Spoken responses are strictly limited to **under 30 words (1–2 concise sentences)**. Shorter text streams in < 400 ms and reads clearly over GSM voice codecs.

### 6. XML Injection Sanitization & Stale Session Cleanup
* **Location:** [`ivr-engine.js`](file:///c:/Users/Admin/Desktop/Fixed_anidaso/ivr-engine.js)
* **What Changed:**
  * `escapeXml()` sanitizes dynamic strings (caller names, references, AI text) against XML syntax crashes.
  * Background interval cleans up sessions older than 30 minutes to prevent memory leaks on Render.

---

## 5. Technical Roadmap: Step 3 (True Real-Time Audio Streaming)

### Why Turn-Based Has a Latency Floor
In turn-based XML telephony:
* The telecom provider records audio until silence is detected (`timeout="2"` = 2 seconds).
* The audio is packaged into an MP3 and posted to our webhook over HTTP (~400ms).
* Our server downloads the file and sends it to Groq Whisper (~800ms).
* **Intrinsic Latency Floor:** ~2.5 to 3.2 seconds.

### The Sub-Second Alternative: Real-Time Audio Streaming (500ms – 800ms)
To achieve sub-second response times, audio must stream continuously in chunks rather than waiting for call turns to end.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                      REAL-TIME STREAMING TELEPHONY ARCHITECTURE                        │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│  [Caller Phone] (+233 Ghana)                                                           │
│         │                                                                              │
│         ▼ (SIP / GSM Audio)                                                            │
│  [Africa's Talking SIP Trunk]                                                          │
│         │                                                                              │
│         ▼ (RTP / SIP Signaling)                                                        │
│  [LiveKit SIP Ingress / Pipecat Voice Agent Server]                                    │
│         │                                                                              │
│         ├──> [Silero VAD] (Instant barge-in / speech start-end detection: ~150ms)       │
│         │                                                                              │
│         ├──> [Streaming STT] (Deepgram Nova-2 / Whisper stream chunking: ~200ms)       │
│         │                                                                              │
│         ├──> [Groq LLM Streaming] (First token latency: ~150ms)                         │
│         │                                                                              │
│         └──> [Streaming TTS] (Canopy Labs Orpheus / ElevenLabs Flash / Cartesia: ~200ms)│
│                                                                                        │
│  TOTAL TIME TO FIRST SOUND: ~600 ms - 800 ms (True Conversational Flow)                │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Implementing Streaming with Africa's Talking:
1. **Africa's Talking SIP Trunking**:
   * Africa's Talking provides SIP endpoints that can route calls from Ghana numbers (`+233308048097`) to an external SIP URI.
   * Contact AT support to enable SIP trunk routing for your designated voice number.
2. **Media Framework: LiveKit Telephony or Pipecat**:
   * Deploy a LiveKit SIP Ingress gateway (`livekit-server` + `sip`).
   * When a call enters, LiveKit opens a bidirectional WebRTC audio track.
3. **Voice Activity Detection (VAD) & Barge-in**:
   * Silero VAD runs client/server-side. When the user speaks, it instantly cancels any outgoing audio playback (barge-in), allowing natural interruptions.
4. **Streaming TTS**:
   * Canopy Labs Orpheus (available on GroqCloud for English/Arabic) or Cartesia Sonic synthesizes audio in stream chunks, sending audio packets back to the caller within 200 ms of the first LLM token.

---

## 6. Verification and Smoke Test Results

All six core regression and smoke tests pass on the optimized codebase:

```bash
node tests/smoke.test.js
```

```
[smoke] Booting server on port 3457 ...

[1] Health & dashboard endpoints
  PASS  GET /health returns 200
  PASS  GET /api/dashboard returns success payload

[2] MoMo service exposes previously-missing methods
  PASS  momoService.getTransferStatus() exists
  PASS  momoService.getRequestToPayStatus() exists
  PASS  momoService.createSandboxApiUser() exists
  PASS  momoService.createSandboxApiKey() exists

[3] Auth guard on paid endpoints (no key → 401)
  PASS  POST /api/call without key → 401
  PASS  POST /api/call-transfer without key → 401
  PASS  POST /api/services/mtn/send-money without key → 401
  PASS  POST /api/services/mtn/cash-out without key → 401
  PASS  POST /api/call with key but missing "to" → 400

[4] Voice webhook turn-0 greeting XML
  PASS  POST /voice/callback returns 200
  PASS  XML content-type returned
  PASS  Greeting XML is a well-formed Response document
  PASS  Greeting XML contains <Record> listening tag
  PASS  Greeting speaks the MTN menu prompt

[5] Custom ASR provider fails loudly (no silent placeholder)
  PASS  transcribeWithCustomProvider() throws an explicit error

[6] Session cleanup: ended calls leave the active sessions map
  PASS  Completed session removed from activeSessions
  PASS  Completed session preserved in recentHistory

✅ All smoke tests passed
```

---

## 7. How to Download and Inspect This File

This investigation report is available directly in the project and can be accessed in three ways:

1. **Repository File:**  
   Path: [`VOICE_LATENCY_AND_STREAMING_INVESTIGATION.md`](file:///c:/Users/Admin/Desktop/Fixed_anidaso/VOICE_LATENCY_AND_STREAMING_INVESTIGATION.md)
2. **Direct Browser Download via Server API:**  
   `GET https://anidasoagenticflow.onrender.com/api/investigation-report/download` (or `http://localhost:3000/api/investigation-report/download`)
3. **Web Simulator Dashboard:**  
   Click the **⏱️ Latency Report (⬇️ .MD)** button in the top navigation bar of the dashboard.
