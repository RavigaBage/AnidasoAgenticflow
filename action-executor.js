/**
 * Action Executor for Agentic Actions (agentic_action.json)
 * Executes live MTN MoMo Sandbox API requests when the AI agent gathers required data.
 * Zero mock data — returns 100% real responses from MTN MoMo endpoints.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const momoService = require('./momo-api');

class ActionExecutor {
  constructor() {
    this.actionsConfigPath = path.join(__dirname, 'agentic_action.json');
    this.scriptPath = path.join(__dirname, 'services_script', 'mtn_momo_ivr_script.json');
    this.loadConfigs();
  }

  loadConfigs() {
    try {
      if (fs.existsSync(this.actionsConfigPath)) {
        this.actionsConfig = JSON.parse(fs.readFileSync(this.actionsConfigPath, 'utf8'));
      } else {
        this.actionsConfig = { send_money_mtn: "", check_balance_mtn: "", cash_out_mtn: "", verify_kyc_mtn: "" };
      }

      if (fs.existsSync(this.scriptPath)) {
        this.ivrScript = JSON.parse(fs.readFileSync(this.scriptPath, 'utf8'));
      }
    } catch (e) {
      console.warn('[ActionExecutor] Error loading configs:', e.message);
    }
  }

  /**
   * Return tool definitions for Groq / OpenAI function calling
   */
  getTools() {
    return [
      {
        type: "function",
        function: {
          name: "verify_kyc_mtn",
          description: "Verify subscriber registered name on MTN Mobile Money. Call ONLY when a 10-digit phone number has been provided by the caller. NEVER call with an empty, missing, or placeholder number.",
          parameters: {
            type: "object",
            properties: {
              number: {
                type: "string",
                description: "10-digit mobile number explicitly spoken by caller."
              },
              stated_name: {
                type: "string",
                description: "Name caller mentioned. Optional."
              }
            },
            required: ["number"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "send_money_mtn",
          description: "Execute MTN MoMo transfer only after KYC is verified and the caller says approves, approval can be in the form 'yes, send' in direct response to the final read-back.",
          parameters: {
            type: "object",
            properties: {
              number: {
                type: "string",
                description: "Recipient 10-digit mobile phone number explicitly spoken by the caller for the transfer."
              },
              network: {
                type: "string",
                enum: ["MTN", "Telecel", "AirtelTigo", "Other"],
                description: "Recipient network operator"
              },
              amount: {
                type: "number",
                description: "Amount to send in Ghana Cedis (GHS)"
              },
              reference: {
                type: "string",
                description: "Reference note or the spoken value 'no reference' if the caller gave none"
              },
              registered_name: {
                type: "string",
                description: "The official registered KYC name returned by verify_kyc_mtn"
              },
              confirm: {
                type: "boolean",
                description: "True only after the caller says 'yes, send' in direct response to the final read-back"
              }
            },
            required: ["number", "network", "amount", "reference", "registered_name", "confirm"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "check_balance_mtn",
          description: "Trigger MTN Mobile Money balance enquiry for a caller or merchant account.",
          parameters: {
            type: "object",
            properties: {
              number: {
                type: "string",
                description: "Caller mobile phone number to check balance for"
              }
            },
            required: ["number"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "cash_out_mtn",
          description: "Initiate an MTN Mobile Money cash-out / withdrawal guidance once caller confirms.",
          parameters: {
            type: "object",
            properties: {
              amount: {
                type: "number",
                description: "Amount to cash out in Ghana Cedis"
              },
              number: {
                type: "string",
                description: "Caller mobile phone number"
              },
              cash_out_confirmation: {
                type: "boolean",
                description: "True if caller confirms they want to proceed with withdrawal"
              }
            },
            required: ["cash_out_confirmation"]
          }
        }
      }
    ];
  }

  /**
   * Execute action based on action name and parameters
   */
  async execute(actionName, params = {}, sessionId = 'unknown') {
    this.loadConfigs();
    const timestamp = new Date().toISOString();

    console.log(`\n======================================================`);
    console.log(`⚡ [AGENTIC ACTION TRIGGERED] ${timestamp}`);
    console.log(`Action Name : ${actionName}`);
    console.log(`Session ID  : ${sessionId}`);
    console.log(`Parameters  :`, params);
    console.log(`======================================================\n`);

    switch (actionName) {
      case 'verify_kyc_mtn': {
        const { number, stated_name } = params;
        const cleanNumber = String(number || '').replace(/\D/g, '');
        if (!cleanNumber || cleanNumber.length < 9) {
          return {
            success: false,
            action: actionName,
            phoneNumber: number || '',
            statedName: stated_name || null,
            error: 'Missing recipient phone number. A 10-digit phone number is required before KYC verification.',
            promptMessage: stated_name
              ? `What is ${stated_name}'s phone number?`
              : 'What is the recipient phone number you would like to send money to?'
          };
        }

        const momoRes = await momoService.getBasicUserInfo(number, 'collection');

        let nameMatch = null;
        let discrepancyWarning = null;

        if (momoRes.success && stated_name) {
          const cleanStated = String(stated_name).toLowerCase().replace(/[^a-z0-9]/g, '');
          const cleanRegistered = (momoRes.subscriberName || '').toLowerCase().replace(/[^a-z0-9]/g, '');

          const statedWords = String(stated_name).toLowerCase().split(/\s+/).filter(w => w.length > 2);
          const registeredWords = (momoRes.subscriberName || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
          const hasCommonWord = statedWords.some(w => registeredWords.includes(w));

          if (hasCommonWord || (cleanStated && cleanRegistered && cleanStated === cleanRegistered)) {
            nameMatch = true;
          } else {
            nameMatch = false;
            discrepancyWarning = `NAME DISCREPANCY DETECTED: Caller stated recipient name is "${stated_name}", but this phone number (${number}) is officially registered to "${momoRes.subscriberName}" on Mobile Money.`;
          }
        }

        return {
          ...momoRes,
          action: actionName,
          statedName: stated_name || null,
          nameMatch,
          discrepancyWarning,
          promptMessage: !momoRes.success
            ? `I could not find an active Mobile Money account for ${number}. Please verify the number and try again.`
            : discrepancyWarning
              ? `The phone number ${number} is registered to ${momoRes.subscriberName} on Mobile Money, not ${stated_name}.`
              : `The phone number ${number} is officially registered to ${momoRes.subscriberName} on Mobile Money.`
        };
      }

      case 'send_money_mtn': {
        const { number, network = 'MTN', amount, reference = 'No reference', registered_name, confirm } = params;

        if (!confirm) {
          return {
            success: false,
            action: actionName,
            error: 'Transaction was not confirmed by the caller. Please request explicit confirmation before executing transfer.',
            requiresConfirmation: true
          };
        }

        if (!registered_name) {
          return {
            success: false,
            action: actionName,
            error: 'Recipient was not verified via KYC. You must verify the recipient with verify_kyc_mtn first and disclose the registered name before initiating.',
            requiresConfirmation: true
          };
        }

        const cleanRef = reference && String(reference).trim() ? String(reference).trim() : 'Transfer';
        const momoRes = await momoService.sendMoney({
          amount,
          number,
          reference: cleanRef,
          payerMessage: `MoMo voice transfer to ${number}`
        });

        return {
          ...momoRes,
          action: actionName,
          details: {
            ...momoRes.details,
            network,
            registeredName: registered_name || momoRes.details?.registeredName || null
          }
        };
      }

      case 'check_balance_mtn': {
        const { number } = params;
        const momoRes = await momoService.checkBalance('disbursement');
        return {
          ...momoRes,
          action: actionName,
          targetNumber: number || 'Caller line'
        };
      }

      case 'cash_out_mtn': {
        const { amount, number, cash_out_confirmation } = params;

        // SECURITY GUARD: never execute a withdrawal without explicit caller confirmation
        if (!cash_out_confirmation) {
          return {
            success: false,
            action: actionName,
            error: 'Cash out was not confirmed by the caller. Please request explicit confirmation before executing a withdrawal.',
            requiresConfirmation: true
          };
        }

        const momoRes = await momoService.withdrawCash({
          amount,
          number,
          note: 'Cash Out Withdrawal'
        });

        return {
          ...momoRes,
          action: actionName
        };
      }

      default: {
        return {
          success: false,
          action: actionName,
          error: `Unrecognized action ${actionName}`
        };
      }
    }
  }
}

module.exports = new ActionExecutor();
