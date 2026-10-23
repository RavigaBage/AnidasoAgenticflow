# Africa's Talking Voice Phone Simulator 

A real-time phone simulator and voice event processor configured for **Africa's Talking Voice API**. It receives live voice callbacks (`/voice/callback`), generates valid `<Response>` XML actions (`<Say>`, `<GetDigits>`, `<Play>`, `<Dial>`, `<Record>`, `<Reject>`), tracks multi-turn call sessions, and provides an interactive dark-themed phone interface with DTMF audio synthesizer and WebSockets.

---

##  Key Features

1. **Voice AI Agent Loop (Powered by Groq Cloud)**:
   - **Model**: `openai/gpt-oss-20b` (configured in `.env`).
   - Generates natural, concise voice responses in < 600ms latency.
   - Maintains multi-turn conversation memory per `sessionId`.
   - Voice-engineered system instructions optimized for telephony TTS.

2. **Pluggable Speech-to-Text (ASR) Service (`transcription.js`)**:
   - Ready-to-use Groq Whisper (`whisper-large-v3-turbo`) using the same Groq API key.
   - Clean, modular plug-in hook (`transcribeWithCustomProvider`) so you can effortlessly swap in Deepgram, Google Cloud Speech, AssemblyAI, or your custom ASR model when ready!

3. **Live Africa's Talking Webhook Receiver**:
   - Handles standard HTTP POST (`application/x-www-form-urlencoded`) payloads sent by Africa's Talking gateways (`sessionId`, `isActive`, `direction`, `callerNumber`, `destinationNumber`, `dtmfDigits`, `recordingUrl`, `durationInSeconds`, `currencyCode`, `amount`).
   - Automatically generates Africa's Talking `<Response>` XML with `<Play>`, `<Say>`, and `<Record>`.

4. **Interactive Phone Handset**:
   - **Modern Dark Obsidian & Cyan Theme** (high-contrast, responsive, glassmorphic).
   - **Live Dialogue Feed**: Real-time display of caller speech transcripts and Groq AI responses.
   - **Keypad (0–9, *, #)** with authentic DTMF dual-tone frequencies synthesized via the **Web Audio API**.
   - **Browser Voice Synthesis (TTS)**: Extracts `<Say>` text from XML responses and speaks it aloud through the simulator speaker using the Web Speech API.

3. **Multi-Turn IVR Engine**:
   - **Interactive Menu Flow**:
     - *Turn 1*: Prompts caller with `<GetDigits>` menu (1: Balance guidance, 2: Configured audio playback `<Play>`, 3: Leave recording `<Record>`, 0: Forward to configured support line `<Dial>`).
     - *Turn 2*: Processes entered `dtmfDigits` and executes the next action.
   - **Custom XML Mode**: Directly edit `<Response>` XML in real-time in the UI and test immediate responses.
   - **Live Operator Mode**: Holds incoming calls open for up to 8 seconds, notifying the browser operator to write or select custom response XML on the fly.

4. **Outbound Calling & Call Transfer**:
   - Integrates with Africa's Talking `/call` and `/callTransfer` endpoints using your configured `.env` credentials.

5. **Integrated Synthetic Webhook Tester**:
   - Test full IVR loops locally before exposing your server to the internet or configuring ngrok.

---

## Twi Audio Matching

Twi replies keep their English text for the agent and dashboard. The audio arranger matches exact reply text against `Audio_library/urls.json` and plays a listed clip only when its referenced audio file exists. Replies not covered by an exact clip are synthesized by HCI Lab TTS.

Keep each clip's exact spoken text, generated ID, language, and relative audio path in `Audio_library/urls.json`; place its audio file at that path under `Audio_library/`. Twi clips must use `language: "Twi"`.

```json
{
   "clips": [
      {
         "id": "Id1",
         "file": "Id1.wav",
         "text": "Welcome.",
         "language": "twi"
      }
   ]
}
```

The HCI Lab request uses the existing `UG_HCI_LAB_API_KEY` environment setting and TTS cache/quota controls. Keep the key in environment configuration; do not put it in the audio library JSON.

##  Configuration (`.env`)

Add your Africa's Talking credentials to [.env](file:///c:/Users/Admin/Desktop/Fixed_anidaso/.env):

```env
# Server Configuration
PORT=3000

# Africa's Talking Credentials
AT_USERNAME=sandbox
AT_API_KEY=your_africastalking_api_key_here
AT_PHONE_NUMBER=+254711082000

# Africa's Talking Voice Endpoints
AT_VOICE_URL=https://voice.africastalking.com/call
AT_TRANSFER_URL=https://voice.africastalking.com/callTransfer

# Public Callback URL (Exposed via ngrok or cloud host)
PUBLIC_CALLBACK_URL=https://your-domain.ngrok-free.app/voice/callback

# Optional interactive IVR destinations (leave blank if not configured)
AUDIO_MENU_URL=
CUSTOMER_SUPPORT_PHONE_NUMBER=
```

---

##  Connecting to Live Africa's Talking

1. Expose your local port `3000` to the internet (e.g. using ngrok):
   ```bash
   ngrok http 3000
   ```
2. In your [Africa's Talking Voice Dashboard](https://account.africastalking.com/):
   - Go to **Voice** > **Phone Numbers**.
   - Select your virtual phone number.
   - Set the **Callback URL** to:
     ```text
     https://your-domain.ngrok-free.app/voice/callback
     ```
3. Whenever an inbound call arrives or an outbound call is placed, Africa's Talking will POST directly to this simulator!

---

## Running Locally

```bash
# Start server
npm start

# Development with hot-reload
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.
