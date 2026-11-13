/**
 * n8n-smartlead-reply-sentiment-router :: Config, webhook verification, de-duplication, CRM plan, Slack/SMS payloads
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

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const r = require('../src/replyRouter');
const { loadConfig, redactConfig, snapshotEnv } = require('../src/config');
const { LIVE_ENV, TOKEN } = require('./harness');

const hmac = (secret, message) => crypto.createHmac('sha256', secret).update(message, 'utf8').digest('hex');
const REPLY = { platform: 'smartlead', leadEmail: 'jane.doe@example.com', leadName: 'Jane Doe', leadFirstName: 'Jane', companyName: 'Example Co', campaignId: '1', campaignName: 'Sample', subject: 'Re: hi', repliedAt: '2026-11-12T00:00:00Z', replyText: 'Sounds great, <!channel> let\'s talk', inboxUrl: '', messageId: '' };
const POSITIVE = { category: 'positive', confidence: 0.9, source: 'llm', needsReview: false, meetingIntent: true, reason: 'Wants a call' };
const FOUND = { results: [{ id: '501', properties: { hubspot_owner_id: '77' } }] };
const liveConfig = (extra) => loadConfig(Object.assign({}, LIVE_ENV, extra || {})).config;

test('config: sandbox by default; unparseable values keep sandbox on', () => {
  assert.equal(loadConfig({}).config.sandboxMode, true);
  const bad = loadConfig({ SANDBOX_MODE: 'flase' });
  assert.equal(bad.config.sandboxMode, true);
  assert.equal(bad.ok, false);
});

test('config: live mode requires a strong shared token; LLM provider requires a model', () => {
  assert.ok(loadConfig({ SANDBOX_MODE: 'false' }).errors.some((e) => /WEBHOOK_SHARED_TOKEN is required/.test(e)));
  assert.ok(loadConfig({ WEBHOOK_SHARED_TOKEN: 'short' }).errors.some((e) => /24 characters/.test(e)));
  assert.ok(loadConfig({ LLM_PROVIDER: 'openai' }).errors.some((e) => /LLM_MODEL/.test(e)));
  assert.deepEqual(loadConfig(LIVE_ENV).errors, []);
});

test('config: lead-status map overrides are validated', () => {
  const ok = loadConfig({ HUBSPOT_LEAD_STATUS_MAP: '{"positive":"OPEN_DEAL","out_of_office":null}' });
  assert.equal(ok.config.hubspot.leadStatusMap.positive, 'OPEN_DEAL');
  assert.ok(loadConfig({ HUBSPOT_LEAD_STATUS_MAP: '{"happy":"X"}' }).errors.some((e) => /unknown category/.test(e)));
  assert.ok(loadConfig({ HUBSPOT_LEAD_STATUS_MAP: '{"positive":"open deal"}' }).errors.some((e) => /internal option value/.test(e)));
  assert.ok(loadConfig({ HUBSPOT_LEAD_STATUS_MAP: 'not json' }).errors.some((e) => /JSON object/.test(e)));
});

test('config: SMS settings validated only when enabled; redaction hides secrets and phone numbers', () => {
  assert.ok(loadConfig({ SMS_ENABLED: 'true' }).errors.some((e) => /TWILIO_ACCOUNT_SID/.test(e)));
  assert.ok(loadConfig({ OWNER_SMS_MAP: '{"77":"555-0100"}' }).errors.some((e) => /E.164/.test(e)));
  const { config } = loadConfig(Object.assign({}, LIVE_ENV, { OWNER_SMS_MAP: '{"77":"+15550100001"}' }));
  const redacted = JSON.stringify(redactConfig(config));
  assert.ok(!redacted.includes(TOKEN));
  assert.ok(!redacted.includes('+15550100001'));
});

test('config: blocked $env access falls back to sandbox defaults', () => {
  const snap = snapshotEnv(new Proxy({}, { get() { throw new Error('denied'); } }));
  assert.equal(snap.blocked, true);
  assert.equal(loadConfig(snap.env).config.sandboxMode, true);
});

test('webhook: shared token via header, bearer or query; mismatches and missing tokens rejected', () => {
  assert.equal(r.verifySharedToken({ expected: TOKEN, headers: { 'X-Webhook-Token': TOKEN } }).valid, true);
  assert.equal(r.verifySharedToken({ expected: TOKEN, headers: { authorization: 'Bearer ' + TOKEN } }).valid, true);
  assert.equal(r.verifySharedToken({ expected: TOKEN, query: { token: TOKEN } }).valid, true);
  assert.equal(r.verifySharedToken({ expected: TOKEN, query: { token: 'nope' } }).reason, 'token_mismatch');
  assert.equal(r.verifySharedToken({ expected: TOKEN }).reason, 'missing_token');
  assert.equal(r.verifySharedToken({ expected: '', required: true }).reason, 'token_not_configured');
  assert.equal(r.verifySharedToken({ expected: '', required: false }).valid, true);
});

test('webhook: Smartlead HMAC signature (with or without sha256= prefix)', () => {
  const body = '{"event_type":"EMAIL_REPLY"}';
  const sig = hmac('secret', body);
  const check = (signature, raw) => r.verifySmartleadSignature({ secret: 'secret', rawBody: raw || body, signature, hmacSha256Hex: hmac });
  assert.equal(check('sha256=' + sig).valid, true);
  assert.equal(check(sig).valid, true);
  assert.equal(check('sha256=' + sig, '{"tampered":1}').reason, 'signature_mismatch');
  assert.equal(check('').reason, 'missing_signature');
  assert.equal(r.verifySmartleadSignature({ secret: '' }).valid, true);
});

test('dedupe: key is deterministic, contains no email, and the ledger expires entries', () => {
  const key = r.buildDedupeKey(REPLY);
  assert.equal(key, r.buildDedupeKey(Object.assign({}, REPLY)));
  assert.match(key, /^rpl-[a-f0-9]{16}$/);
  assert.notEqual(key, r.buildDedupeKey(Object.assign({}, REPLY, { replyText: 'different' })));
  const ledger = {};
  assert.equal(r.registerDelivery(ledger, key, 1000, 500).duplicate, false);
  assert.equal(r.registerDelivery(ledger, key, 1200, 500).duplicate, true);
  assert.equal(r.registerDelivery(ledger, key, 1600, 500).duplicate, false);
  assert.ok(!JSON.stringify(ledger).includes('@'));
});

test('crm plan: matched contact gets lead status, sentiment properties and a note', () => {
  const plan = r.planCrmUpdate({ config: liveConfig(), reply: REPLY, classification: POSITIVE, searchResponse: FOUND, nowIso: '2026-11-12T00:00:00.000Z' });
  assert.equal(plan.contactId, '501');
  assert.equal(plan.ownerId, '77');
  assert.deepEqual(plan.update.properties, { hs_lead_status: 'IN_PROGRESS', last_reply_sentiment: 'positive', last_reply_sentiment_confidence: '0.90', last_reply_received_at: '2026-11-12T00:00:00.000Z' });
  assert.equal(plan.note.associations[0].types[0].associationTypeId, 202);
  assert.ok(!plan.note.properties.hs_note_body.includes('<!channel>'), 'note HTML is escaped');
  assert.equal(plan.contactUrl, 'https://app.hubspot.com/contacts/12345678/record/0-1/501');
  assert.equal(plan.route.hotLead, true);
});

test('crm plan: unsubscribe sets UNQUALIFIED + optional DNC flag; out_of_office leaves status untouched', () => {
  const unsub = r.planCrmUpdate({ config: liveConfig({ HUBSPOT_DNC_PROPERTY: 'outbound_do_not_contact' }), reply: REPLY, classification: { category: 'unsubscribe', confidence: 0.95, source: 'rules', needsReview: false }, searchResponse: FOUND });
  assert.equal(unsub.update.properties.hs_lead_status, 'UNQUALIFIED');
  assert.equal(unsub.update.properties.outbound_do_not_contact, 'true');
  assert.equal(unsub.route.unsubscribe, true);
  const ooo = r.planCrmUpdate({ config: liveConfig(), reply: REPLY, classification: { category: 'out_of_office', confidence: 0.95, source: 'rules', needsReview: false }, searchResponse: FOUND });
  assert.equal(ooo.update.properties.hs_lead_status, undefined);
});

test('crm plan: no contact found means no note and a review route', () => {
  const plan = r.planCrmUpdate({ config: liveConfig(), reply: REPLY, classification: POSITIVE, searchResponse: { results: [] } });
  assert.equal(plan.contactFound, false);
  assert.equal(plan.note, null);
  assert.equal(plan.route.needsReview, true);
});

test('crm plan: hot-lead routing respects confidence and review flags; SMS needs a mapped owner', () => {
  const cfg = liveConfig({ HOT_LEAD_MIN_CONFIDENCE: '0.95' });
  assert.equal(r.planCrmUpdate({ config: cfg, reply: REPLY, classification: POSITIVE, searchResponse: FOUND }).route.hotLead, false);
  assert.equal(r.planCrmUpdate({ config: liveConfig(), reply: REPLY, classification: Object.assign({}, POSITIVE, { needsReview: true }), searchResponse: FOUND }).route.hotLead, false);
  const smsCfg = liveConfig({ SMS_ENABLED: 'true', TWILIO_ACCOUNT_SID: 'AC' + '0'.repeat(32), TWILIO_FROM_NUMBER: '+15550100000', OWNER_SMS_MAP: '{"77":"+15550100001"}' });
  assert.equal(r.planCrmUpdate({ config: smsCfg, reply: REPLY, classification: POSITIVE, searchResponse: FOUND }).route.smsRecipient, '+15550100001');
  const unmapped = { results: [{ id: '502', properties: { hubspot_owner_id: '99' } }] };
  assert.equal(r.planCrmUpdate({ config: smsCfg, reply: REPLY, classification: POSITIVE, searchResponse: unmapped }).route.smsRecipient, '');
});

test('slack: hot-lead alert escapes reply text and mentions the owner', () => {
  const msg = r.buildHotLeadAlert({ channel: 'U0OWNER01', reply: REPLY, classification: POSITIVE, ownerSlackId: 'U0OWNER01', contactUrl: 'https://app.hubspot.com/contacts/1/record/0-1/2' });
  const text = JSON.stringify(msg.blocks);
  assert.ok(!text.includes('<!channel>'));
  assert.match(text, /&lt;!channel&gt;/);
  assert.match(text, /<@U0OWNER01>/);
  assert.match(text, /Open HubSpot contact/);
});

test('slack: review alert explains why; sandbox preview lists the would-be actions', () => {
  const review = r.buildReviewAlert({ channel: '#reply-review', reply: REPLY, classification: { category: 'unsubscribe', confidence: 0.95, source: 'rules', needsReview: false }, contactFound: false });
  assert.match(JSON.stringify(review), /suppress this address/);
  assert.match(JSON.stringify(review), /No HubSpot contact matched/);
  const preview = r.buildSandboxPreview({ channel: '#reply-review', reply: REPLY, classification: POSITIVE, plannedProperties: { hs_lead_status: 'IN_PROGRESS' }, hotLeadMinConfidence: 0.75, hotLeadsChannel: '#hot-leads', smsEnabled: true, llmStatus: 'ok' });
  assert.match(preview.text, /^\[SANDBOX\]/);
  assert.match(JSON.stringify(preview), /DM the HubSpot owner.*SMS/);
});

test('sms: body fits 160 chars and never includes the reply text or email', () => {
  const body = r.buildSmsBody({ reply: Object.assign({}, REPLY, { companyName: 'C'.repeat(300) }) });
  assert.ok(body.length <= 160);
  assert.ok(!body.includes('talk'));
  assert.ok(!body.includes('@'));
});
