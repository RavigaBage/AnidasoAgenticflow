/**
 * Africa's Talking Phone Simulator - Frontend Controller
 */

(function () {
  'use strict';

  // State
  let ws = null;
  let activeSession = null;
  let callTimerInterval = null;
  let callSeconds = 0;
  let dialInputBuffer = '';
  let serverConfig = {};
  let currentMode = 'interactive';

  /**
   * Auth header helper for endpoints protected by requireApiKey (outbound calls,
   * MoMo money movement). The key is stored in sessionStorage only — never hardcoded.
   * On first use against a protected endpoint, the user is prompted once.
   */
  function dashboardApiKey() {
    let key = sessionStorage.getItem('dashboardApiKey') || '';
    if (!key) {
      key = window.prompt(
        'This server protects paid endpoints (outbound calls / MoMo transactions).\n' +
        'Enter the DASHBOARD_API_KEY configured on the server (leave blank for local development):'
      ) || '';
      sessionStorage.setItem('dashboardApiKey', key);
    }
    return key;
  }

  function authHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const key = dashboardApiKey();
    if (key) headers['x-api-key'] = key;
    return headers;
  }

  // DOM Elements
  const els = {
    connectionDot: document.getElementById('connectionDot'),
    connectionStatusText: document.getElementById('connectionStatusText'),
    webhookUrlDisplay: document.getElementById('webhookUrlDisplay'),
    copyWebhookBtn: document.getElementById('copyWebhookBtn'),

    // Phone Handset
    phoneStatusLabel: document.getElementById('phoneStatusLabel'),
    phoneNumberDisplay: document.getElementById('phoneNumberDisplay'),
    phoneDestDisplay: document.getElementById('phoneDestDisplay'),
    callTimer: document.getElementById('callTimer'),
    liveTranscriptBox: document.getElementById('liveTranscriptBox'),
    transcriptContent: document.getElementById('transcriptContent'),
    keypadGrid: document.getElementById('keypadGrid'),
    btnAnswer: document.getElementById('btnAnswer'),
    btnHangup: document.getElementById('btnHangup'),
    btnMute: document.getElementById('btnMute'),
    btnSpeaker: document.getElementById('btnSpeaker'),

    // Center Stream & Stats
    eventFeed: document.getElementById('eventFeed'),
    activeSessionCount: document.getElementById('activeSessionCount'),
    totalEventsCount: document.getElementById('totalEventsCount'),
    activeSessionsTable: document.getElementById('activeSessionsTable'),
    btnQuickTest: document.getElementById('btnQuickTest'),
    btnOpenOutboundModal: document.getElementById('btnOpenOutboundModal'),
    btnClearLogs: document.getElementById('btnClearLogs'),

    // Mode Selector & XML Editor
    modeCards: document.querySelectorAll('.mode-card'),
    customXmlEditor: document.getElementById('customXmlEditor'),
    btnSaveXmlSettings: document.getElementById('btnSaveXmlSettings'),
    snippetTags: document.querySelectorAll('.snippet-tag'),

    // Modals
    outboundModal: document.getElementById('outboundModal'),
    outboundForm: document.getElementById('outboundForm'),
    btnCancelOutbound: document.getElementById('btnCancelOutbound'),
    closeOutboundModal: document.getElementById('closeOutboundModal'),

    simModal: document.getElementById('simModal'),
    simForm: document.getElementById('simForm'),
    btnCancelSim: document.getElementById('btnCancelSim'),
    closeSimModal: document.getElementById('closeSimModal'),

    operatorModal: document.getElementById('operatorModal'),
    operatorTimer: document.getElementById('operatorTimer'),
    operatorPromptText: document.getElementById('operatorPromptText'),
    operatorXmlInput: document.getElementById('operatorXmlInput'),
    btnSubmitOperatorXml: document.getElementById('btnSubmitOperatorXml'),
    btnRejectOperatorCall: document.getElementById('btnRejectOperatorCall'),

    // Environment info
    envUsername: document.getElementById('envUsername'),
    envPhone: document.getElementById('envPhone'),
    envApiKeyStatus: document.getElementById('envApiKeyStatus'),
    envAiModel: document.getElementById('envAiModel'),
    envAsrProvider: document.getElementById('envAsrProvider'),
    groqStatusText: document.getElementById('groqStatusText'),

    // AI Dialogue Thread
    aiDialogueThread: document.getElementById('aiDialogueThread'),
    aiStatusTicker: document.getElementById('aiStatusTicker'),
    speechSimForm: document.getElementById('speechSimForm'),
    simSpeechInput: document.getElementById('simSpeechInput'),

    toastContainer: document.getElementById('toastContainer'),

    // MoMo Sandbox Test Console
    btnOpenMomoModal: document.getElementById('btnOpenMomoModal'),
    momoModal: document.getElementById('momoModal'),
    closeMomoModal: document.getElementById('closeMomoModal'),
    btnCloseMomoModalBottom: document.getElementById('btnCloseMomoModalBottom'),
    btnRunMomoKyc: document.getElementById('btnRunMomoKyc'),
    btnRunMomoBalance: document.getElementById('btnRunMomoBalance'),
    btnRunMomoTransfer: document.getElementById('btnRunMomoTransfer'),
    btnRunMomoCashout: document.getElementById('btnRunMomoCashout'),
    momoRawResponseArea: document.getElementById('momoRawResponseArea'),
    momoResponseStatusBadge: document.getElementById('momoResponseStatusBadge'),
    momoFormattedResultBox: document.getElementById('momoFormattedResultBox'),
    momoFormattedResultContent: document.getElementById('momoFormattedResultContent'),
    momoKycPhone: document.getElementById('momoKycPhone'),
    momoBalProduct: document.getElementById('momoBalProduct'),
    momoTransferPhone: document.getElementById('momoTransferPhone'),
    momoTransferAmount: document.getElementById('momoTransferAmount'),
    momoTransferRef: document.getElementById('momoTransferRef'),
    momoCashoutPhone: document.getElementById('momoCashoutPhone'),
    momoCashoutAmount: document.getElementById('momoCashoutAmount')
  };

  let totalEventsCounter = 0;
  let operatorCountdownInterval = null;

  /* ==========================================================================
     WEBSOCKET CONNECTION & EVENT DISPATCH
     ========================================================================== */
  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      els.connectionDot.classList.remove('offline');
      els.connectionStatusText.textContent = 'ONLINE (LISTENING)';
      showToast('Connected to Africa\'s Talking Simulator backend', 'success');
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        handleServerMessage(message);
      } catch (err) {
        console.error('Error parsing WebSocket message:', err);
      }
    };

    ws.onclose = () => {
      els.connectionDot.classList.add('offline');
      els.connectionStatusText.textContent = 'OFFLINE (RECONNECTING)';
      setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = (err) => {
      console.warn('WebSocket error:', err);
      ws.close();
    };
  }

  function handleServerMessage(message) {
    const { type, data } = message;

    switch (type) {
      case 'INITIAL_STATE':
        serverConfig = data.config || {};
        updateConfigUi(data.config, data.publicCallbackUrl, data.aiConfig, data.asrConfig);
        updateDashboard(data.dashboard);
        renderServicesMemory(data.servicesMemory);
        break;

      case 'SERVICES_MEMORY_UPDATED':
        renderServicesMemory(data);
        break;

      case 'AGENTIC_ACTION_TRIGGERED':
        appendAgenticActionCard(data);
        showToast(`⚡ Action Triggered: ${data.actionName}`, 'success');
        break;

      case 'MOMO_TRANSACTION_EXECUTED':
        appendMomoTransactionCard(data);
        showToast(`💛 MoMo API: ${data.action} executed`, 'success');
        break;

      case 'AT_WEBHOOK_EVENT':
        totalEventsCounter++;
        els.totalEventsCount.textContent = totalEventsCounter;
        processIncomingWebhookEvent(data);
        break;

      case 'AI_PROGRESS_UPDATE':
        updateAiProgress(data);
        break;

      case 'AT_XML_RESPONSE':
        totalEventsCounter++;
        els.totalEventsCount.textContent = totalEventsCounter;
        processOutgoingXmlResponse(data);
        break;

      case 'OPERATOR_PROMPT_REQUIRED':
        promptOperatorAction(data);
        break;

      case 'OUTBOUND_CALL_TRIGGERED':
        showToast(`Outbound call triggered: ${data.result.success ? 'Queued' : data.result.error}`, data.result.success ? 'success' : 'error');
        appendLogItem({
          type: 'OUTBOUND_API',
          title: 'Outbound Call API Request',
          badge: 'outbound',
          meta: { To: data.to, From: data.from, Status: data.result.success ? 'Queued' : 'Failed' },
          code: JSON.stringify(data.result, null, 2)
        });
        break;

      case 'SESSION_ENDED':
        if (activeSession && activeSession.sessionId === data.sessionId) {
          endCallUi();
        }
        refreshDashboardData();
        break;

      case 'SESSION_MEMORY_DISCARDED':
        showToast(`🧹 Call Ended: Session memory discarded (${data.sessionId})`, 'info');
        appendLogItem({
          type: 'SESSION_CLEANUP',
          title: `Session Memory Discarded`,
          badge: 'response',
          meta: {
            'Session ID': data.sessionId,
            'Call Duration': `${data.summary?.durationSeconds || 0}s`,
            'Turns': data.summary?.turnsCount || 0,
            'Actions Executed': data.summary?.actionsCount || 0
          },
          code: JSON.stringify(data.summary, null, 2)
        });
        break;

      case 'SETTINGS_UPDATED':
        updateDashboard(data);
        break;
    }
  }

  /* ==========================================================================
     INCOMING / OUTGOING EVENT PROCESSORS
     ========================================================================== */
  function processIncomingWebhookEvent(data) {
    const payload = data.payload || {};
    const { sessionId, isActive, direction, callerNumber, destinationNumber, dtmfDigits } = payload;

    // Update active session reference
    if (isActive === '1' || isActive === 1) {
      activeSession = {
        sessionId,
        callerNumber,
        destinationNumber,
        direction
      };

      // Connect Call Immediately to Active State (No Ringing)
      setPhoneState('active', callerNumber, destinationNumber);
      startCallTimer();
      els.btnAnswer.disabled = true;
      els.btnHangup.disabled = false;
    } else {
      // Call finalized (isActive = 0)
      endCallUi(payload);
    }

    // Add to event stream card
    appendLogItem({
      type: 'INBOUND_WEBHOOK',
      title: `AT Webhook: ${direction || 'Inbound'} Call`,
      badge: 'inbound',
      isSimulated: data.isSimulated,
      meta: {
        'Session ID': sessionId,
        'Active': isActive === '1' ? '1 (Ongoing)' : '0 (Ended)',
        'Caller Number': callerNumber,
        'Destination': destinationNumber,
        'DTMF Digits': dtmfDigits || '(None)'
      },
      code: JSON.stringify(payload, null, 2)
    });
  }

  function processOutgoingXmlResponse(data) {
    const { sessionId, xml, actionSummary, executionTimeMs, session } = data;

    // Add to event stream card
    appendLogItem({
      type: 'OUTGOING_RESPONSE',
      title: `Response to AT (${executionTimeMs}ms)`,
      badge: 'response',
      isSimulated: data.isSimulated,
      meta: {
        'Session ID': sessionId,
        'Action': actionSummary,
        'Processing Time': `${executionTimeMs}ms`
      },
      code: xml
    });

    // If this turn contained speech transcription and AI response, append to dialogue thread
    if (data.transcript && data.aiReply) {
      appendAiDialogueTurn(data.transcript, data.aiReply);
    }

    // If an agentic action was triggered, display the action card
    if (data.actionExecuted) {
      appendAgenticActionCard(data.actionExecuted);
    }

    // Parse XML tags to update phone screen & audio
    parseAndExecuteXmlActions(xml);
    refreshDashboardData();
  }

  function updateAiProgress(data) {
    if (!els.aiStatusTicker) return;
    if (data.stage === 'TRANSCRIBING') {
      els.aiStatusTicker.textContent = '🎙️ Transcribing Audio...';
      els.aiStatusTicker.style.color = 'var(--accent-cyan)';
    } else if (data.stage === 'THINKING') {
      els.aiStatusTicker.textContent = '🧠 Groq AI Reasoning...';
      els.aiStatusTicker.style.color = '#c084fc';
    } else if (data.stage === 'REPLYING') {
      els.aiStatusTicker.textContent = '🔊 Spoken Reply to Caller';
      els.aiStatusTicker.style.color = 'var(--accent-emerald)';
      setTimeout(() => {
        if (els.aiStatusTicker) {
          els.aiStatusTicker.textContent = 'Ready (Listening)';
          els.aiStatusTicker.style.color = '#c084fc';
        }
      }, 4500);
    }
  }

  function appendAiDialogueTurn(userTranscript, aiReply) {
    if (!els.aiDialogueThread) return;
    const turnDiv = document.createElement('div');
    turnDiv.className = 'dialogue-turn';
    const modelName = (serverConfig && serverConfig.model) ? serverConfig.model : 'openai/gpt-oss-20b';

    turnDiv.innerHTML = `
      <div class="bubble-user">
        <div class="bubble-meta">
          <span>🎙️</span> Caller Speech (ASR)
        </div>
        "${escapeHtml(userTranscript)}"
      </div>
      <div class="bubble-ai">
        <div class="bubble-meta">
          <span>🤖</span> Groq Voice AI (${escapeHtml(modelName)})
        </div>
        "${escapeHtml(aiReply)}"
      </div>
    `;
    els.aiDialogueThread.appendChild(turnDiv);
    els.aiDialogueThread.scrollTop = els.aiDialogueThread.scrollHeight;
  }

  const seenActionTxs = new Set();

  function appendAgenticActionCard(actionData) {
    if (!actionData) return;
    const actionName = actionData.actionName || 'unknown_action';
    const params = actionData.params || {};
    const result = actionData.result || {};
    const txKey = result.transactionId || `${actionName}_${JSON.stringify(params)}`;

    // Avoid duplicate cards if received via both WebSocket and HTTP response
    if (txKey && seenActionTxs.has(txKey)) {
      return;
    }
    if (txKey) {
      seenActionTxs.add(txKey);
    }

    if (els.aiDialogueThread) {
      const card = document.createElement('div');
      card.className = 'action-execution-card';

      let paramsHtml = '';
      if (params && typeof params === 'object') {
        paramsHtml = Object.entries(params).map(([k, v]) => `
          <div class="action-param-item">
            <span class="action-param-label">${escapeHtml(k)}</span>
            <span class="action-param-val">${escapeHtml(String(v))}</span>
          </div>
        `).join('');
      }

      const statusBadge = result.success ? (result.status || 'SUCCESS') : 'FAILED';
      const promptMsg = result.promptMessage || result.error || JSON.stringify(result);

      let extraKycHtml = '';
      if (result.subscriberName) {
        extraKycHtml += `<div style="margin-top: 6px; padding: 6px 10px; border-radius: 6px; background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.3); font-weight: 600; color: #38bdf8;">👤 Verified KYC Subscriber: <strong>${escapeHtml(result.subscriberName)}</strong></div>`;
      }
      if (result.nameMatch === false || result.discrepancyWarning) {
        extraKycHtml += `<div style="margin-top: 6px; padding: 6px 10px; border-radius: 6px; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.35); color: #f87171; font-size: 0.8rem; font-weight: 600;">⚠️ Security Notice: Stated recipient name "${escapeHtml(result.statedName || 'N/A')}" differs from registered MoMo owner "${escapeHtml(result.subscriberName)}". Caller warned before initiating.</div>`;
      }
      if (result.financialTransactionId) {
        extraKycHtml += `<div style="margin-top: 6px; padding: 6px 10px; border-radius: 6px; background: rgba(234, 179, 8, 0.15); border: 1px solid rgba(234, 179, 8, 0.3); font-weight: 600; color: #fbbf24;">💳 Financial Tx ID: <strong>${escapeHtml(result.financialTransactionId)}</strong></div>`;
      }
      if (result.availableBalance !== undefined) {
        extraKycHtml += `<div style="margin-top: 6px; padding: 6px 10px; border-radius: 6px; background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.3); font-weight: 600; color: #34d399;">💰 Available Balance: <strong>${escapeHtml(result.availableBalance)} ${escapeHtml(result.currency || '')}</strong></div>`;
      }

      const rawJson = result.rawResponse ? JSON.stringify(result.rawResponse, null, 2) : JSON.stringify(result, null, 2);

      card.innerHTML = `
        <div class="action-card-header">
          <div class="action-card-title">
            <span>⚡</span> ACTION TRIGGERED: ${escapeHtml(actionName)}
          </div>
          <span class="action-card-badge">
            ${escapeHtml(statusBadge)}
          </span>
        </div>
        ${paramsHtml ? `<div class="action-card-grid">${paramsHtml}</div>` : ''}
        ${extraKycHtml}
        <div class="action-card-result" style="margin-top: 6px;">
          ${result.transactionId ? `<span style="color: #fbbf24; font-weight: 700;">Ref: ${escapeHtml(result.transactionId)}</span> — ` : ''}${escapeHtml(promptMsg)}
        </div>
        <details style="margin-top: 8px; font-size: 0.72rem; color: #94a3b8; cursor: pointer;">
          <summary style="outline: none; user-select: none;">View Untouched MTN MoMo Sandbox Response</summary>
          <pre style="margin-top: 6px; padding: 8px; border-radius: 6px; background: #0b1120; border: 1px solid #1e293b; color: #38bdf8; overflow-x: auto;">${escapeHtml(rawJson)}</pre>
        </details>
      `;

      els.aiDialogueThread.appendChild(card);
      els.aiDialogueThread.scrollTop = els.aiDialogueThread.scrollHeight;
    }

    // Append to live protocol stream
    appendLogItem({
      type: 'AGENTIC_ACTION',
      title: `⚡ Live Service: ${actionName}`,
      badge: 'response',
      meta: {
        'Action': actionName,
        'Tx ID': result.transactionId || result.financialTransactionId || '(None)',
        'Status': result.status || (result.success ? 'Success' : 'Failed'),
        'Subscriber': result.subscriberName || 'N/A',
        'Session ID': actionData.sessionId || (activeSession ? activeSession.sessionId : 'N/A')
      },
      code: JSON.stringify({ params, result }, null, 2)
    });
  }

  function appendMomoTransactionCard(momoData) {
    if (!momoData || !momoData.result) return;
    const action = momoData.action || 'momo_api';
    const result = momoData.result;
    const statusBadge = result.success ? (result.status || result.statusCode || '200 OK') : 'FAILED';
    const isSuccess = result.success !== false;

    if (els.aiDialogueThread) {
      const card = document.createElement('div');
      card.className = 'action-execution-card';
      card.style.borderColor = isSuccess ? 'rgba(234, 179, 8, 0.4)' : 'rgba(239, 68, 68, 0.4)';

      let customDetails = '';
      if (result.subscriberName) {
        customDetails += `<div style="margin-top: 6px; padding: 6px 10px; border-radius: 6px; background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.3); font-weight: 600; color: #38bdf8;">👤 Verified KYC Subscriber: <strong>${escapeHtml(result.subscriberName)}</strong></div>`;
      }
      if (result.nameMatch === false || result.discrepancyWarning) {
        customDetails += `<div style="margin-top: 6px; padding: 6px 10px; border-radius: 6px; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.35); color: #f87171; font-size: 0.8rem; font-weight: 600;">⚠️ Security Notice: Stated recipient name "${escapeHtml(result.statedName || 'N/A')}" differs from registered MoMo owner "${escapeHtml(result.subscriberName)}".</div>`;
      }
      if (result.financialTransactionId) {
        customDetails += `<div style="margin-top: 6px; padding: 6px 10px; border-radius: 6px; background: rgba(234, 179, 8, 0.15); border: 1px solid rgba(234, 179, 8, 0.3); font-weight: 600; color: #fbbf24;">💳 Financial Tx ID: <strong>${escapeHtml(result.financialTransactionId)}</strong></div>`;
      }
      if (result.availableBalance !== undefined) {
        customDetails += `<div style="margin-top: 6px; padding: 6px 10px; border-radius: 6px; background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.3); font-weight: 600; color: #34d399;">💰 Available Balance: <strong>${escapeHtml(result.availableBalance)} ${escapeHtml(result.currency || '')}</strong></div>`;
      }

      const rawJson = result.rawResponse ? JSON.stringify(result.rawResponse, null, 2) : JSON.stringify(result, null, 2);

      card.innerHTML = `
        <div class="action-card-header">
          <div class="action-card-title" style="color: #fbbf24;">
            <span>💛</span> LIVE MTN MOMO API: ${escapeHtml(action.toUpperCase())}
          </div>
          <span class="action-card-badge" style="background: ${isSuccess ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)'}; color: ${isSuccess ? '#34d399' : '#f87171'};">
            ${escapeHtml(String(statusBadge))}
          </span>
        </div>
        ${customDetails}
        <div class="action-card-result" style="margin-top: 8px;">
          ${escapeHtml(result.promptMessage || result.error || 'Live MoMo API executed.')}
        </div>
        <details style="margin-top: 8px; font-size: 0.72rem; color: #94a3b8; cursor: pointer;">
          <summary style="outline: none; user-select: none;">View Untouched MTN MoMo Sandbox Response</summary>
          <pre style="margin-top: 6px; padding: 8px; border-radius: 6px; background: #0b1120; border: 1px solid #1e293b; color: #38bdf8; overflow-x: auto;">${escapeHtml(rawJson)}</pre>
        </details>
      `;

      els.aiDialogueThread.appendChild(card);
      els.aiDialogueThread.scrollTop = els.aiDialogueThread.scrollHeight;
    }

    // Append to Protocol Stream
    appendLogItem({
      type: 'MOMO_API_RESPONSE',
      title: `💛 Live MTN MoMo: ${action}`,
      badge: isSuccess ? 'response' : 'error',
      meta: {
        'Action': action,
        'Status': String(statusBadge),
        'Subscriber': result.subscriberName || 'N/A',
        'Tx ID': result.financialTransactionId || result.referenceId || 'N/A'
      },
      code: JSON.stringify(result, null, 2)
    });
  }

  /**
   * Extract <Say>, <Play>, <Record> from AT response XML and speak/display them
   */
  function parseAndExecuteXmlActions(xmlString) {
    if (!xmlString) return;

    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlString, 'application/xml');

      // Check for <Say>
      const sayNodes = doc.getElementsByTagName('Say');
      if (sayNodes.length > 0) {
        const text = sayNodes[0].textContent.trim();
        els.transcriptContent.textContent = `"${text}"`;
        els.liveTranscriptBox.style.display = 'block';

        // Speak aloud through speaker
        window.phoneAudio.speakText(text);
      }

      // Check for <Play>
      const playNodes = doc.getElementsByTagName('Play');
      if (playNodes.length > 0) {
        const url = playNodes[0].getAttribute('url');
        if (url) {
          els.transcriptContent.textContent = `[Audio Playback]: ${url}`;
          window.phoneAudio.playAudioUrl(url);
        }
      }

      // Check for <Record>
      const recordNodes = doc.getElementsByTagName('Record');
      if (recordNodes.length > 0) {
        els.phoneStatusLabel.textContent = 'RECORDING';
        els.phoneStatusLabel.className = 'call-status-label active';
      }

      // Check for <GetDigits>
      const digitsNodes = doc.getElementsByTagName('GetDigits');
      if (digitsNodes.length > 0) {
        els.phoneStatusLabel.textContent = 'AWAITING INPUT (KEYPAD)';
        els.phoneStatusLabel.className = 'call-status-label active';
      }
    } catch (e) {
      console.warn('XML Parse error:', e);
    }
  }

  /* ==========================================================================
     PHONE HANDSET CONTROLS & STATE
     ========================================================================== */
  function setPhoneState(state, caller, dest) {
    els.phoneStatusLabel.className = 'call-status-label ' + state;
    els.phoneStatusLabel.textContent = state.toUpperCase();

    if (caller) {
      els.phoneNumberDisplay.textContent = caller;
    }
    if (dest) {
      els.phoneDestDisplay.textContent = `Line: ${dest}`;
    }
  }

  function answerCall() {
    setPhoneState('active');
    startCallTimer();
    els.btnAnswer.disabled = true;
    els.btnHangup.disabled = false;
  }

  function hangupCall() {
    if (activeSession) {
      fetch('/api/end-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSession.sessionId })
      }).catch(err => console.error(err));
    }
    endCallUi();
  }

  function endCallUi(finalPayload) {
    stopCallTimer();
    setPhoneState('ended');
    els.btnAnswer.disabled = false;
    els.btnHangup.disabled = true;

    if (finalPayload) {
      let durationStr = finalPayload.durationInSeconds ? `${finalPayload.durationInSeconds}s` : `${callSeconds}s`;
      let costStr = finalPayload.amount ? `${finalPayload.currencyCode || ''} ${finalPayload.amount}` : '';
      els.phoneDestDisplay.textContent = `Ended (${durationStr}) ${costStr}`;
    }

    setTimeout(() => {
      if (!activeSession || els.phoneStatusLabel.classList.contains('ended')) {
        setPhoneState('idle', 'Ready', 'No Active Call');
        els.callTimer.textContent = '00:00';
        els.transcriptContent.textContent = 'Awaiting Africa\'s Talking event...';
        activeSession = null;
      }
    }, 3500);
  }

  function startCallTimer() {
    stopCallTimer();
    callSeconds = 0;
    els.callTimer.textContent = '00:00';
    callTimerInterval = setInterval(() => {
      callSeconds++;
      const mins = String(Math.floor(callSeconds / 60)).padStart(2, '0');
      const secs = String(callSeconds % 60).padStart(2, '0');
      els.callTimer.textContent = `${mins}:${secs}`;
    }, 1000);
  }

  function stopCallTimer() {
    if (callTimerInterval) {
      clearInterval(callTimerInterval);
      callTimerInterval = null;
    }
  }

  // Handle Keypad Press (1-9, *, 0, #)
  function handleKeyPress(digit) {
    // Play DTMF tone immediately
    window.phoneAudio.playDtmf(digit);

    // Visual feedback
    if (activeSession) {
      dialInputBuffer += digit;
      els.phoneNumberDisplay.textContent = `DTMF: ${dialInputBuffer}`;

      // Simulate sending DTMF to Africa's Talking callback loop
      fetch('/api/simulate-webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: activeSession.sessionId,
          isActive: '1',
          callerNumber: activeSession.callerNumber,
          destinationNumber: activeSession.destinationNumber,
          dtmfDigits: digit
        })
      }).then(r => r.json()).then(data => {
        showToast(`Sent DTMF [${digit}] to IVR Flow`, 'success');
      }).catch(e => console.error(e));
    } else {
      dialInputBuffer += digit;
      els.phoneNumberDisplay.textContent = dialInputBuffer;
    }
  }

  /* ==========================================================================
     OPERATOR MANUAL DISPATCH PROMPT
     ========================================================================== */
  function promptOperatorAction(data) {
    const { sessionId, payload, timeoutSeconds } = data;
    els.operatorPromptText.textContent = `Incoming call from ${payload.callerNumber} (Session: ${sessionId}). Choose or write the XML response to dispatch to Africa's Talking:`;
    els.operatorModal.classList.add('open');

    let remaining = timeoutSeconds || 8;
    els.operatorTimer.textContent = `${remaining}s`;

    if (operatorCountdownInterval) clearInterval(operatorCountdownInterval);
    operatorCountdownInterval = setInterval(() => {
      remaining--;
      els.operatorTimer.textContent = `${remaining}s`;
      if (remaining <= 0) {
        clearInterval(operatorCountdownInterval);
        els.operatorModal.classList.remove('open');
      }
    }, 1000);

    els.btnSubmitOperatorXml.onclick = () => {
      clearInterval(operatorCountdownInterval);
      const xml = els.operatorXmlInput.value;
      fetch('/api/operator-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, xml })
      }).then(r => r.json()).then(res => {
        showToast('Operator response dispatched!', 'success');
        els.operatorModal.classList.remove('open');
      });
    };

    els.btnRejectOperatorCall.onclick = () => {
      clearInterval(operatorCountdownInterval);
      fetch('/api/operator-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, xml: '<Response><Reject/></Response>' })
      }).then(() => {
        showToast('Call rejected by operator', 'error');
        els.operatorModal.classList.remove('open');
      });
    };
  }

  /* ==========================================================================
     UI RENDERING & LOG STREAM
     ========================================================================== */
  function appendLogItem(log) {
    const card = document.createElement('div');
    card.className = `event-item-card ${log.badge === 'response' ? 'outgoing' : ''}`;

    const timestamp = new Date().toLocaleTimeString();

    let metaHtml = '';
    if (log.meta) {
      metaHtml = '<div class="event-meta-grid">' +
        Object.entries(log.meta).map(([k, v]) => `
          <div class="meta-field">
            <span class="meta-label">${escapeHtml(k)}</span>
            <span class="meta-val">${escapeHtml(String(v))}</span>
          </div>
        `).join('') +
        '</div>';
    }

    let codeHtml = '';
    if (log.code) {
      codeHtml = `<div class="xml-code-block">${escapeHtml(log.code)}</div>`;
    }

    card.innerHTML = `
      <div class="event-item-header">
        <span class="event-type-badge ${log.badge}">
          ${log.isSimulated ? '[SIM] ' : ''}${escapeHtml(log.title)}
        </span>
        <span class="event-timestamp">${timestamp}</span>
      </div>
      ${metaHtml}
      ${codeHtml}
    `;

    els.eventFeed.prepend(card);

    // Limit event cards in DOM
    while (els.eventFeed.children.length > 50) {
      els.eventFeed.removeChild(els.eventFeed.lastChild);
    }
  }

  function updateDashboard(dashboard) {
    if (!dashboard) return;

    if (dashboard.mode) {
      currentMode = dashboard.mode;
      els.modeCards.forEach(c => {
        c.classList.toggle('active', c.dataset.mode === currentMode);
      });
    }

    if (dashboard.customXml && !els.customXmlEditor.value) {
      els.customXmlEditor.value = dashboard.customXml;
    }

    const activeSessions = dashboard.activeSessions || [];
    els.activeSessionCount.textContent = activeSessions.length;

    // Render active sessions table
    if (activeSessions.length === 0) {
      els.activeSessionsTable.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No active Africa's Talking call sessions</td></tr>`;
    } else {
      els.activeSessionsTable.innerHTML = activeSessions.map(s => `
        <tr>
          <td><span style="color: var(--accent-cyan)">${escapeHtml(s.sessionId.slice(-10))}</span></td>
          <td>${escapeHtml(s.direction || 'Inbound')}</td>
          <td>${escapeHtml(s.callerNumber || 'Unknown')}</td>
          <td>${escapeHtml(s.destinationNumber || 'Unknown')}</td>
          <td><button class="btn-secondary" style="padding: 0.2rem 0.5rem; font-size: 0.7rem;" onclick="window.endSessionById('${s.sessionId}')">End</button></td>
        </tr>
      `).join('');
    }
  }

  window.endSessionById = function(sessionId) {
    fetch('/api/end-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    }).then(() => {
      showToast(`Session ${sessionId} terminated`, 'success');
      refreshDashboardData();
    });
  };

  function updateConfigUi(config, callbackUrl, aiConfig, asrConfig) {
    if (config) {
      els.envUsername.textContent = config.username || 'sandbox';
      els.envPhone.textContent = config.phoneNumber || '+254711082000';
      els.envApiKeyStatus.textContent = config.hasApiKey ? 'Configured (Active)' : 'Not Set in .env';
      els.envApiKeyStatus.style.color = config.hasApiKey ? 'var(--accent-emerald)' : 'var(--accent-rose)';
    }

    if (callbackUrl) {
      els.webhookUrlDisplay.textContent = callbackUrl;
    }

    if (aiConfig) {
      if (els.envAiModel) els.envAiModel.textContent = aiConfig.model || 'openai/gpt-oss-20b';
      if (els.groqStatusText) els.groqStatusText.textContent = `AI: GROQ (${aiConfig.model || 'openai/gpt-oss-20b'})`;
    }

    if (asrConfig && els.envAsrProvider) {
      els.envAsrProvider.textContent = `${asrConfig.provider.toUpperCase()} (${asrConfig.whisperModel})`;
    }
  }

  function refreshDashboardData() {
    fetch('/api/dashboard')
      .then(r => r.json())
      .then(res => {
        if (res.success && res.data) {
          updateDashboard(res.data.dashboard);
          if (res.data.servicesMemory) {
            renderServicesMemory(res.data.servicesMemory);
          }
        }
      })
      .catch(err => console.error(err));
  }

  function renderServicesMemory(servicesMemory) {
    if (!servicesMemory || !servicesMemory.availableServices) return;
    const container = document.getElementById('servicesListContainer');
    const badge = document.getElementById('servicesCountBadge');
    if (!container) return;

    if (badge) {
      badge.textContent = `${servicesMemory.availableServices.length} Services`;
    }

    container.innerHTML = servicesMemory.availableServices.map(s => `
      <div style="background: rgba(10, 15, 26, 0.6); border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 8px; padding: 0.5rem 0.75rem;">
        <div style="font-size: 0.76rem; font-weight: 700; color: var(--accent-cyan); display: flex; align-items: center; justify-content: space-between;">
          <span>${escapeHtml(s.name)}</span>
          <span style="font-size: 0.62rem; color: var(--text-muted); font-family: var(--font-mono);">${escapeHtml(s.id)}</span>
        </div>
        <div style="font-size: 0.68rem; color: var(--text-secondary); margin-top: 0.2rem; line-height: 1.3;">
          ${escapeHtml(s.description)}
        </div>
      </div>
    `).join('');
  }

  /* ==========================================================================
     EVENT LISTENERS & BINDINGS
     ========================================================================== */
  function setupEventListeners() {
    // Keypad Clicks
    els.keypadGrid.addEventListener('click', (e) => {
      const keyBtn = e.target.closest('.key-btn');
      if (keyBtn) {
        const digit = keyBtn.dataset.digit;
        if (digit) handleKeyPress(digit);
      }
    });

    // Keyboard support for Keypad
    document.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
      if ('0123456789*#'.includes(e.key)) {
        handleKeyPress(e.key);
      }
    });

    // Call Buttons
    els.btnAnswer.addEventListener('click', answerCall);
    els.btnHangup.addEventListener('click', hangupCall);

    // Mute / Speaker Audio
    els.btnMute.addEventListener('click', () => {
      const muted = window.phoneAudio.toggleMute();
      els.btnMute.classList.toggle('active', muted);
      els.btnMute.innerHTML = muted ? '🔇 <span>Muted</span>' : '🎤 <span>Mute</span>';
    });

    els.btnSpeaker.addEventListener('click', () => {
      const speech = window.phoneAudio.toggleSpeech();
      els.btnSpeaker.classList.toggle('active', !speech);
      els.btnSpeaker.innerHTML = speech ? '🔊 <span>Speaker</span>' : '🔈 <span>TTS Off</span>';
    });

    // Mode Selector
    els.modeCards.forEach(card => {
      card.addEventListener('click', () => {
        const mode = card.dataset.mode;
        fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, customXml: els.customXmlEditor.value })
        }).then(r => r.json()).then(() => {
          showToast(`Simulator mode changed to: ${mode.toUpperCase()}`, 'success');
          refreshDashboardData();
        });
      });
    });

    // Save Custom XML
    els.btnSaveXmlSettings.addEventListener('click', () => {
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: currentMode, customXml: els.customXmlEditor.value })
      }).then(r => r.json()).then(() => {
        showToast('XML Settings Saved Successfully', 'success');
      });
    });

    // Snippet Pill Insertion
    els.snippetTags.forEach(pill => {
      pill.addEventListener('click', () => {
        const snippet = pill.dataset.snippet;
        insertAtCursor(els.customXmlEditor, snippet);
      });
    });

    // Copy Webhook URL
    els.copyWebhookBtn.addEventListener('click', () => {
      const url = els.webhookUrlDisplay.textContent;
      navigator.clipboard.writeText(url).then(() => {
        showToast('Webhook URL copied to clipboard!', 'success');
      });
    });

    // Clear Logs
    els.btnClearLogs.addEventListener('click', () => {
      els.eventFeed.innerHTML = '';
      totalEventsCounter = 0;
      els.totalEventsCount.textContent = '0';
      showToast('Event feed cleared', 'success');
    });

    // Quick Test Webhook Button -> Opens Synthetic Dialog
    els.btnQuickTest.addEventListener('click', () => {
      els.simModal.classList.add('open');
    });

    els.closeSimModal.addEventListener('click', () => els.simModal.classList.remove('open'));
    els.btnCancelSim.addEventListener('click', () => els.simModal.classList.remove('open'));

    els.simForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const simSpeechVal = document.getElementById('simSpeech') ? document.getElementById('simSpeech').value.trim() : '';

      const payload = {
        sessionId: document.getElementById('simSessionId').value || `sim-${Date.now()}`,
        isActive: document.getElementById('simIsActive').value,
        direction: document.getElementById('simDirection').value,
        callerNumber: document.getElementById('simCallerNumber').value,
        destinationNumber: document.getElementById('simDestinationNumber').value,
        dtmfDigits: document.getElementById('simDtmfDigits').value,
        simulatedSpeech: simSpeechVal
      };

      fetch('/api/simulate-webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(r => r.json()).then(res => {
        showToast('Simulated event injected into IVR loop', 'success');
        els.simModal.classList.remove('open');
      });
    });

    // Inline Speech to AI Form (Quick Test)
    if (els.speechSimForm) {
      els.speechSimForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const speech = els.simSpeechInput.value.trim();
        if (!speech) return;
        els.simSpeechInput.value = '';

        if (els.aiStatusTicker) {
          els.aiStatusTicker.textContent = '🧠 Groq AI Reasoning...';
        }

        const sid = activeSession ? activeSession.sessionId : `ai-session-${Date.now()}`;

        fetch('/api/simulate-webhook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: sid,
            isActive: '1',
            simulatedSpeech: speech
          })
        }).then(r => r.json()).then(res => {
          showToast('Spoken sentence passed to Groq Voice AI', 'success');
        }).catch(err => {
          console.error(err);
          showToast('Failed to contact AI agent', 'error');
        });
      });
    }

    // Outbound Call Modal
    els.btnOpenOutboundModal.addEventListener('click', () => {
      els.outboundModal.classList.add('open');
    });

    els.closeOutboundModal.addEventListener('click', () => els.outboundModal.classList.remove('open'));
    els.btnCancelOutbound.addEventListener('click', () => els.outboundModal.classList.remove('open'));

    els.outboundForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const to = document.getElementById('outboundTo').value;
      const from = document.getElementById('outboundFrom').value || serverConfig.phoneNumber;
      const sayText = document.getElementById('outboundSayText').value;

      const callActions = sayText ? [{ actionType: 'Say', text: sayText }] : undefined;

      fetch('/api/call', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ to, from, callActions })
      }).then(r => r.json()).then(res => {
        if (res.success) {
          showToast(`Call initiated to ${to}`, 'success');
        } else {
          showToast(`Error: ${res.error || 'Failed to call'}`, 'error');
        }
        els.outboundModal.classList.remove('open');
      }).catch(err => {
        showToast('API request failed', 'error');
      });
    });

    // MoMo Sandbox Test Console Modal & Actions
    if (els.btnOpenMomoModal && els.momoModal) {
      els.btnOpenMomoModal.addEventListener('click', () => {
        els.momoModal.classList.add('open');
      });
      if (els.closeMomoModal) {
        els.closeMomoModal.addEventListener('click', () => els.momoModal.classList.remove('open'));
      }
      if (els.btnCloseMomoModalBottom) {
        els.btnCloseMomoModalBottom.addEventListener('click', () => els.momoModal.classList.remove('open'));
      }

      // Tab Switching
      const tabBtns = document.querySelectorAll('.momo-tab-btn');
      const tabPanes = document.querySelectorAll('.momo-tab-pane');
      tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          tabBtns.forEach(b => b.classList.remove('active'));
          tabPanes.forEach(p => p.style.display = 'none');
          btn.classList.add('active');
          const tabId = btn.getAttribute('data-tab');
          const activePane = document.getElementById(`momoTab${tabId.charAt(0).toUpperCase() + tabId.slice(1)}`);
          if (activePane) activePane.style.display = 'block';
        });
      });

      function displayMomoResponse(res, label) {
        if (els.momoRawResponseArea) {
          els.momoRawResponseArea.value = JSON.stringify(res, null, 2);
        }
        if (els.momoResponseStatusBadge) {
          const isOk = res.success !== false && (res.statusCode === 200 || res.statusCode === 202 || !res.error);
          els.momoResponseStatusBadge.textContent = isOk ? `${res.statusCode || '200'} SUCCESS` : `${res.statusCode || 'ERR'} FAILED`;
          els.momoResponseStatusBadge.style.background = isOk ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)';
          els.momoResponseStatusBadge.style.color = isOk ? '#34d399' : '#f87171';
        }
        if (els.momoFormattedResultBox && els.momoFormattedResultContent) {
          els.momoFormattedResultBox.style.display = 'block';
          if (res.subscriberName) {
            els.momoFormattedResultContent.innerHTML = `<strong>👤 KYC Verified Name:</strong> <span style="color: #38bdf8; font-size: 1rem; font-weight: 700;">${escapeHtml(res.subscriberName)}</span><br><small style="color: #94a3b8;">Gender: ${escapeHtml(res.gender || 'N/A')} | Birthdate: ${escapeHtml(res.birthdate || 'N/A')} | MSISDN: ${escapeHtml(res.msisdn || '')}</small>`;
          } else if (res.availableBalance !== undefined) {
            els.momoFormattedResultContent.innerHTML = `<strong>💰 Available Balance:</strong> <span style="color: #34d399; font-size: 1rem; font-weight: 700;">${escapeHtml(res.availableBalance)} ${escapeHtml(res.currency || '')}</span>`;
          } else if (res.financialTransactionId) {
            els.momoFormattedResultContent.innerHTML = `<strong>💳 Transaction Reference:</strong> <span style="color: #fbbf24; font-size: 1rem; font-weight: 700;">${escapeHtml(res.financialTransactionId)}</span><br><small style="color: #94a3b8;">Status: ${escapeHtml(res.status || 'INITIATED')}</small>`;
          } else {
            els.momoFormattedResultContent.innerHTML = `<span>${escapeHtml(res.promptMessage || res.error || 'Execution finished.')}</span>`;
          }
        }
      }

      // KYC Button Click
      if (els.btnRunMomoKyc) {
        els.btnRunMomoKyc.addEventListener('click', () => {
          const number = els.momoKycPhone ? els.momoKycPhone.value.trim() : '0244123456';
          els.btnRunMomoKyc.disabled = true;
          els.btnRunMomoKyc.textContent = '⏳ Querying Live MTN KYC...';
          fetch('/api/services/mtn/kyc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ number })
          })
            .then(r => r.json())
            .then(res => {
              els.btnRunMomoKyc.disabled = false;
              els.btnRunMomoKyc.textContent = '🔍 Execute Live MoMo KYC Request';
              displayMomoResponse(res, 'KYC');
              showToast(`KYC inquiry complete: ${res.subscriberName || 'Received'}`, res.success ? 'success' : 'error');
            })
            .catch(err => {
              els.btnRunMomoKyc.disabled = false;
              els.btnRunMomoKyc.textContent = '🔍 Execute Live MoMo KYC Request';
              showToast('Request failed', 'error');
            });
        });
      }

      // Balance Button Click
      if (els.btnRunMomoBalance) {
        els.btnRunMomoBalance.addEventListener('click', () => {
          const product = els.momoBalProduct ? els.momoBalProduct.value : 'disbursement';
          els.btnRunMomoBalance.disabled = true;
          els.btnRunMomoBalance.textContent = '⏳ Checking Balance...';
          fetch(`/api/services/mtn/check-balance?product=${product}`)
            .then(r => r.json())
            .then(res => {
              els.btnRunMomoBalance.disabled = false;
              els.btnRunMomoBalance.textContent = '💰 Query Live MoMo Balance';
              displayMomoResponse(res, 'Balance');
              showToast(`Balance inquiry complete: ${res.availableBalance} ${res.currency}`, res.success ? 'success' : 'error');
            })
            .catch(err => {
              els.btnRunMomoBalance.disabled = false;
              els.btnRunMomoBalance.textContent = '💰 Query Live MoMo Balance';
              showToast('Request failed', 'error');
            });
        });
      }

      // Transfer Button Click
      if (els.btnRunMomoTransfer) {
        els.btnRunMomoTransfer.addEventListener('click', () => {
          const number = els.momoTransferPhone ? els.momoTransferPhone.value.trim() : '0244123456';
          const amount = els.momoTransferAmount ? els.momoTransferAmount.value : '10';
          const reference = els.momoTransferRef ? els.momoTransferRef.value : 'Test Transfer';
          els.btnRunMomoTransfer.disabled = true;
          els.btnRunMomoTransfer.textContent = '⏳ Submitting Live Transfer...';
          fetch('/api/services/mtn/send-money', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ number, amount, reference })
          })
            .then(r => r.json())
            .then(res => {
              els.btnRunMomoTransfer.disabled = false;
              els.btnRunMomoTransfer.textContent = '🚀 Initiate Live MoMo Transfer';
              displayMomoResponse(res, 'Transfer');
              showToast(`Transfer response: ${res.status || 'Submitted'}`, res.success ? 'success' : 'error');
            })
            .catch(err => {
              els.btnRunMomoTransfer.disabled = false;
              els.btnRunMomoTransfer.textContent = '🚀 Initiate Live MoMo Transfer';
              showToast('Request failed', 'error');
            });
        });
      }

      // Cashout Button Click
      if (els.btnRunMomoCashout) {
        els.btnRunMomoCashout.addEventListener('click', () => {
          const number = els.momoCashoutPhone ? els.momoCashoutPhone.value.trim() : '0244123456';
          const amount = els.momoCashoutAmount ? els.momoCashoutAmount.value : '10';
          els.btnRunMomoCashout.disabled = true;
          els.btnRunMomoCashout.textContent = '⏳ Submitting Request To Pay...';
          fetch('/api/services/mtn/cash-out', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ number, amount })
          })
            .then(r => r.json())
            .then(res => {
              els.btnRunMomoCashout.disabled = false;
              els.btnRunMomoCashout.textContent = '🏧 Submit Request To Pay (Cash Out)';
              displayMomoResponse(res, 'Cashout');
              showToast(`Cash out response: ${res.status || 'Submitted'}`, res.success ? 'success' : 'error');
            })
            .catch(err => {
              els.btnRunMomoCashout.disabled = false;
              els.btnRunMomoCashout.textContent = '🏧 Submit Request To Pay (Cash Out)';
              showToast('Request failed', 'error');
            });
        });
      }
    }
  }

  /* ==========================================================================
     UTILITIES
     ========================================================================== */
  function showToast(text, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = text;
    els.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function insertAtCursor(textarea, textToInsert) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = textarea.value.substring(0, start);
    const after = textarea.value.substring(end);
    textarea.value = before + textToInsert + after;
    textarea.selectionStart = textarea.selectionEnd = start + textToInsert.length;
    textarea.focus();
  }

  // Initialize
  setupEventListeners();
  connectWebSocket();
})();
