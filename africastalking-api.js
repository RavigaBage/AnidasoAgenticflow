/**
 * Africa's Talking Voice API Client
 * Facilitates outbound calls (/call) and call transfers (/callTransfer).
 */

const axios = require('axios');

class AfricaTalkingService {
  constructor() {
    this.reloadConfig();
  }

  reloadConfig() {
    this.username = process.env.AT_USERNAME || 'sandbox';
    this.apiKey = process.env.AT_API_KEY || '';
    this.phoneNumber = process.env.AT_PHONE_NUMBER || '+254711082000';
    this.voiceUrl = process.env.AT_VOICE_URL || 'https://voice.africastalking.com/call';
    this.transferUrl = process.env.AT_TRANSFER_URL || 'https://voice.africastalking.com/callTransfer';
  }

  getConfigSummary() {
    this.reloadConfig();
    return {
      username: this.username,
      phoneNumber: this.phoneNumber,
      voiceUrl: this.voiceUrl,
      transferUrl: this.transferUrl,
      hasApiKey: Boolean(this.apiKey && this.apiKey !== 'your_africastalking_api_key_here')
    };
  }

  /**
   * Make an outbound call through Africa's Talking Voice API
   * POST https://voice.africastalking.com/call
   *
   * @param {Object} options
   * @param {string} options.to Comma-separated recipient phone numbers (+XXXYYYYY)
   * @param {string} [options.from] Africa's Talking phone number
   * @param {string} [options.clientRequestId] Optional tracking ID
   * @param {Array}  [options.callActions] Optional list of call actions (Say, Play, Dial)
   */
  async makeCall({ to, from, clientRequestId, callActions }) {
    this.reloadConfig();

    if (!this.apiKey || this.apiKey === 'your_africastalking_api_key_here') {
      throw new Error('AT_API_KEY is not configured in .env. Please provide a valid Africa\'s Talking API key.');
    }

    const senderNumber = from || this.phoneNumber;
    const callerUsername = this.username;

    const requestData = new URLSearchParams();
    requestData.append('username', callerUsername);
    requestData.append('from', senderNumber);
    requestData.append('to', to);

    if (clientRequestId) {
      requestData.append('clientRequestId', clientRequestId);
    }

    if (callActions && Array.isArray(callActions) && callActions.length > 0) {
      requestData.append('callActions', JSON.stringify(callActions));
    }

    try {
      const response = await axios.post(this.voiceUrl, requestData.toString(), {
        headers: {
          'apiKey': this.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        timeout: 15000
      });

      return {
        success: true,
        data: response.data,
        status: response.status
      };
    } catch (error) {
      const responseData = error.response ? error.response.data : null;
      const status = error.response ? error.response.status : 500;
      const message = error.response?.data?.errorMessage || error.message || 'Call request failed';

      return {
        success: false,
        error: message,
        status,
        details: responseData
      };
    }
  }

  /**
   * Transfer an ongoing call leg to another phone number
   * POST https://voice.africastalking.com/callTransfer
   *
   * @param {Object} options
   * @param {string} options.sessionId Session ID of ongoing call
   * @param {string} options.phoneNumber Recipient phone number
   * @param {string} [options.callLeg] 'caller' or 'callee' (default: callee)
   * @param {string} [options.holdMusicUrl] Music url while waiting
   */
  async transferCall({ sessionId, phoneNumber, callLeg = 'callee', holdMusicUrl }) {
    this.reloadConfig();

    if (!this.apiKey || this.apiKey === 'your_africastalking_api_key_here') {
      throw new Error('AT_API_KEY is not configured in .env.');
    }

    const requestData = new URLSearchParams();
    requestData.append('sessionId', sessionId);
    requestData.append('phoneNumber', phoneNumber);
    requestData.append('callLeg', callLeg);

    if (holdMusicUrl) {
      requestData.append('holdMusicUrl', holdMusicUrl);
    }

    try {
      const response = await axios.post(this.transferUrl, requestData.toString(), {
        headers: {
          'apiKey': this.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/xml, text/xml, application/json'
        },
        timeout: 15000
      });

      return {
        success: true,
        data: response.data,
        status: response.status
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data || error.message || 'Call transfer failed',
        status: error.response ? error.response.status : 500
      };
    }
  }
}

module.exports = new AfricaTalkingService();
