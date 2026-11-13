/**
 * n8n-smartlead-reply-sentiment-router :: Environment parsing & validation (SANDBOX_MODE on by default)
 *
 * ⚠️ Disclaimer & Liability Limitation
 * Use at your own risk. The code, workflows, and scripts provided in this repository
 * (n8n-smartlead-reply-sentiment-router) are for educational and architectural
 * demonstration purposes.
 *
 * - No Liability: The author and dhRobin Systems assume no responsibility or liability for
 *   any direct, indirect, incidental, or consequential damages resulting from the use,
 *   misuse, or deployment of these scripts.
 * - No Warranty: All software, n8n JSON blueprints, and JavaScript modules are provided "AS
 *   IS" without warranty of any kind, express or implied, including but not limited to
 *   merchantability, fitness for a particular purpose, or non-infringement.
 * - Production Testing Required: Always test thoroughly in an isolated staging environment
 *   with SANDBOX_MODE=true enabled before connecting live HubSpot, Slack, Twilio,
 *   Smartlead, Instantly, or LLM provider credentials.
 * - Third-Party APIs & Compliance: Users are solely responsible for complying with the
 *   terms of service, rate limits, data privacy regulations (GDPR/CCPA), anti-spam laws
 *   (e.g. CAN-SPAM, CASL, PECR), and security policies of HubSpot, Slack, Twilio,
 *   Smartlead, Instantly, and any connected LLM providers, including honouring every
 *   unsubscribe request.
 *
 * Full text: DISCLAIMER.md | License: MIT (see LICENSE)
 * Copyright (c) 2026 DH Robin (dhRobin Systems) - https://dhrobinsystems.com
 */
'use strict';

/**
 * Pure configuration module: callers pass a plain env object, so the same
 * code runs in n8n Code nodes ($env) and in Node.js tests (process.env).
 */

const CONFIG_ENV_KEYS = Object.freeze([
  'SANDBOX_MODE', 'WEBHOOK_SHARED_TOKEN', 'SMARTLEAD_WEBHOOK_SECRET', 'ACCEPTED_PLATFORMS', 'DEDUPE_TTL_HOURS',
  'LLM_PROVIDER', 'LLM_MODEL', 'LLM_MAX_TOKENS', 'LLM_MIN_CONFIDENCE', 'LLM_IN_SANDBOX',
  'HUBSPOT_PORTAL_ID', 'HUBSPOT_LEAD_STATUS_MAP', 'HUBSPOT_WRITE_SENTIMENT_PROPERTIES', 'HUBSPOT_DNC_PROPERTY', 'NOTE_REPLY_EXCERPT_CHARS',
  'HOT_LEAD_MIN_CONFIDENCE', 'SLACK_HOT_LEADS_CHANNEL', 'SLACK_REVIEW_CHANNEL', 'SLACK_DM_OWNERS',
  'SMS_ENABLED', 'TWILIO_ACCOUNT_SID', 'TWILIO_FROM_NUMBER', 'OWNER_SMS_MAP'
]);

/** HubSpot default lead-status option values (hs_lead_status). null = leave unchanged. */
const DEFAULT_LEAD_STATUS_MAP = Object.freeze({
  positive: 'IN_PROGRESS',
  neutral: 'CONNECTED',
  objection: 'BAD_TIMING',
  out_of_office: null,
  unsubscribe: 'UNQUALIFIED'
});

const SENTIMENT_PROPERTY_NAMES = Object.freeze({
  category: 'last_reply_sentiment',
  confidence: 'last_reply_sentiment_confidence',
  receivedAt: 'last_reply_received_at'
});

const CHANNEL_REF = /^([CG][A-Z0-9]{6,}|#[a-z0-9][a-z0-9._-]{0,79})$/;
const E164 = /^\+[1-9]\d{7,14}$/;

function parseFlag(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return null;
}

function parseNumberSetting(raw, fallback, min, max, name, errors) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    errors.push(name + ' must be a number between ' + min + ' and ' + max + '.');
    return fallback;
  }
  return n;
}

function parseJsonSetting(raw, fallback, name, errors) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch (error) {
    errors.push(name + ' must be a JSON object.');
    return fallback;
  }
}

/**
 * Copy only known keys from an env-like source. n8n's $env proxy throws when
 * N8N_BLOCK_ENV_ACCESS_IN_NODE=true; in that case defaults apply (sandbox ON).
 */
