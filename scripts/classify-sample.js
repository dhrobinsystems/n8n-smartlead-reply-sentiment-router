#!/usr/bin/env node
/**
 * n8n-smartlead-reply-sentiment-router :: Offline dry run: classify a webhook payload with the rule engine
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
 * Usage: npm run classify -- samples/smartlead-email-reply.example.json
 * No network calls are made: this runs the same normalisation, rule-based
 * classification and CRM planning that the n8n workflow uses (without the LLM).
 */

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/config');
const { normalizeReplyPayload, classifyByRules, reconcileClassification } = require('../src/sentimentParser');
const { planCrmUpdate } = require('../src/replyRouter');

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run classify -- <payload.json>');
  process.exit(1);
}

const body = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const { config } = loadConfig({ SANDBOX_MODE: 'true' });
const normalized = normalizeReplyPayload(body);
if (!normalized.ok) {
  console.log(JSON.stringify({ decision: 'ignore', reason: normalized.reason }, null, 2));
  process.exit(0);
}
const rules = classifyByRules(normalized.reply);
const classification = reconcileClassification(rules, null, { minConfidence: config.llm.minConfidence });
const plan = planCrmUpdate({
  config,
  reply: normalized.reply,
  classification,
  searchResponse: { results: [{ id: '0', properties: { hubspot_owner_id: '0' } }] }
});

console.log(JSON.stringify({
  platform: normalized.reply.platform,
  leadEmail: normalized.reply.leadEmail.replace(/^(.).*@/, '$1***@'),
  cleanedReply: normalized.reply.replyText,
  rules,
  classification,
  plannedHubSpotProperties: plan.update.properties,
  route: plan.route
}, null, 2));