function snapshotEnv(source) {
  const env = {};
  let blocked = false;
  if (!source) return { env, blocked };
  for (const key of CONFIG_ENV_KEYS) {
    try {
      const value = source[key];
      if (value !== undefined && value !== null) env[key] = String(value);
    } catch (error) {
      blocked = true;
    }
  }
  return { env, blocked };
}

/**
 * @returns {{config:object, errors:string[], warnings:string[], ok:boolean}}
 */
function loadConfig(env) {
  const e = env || {};
  const read = (k) => (e[k] === undefined || e[k] === null ? '' : String(e[k]).trim());
  const errors = [];
  const warnings = [];

  let sandboxMode = parseFlag(read('SANDBOX_MODE'), true);
  if (sandboxMode === null) {
    errors.push('SANDBOX_MODE must be true or false; sandbox stays ENABLED.');
    sandboxMode = true;
  }

  const acceptedPlatforms = (read('ACCEPTED_PLATFORMS') || 'smartlead,instantly').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of acceptedPlatforms) if (!['smartlead', 'instantly'].includes(p)) errors.push('ACCEPTED_PLATFORMS contains unknown platform "' + p + '".');

  const llmProvider = (read('LLM_PROVIDER') || 'none').toLowerCase();
  if (!['none', 'openai', 'anthropic'].includes(llmProvider)) errors.push('LLM_PROVIDER must be none, openai or anthropic.');
  const llmModel = read('LLM_MODEL');
  if (llmProvider !== 'none' && !llmModel) errors.push('LLM_MODEL is required when LLM_PROVIDER is "' + llmProvider + '".');
  const llmInSandbox = parseFlag(read('LLM_IN_SANDBOX'), false);
  if (llmInSandbox === null) errors.push('LLM_IN_SANDBOX must be true or false.');

  const leadStatusOverrides = parseJsonSetting(read('HUBSPOT_LEAD_STATUS_MAP'), {}, 'HUBSPOT_LEAD_STATUS_MAP', errors);
  const leadStatusMap = Object.assign({}, DEFAULT_LEAD_STATUS_MAP);
  for (const [category, value] of Object.entries(leadStatusOverrides)) {
    if (!(category in DEFAULT_LEAD_STATUS_MAP)) errors.push('HUBSPOT_LEAD_STATUS_MAP has unknown category "' + category + '".');
    else if (value !== null && !/^[A-Z0-9_]{1,64}$/.test(String(value))) errors.push('HUBSPOT_LEAD_STATUS_MAP value for ' + category + ' must be an internal option value (e.g. IN_PROGRESS) or null.');
    else leadStatusMap[category] = value;
  }

  const writeSentimentProperties = parseFlag(read('HUBSPOT_WRITE_SENTIMENT_PROPERTIES'), true);
  if (writeSentimentProperties === null) errors.push('HUBSPOT_WRITE_SENTIMENT_PROPERTIES must be true or false.');
  const dncProperty = read('HUBSPOT_DNC_PROPERTY');
  if (dncProperty && !/^[a-z][a-z0-9_]{0,99}$/.test(dncProperty)) errors.push('HUBSPOT_DNC_PROPERTY must be a HubSpot internal property name.');
  const portalId = read('HUBSPOT_PORTAL_ID');
  if (portalId && !/^\d{1,20}$/.test(portalId)) errors.push('HUBSPOT_PORTAL_ID must be numeric.');

  const hotLeadsChannel = read('SLACK_HOT_LEADS_CHANNEL') || '#hot-leads';
  const reviewChannel = read('SLACK_REVIEW_CHANNEL') || '#reply-review';
  for (const [name, value] of [['SLACK_HOT_LEADS_CHANNEL', hotLeadsChannel], ['SLACK_REVIEW_CHANNEL', reviewChannel]]) {
    if (!CHANNEL_REF.test(value)) errors.push(name + ' must be a channel ID (C0123ABCD) or #channel-name.');
  }
  const dmOwners = parseFlag(read('SLACK_DM_OWNERS'), true);
  if (dmOwners === null) errors.push('SLACK_DM_OWNERS must be true or false.');

  const smsEnabled = parseFlag(read('SMS_ENABLED'), false);
  if (smsEnabled === null) errors.push('SMS_ENABLED must be true or false.');
  const twilioSid = read('TWILIO_ACCOUNT_SID');
  const twilioFrom = read('TWILIO_FROM_NUMBER');
  const ownerSmsMap = parseJsonSetting(read('OWNER_SMS_MAP'), {}, 'OWNER_SMS_MAP', errors);
  for (const [ownerId, phone] of Object.entries(ownerSmsMap)) {
    if (!/^\d{1,20}$/.test(ownerId) || !E164.test(String(phone))) errors.push('OWNER_SMS_MAP entries must map numeric HubSpot owner IDs to E.164 numbers.');
  }
  if (smsEnabled) {
    if (!/^AC[a-f0-9]{32}$/i.test(twilioSid)) errors.push('TWILIO_ACCOUNT_SID must look like AC followed by 32 hex characters when SMS_ENABLED=true.');
    if (!E164.test(twilioFrom)) errors.push('TWILIO_FROM_NUMBER must be an E.164 number when SMS_ENABLED=true.');
  }

  const sharedToken = read('WEBHOOK_SHARED_TOKEN');
  if (sharedToken && sharedToken.length < 24) errors.push('WEBHOOK_SHARED_TOKEN must be at least 24 characters.');
  if (!sandboxMode && !sharedToken) errors.push('WEBHOOK_SHARED_TOKEN is required when SANDBOX_MODE=false.');
  if (sandboxMode) {
    warnings.push('SANDBOX_MODE is enabled: no HubSpot writes, owner alerts or SMS; previews go to ' + reviewChannel + '.');
    if (!sharedToken) warnings.push('WEBHOOK_SHARED_TOKEN is not set: the sandbox webhook accepts unauthenticated requests.');
  }

  const config = {
    sandboxMode,
    webhook: {
      sharedToken,
      smartleadSecret: read('SMARTLEAD_WEBHOOK_SECRET'),
      acceptedPlatforms,
      dedupeTtlMs: parseNumberSetting(read('DEDUPE_TTL_HOURS'), 72, 1, 720, 'DEDUPE_TTL_HOURS', errors) * 3600 * 1000
    },
    llm: {
      provider: llmProvider,
      model: llmModel,
      maxTokens: parseNumberSetting(read('LLM_MAX_TOKENS'), 300, 50, 4000, 'LLM_MAX_TOKENS', errors),
      minConfidence: parseNumberSetting(read('LLM_MIN_CONFIDENCE'), 0.6, 0, 1, 'LLM_MIN_CONFIDENCE', errors),
      inSandbox: llmInSandbox === true
    },
    hubspot: {
      portalId,
      leadStatusMap,
      writeSentimentProperties: writeSentimentProperties !== false,
      sentimentProperties: Object.assign({}, SENTIMENT_PROPERTY_NAMES),
      dncProperty,
      noteExcerptChars: parseNumberSetting(read('NOTE_REPLY_EXCERPT_CHARS'), 500, 0, 5000, 'NOTE_REPLY_EXCERPT_CHARS', errors)
    },
    routing: {
      hotLeadMinConfidence: parseNumberSetting(read('HOT_LEAD_MIN_CONFIDENCE'), 0.75, 0, 1, 'HOT_LEAD_MIN_CONFIDENCE', errors),
      hotLeadsChannel,
      reviewChannel,
      dmOwners: dmOwners !== false
    },
    sms: {
      enabled: smsEnabled === true,
      twilioAccountSid: twilioSid,
      fromNumber: twilioFrom,
      ownerNumbers: ownerSmsMap
    }
  };
  return { config, errors, warnings, ok: errors.length === 0 };
}

function requireValidConfig(env) {
  const result = loadConfig(env);
  if (!result.ok) throw new Error('Invalid configuration:\n - ' + result.errors.join('\n - '));
  return result;
}

/** Copy safe to emit into n8n execution data: secrets and phone numbers removed. */
function redactConfig(config) {
  const copy = JSON.parse(JSON.stringify(config));
  copy.webhook.sharedToken = copy.webhook.sharedToken ? '[REDACTED]' : '';
  copy.webhook.smartleadSecret = copy.webhook.smartleadSecret ? '[REDACTED]' : '';
  copy.sms.ownerNumbers = Object.keys(copy.sms.ownerNumbers).length + ' owner(s) configured';
  return copy;
}

module.exports = {
  CONFIG_ENV_KEYS,
  DEFAULT_LEAD_STATUS_MAP,
  SENTIMENT_PROPERTY_NAMES,
  snapshotEnv,
  loadConfig,
  requireValidConfig,
  redactConfig
};
