/**
 * n8n-smartlead-reply-sentiment-router :: workflow.json integrity, sandbox gating and Code-node execution
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
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runChecks, reachableInSandbox } = require('../scripts/build-workflow');
const { ROOT, TOKEN, SANDBOX_ENV, LIVE_ENV, loadWorkflow, loadSample, getNode, runCodeNode, webhookItem } = require('./harness');

const wf = loadWorkflow();
const WEBHOOK = 'Reply Webhook (Smartlead / Instantly)';

async function verify(body, opts) {
  const o = opts || {};
  return (await runCodeNode(wf, 'Verify & Normalize Reply', {
    env: o.env || SANDBOX_ENV,
    staticData: o.staticData || {},
    rawBody: o.rawBody,
    input: o.rawBody !== undefined ? [{ json: {}, binary: { data: {} } }] : [{ json: {} }],
    nodeOutputs: { [WEBHOOK]: webhookItem(body, o.headers, o.query) }
  }))[0].json;
}

test('workflow: repository checks pass (sync, credentials, secrets, sandbox gates)', () => {
  assert.deepEqual(runChecks(), []);
});

test('workflow: ships inactive, all credentials placeholdered, disclaimer note + description present', () => {
  assert.equal(wf.active, false);
  const creds = wf.nodes.flatMap((n) => Object.values(n.credentials || {}));
  assert.ok(creds.length >= 10);
  for (const c of creds) assert.equal(c.id, 'REPLACE_WITH_YOUR_CREDENTIAL_ID');
  assert.match(getNode(wf, 'Disclaimer').parameters.content, /No Liability/);
  assert.match(wf.meta.description, /dhRobin Systems assume no responsibility/);
});

test('workflow: no CRM write, owner alert or SMS is reachable in sandbox', () => {
  const { seen } = reachableInSandbox(wf);
  for (const name of ['HubSpot: Update Contact', 'HubSpot: Create Timeline Note', 'Slack: Post Hot Lead Alert', 'Twilio: Send SMS to Owner', 'HubSpot: Search Contact']) {
    assert.ok(!seen.has(name), name + ' must sit behind the live gate');
  }
  const tampered = JSON.parse(JSON.stringify(wf));
  getNode(tampered, 'Live Mode?').notes = 'removed';
  assert.ok(runChecks(tampered).some((e) => /No \[sandbox-gate\]/.test(e)));
});

test('workflow: a hand-edited Code node is detected as out of sync', () => {
  const tampered = JSON.parse(JSON.stringify(wf));
  const node = getNode(tampered, 'Rule Pre-Classifier');
  node.parameters.jsCode = node.parameters.jsCode.replace("'unsubscribe', 'confidence': 0.95", 'x').replace('confidence: 0.95,', 'confidence: 0.10,');
  assert.ok(runChecks(tampered).some((e) => /out of sync/.test(e)));
});

test('verify node: live mode rejects missing/wrong tokens with 401 and accepts the right one', async () => {
  const body = loadSample('smartlead-email-reply.example.json');
  assert.deepEqual([(await verify(body, { env: LIVE_ENV })).httpStatus, (await verify(body, { env: LIVE_ENV })).reason], [401, 'missing_token']);
  assert.equal((await verify(body, { env: LIVE_ENV, query: { token: 'wrong' } })).decision, 'reject');
  const ok = await verify(body, { env: LIVE_ENV, query: { token: TOKEN } });
  assert.equal(ok.decision, 'process');
  assert.equal(ok.reply.leadEmail, 'jane.doe@example.com');
});

test('verify node: Smartlead HMAC enforced when SMARTLEAD_WEBHOOK_SECRET is set', async () => {
  const body = loadSample('smartlead-email-reply.example.json');
  const raw = JSON.stringify(body);
  const env = Object.assign({}, SANDBOX_ENV, { SMARTLEAD_WEBHOOK_SECRET: 'sample-secret-value' });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'sample-secret-value').update(raw).digest('hex');
  assert.equal((await verify(body, { env, rawBody: raw, headers: { 'x-smartlead-signature': sig } })).decision, 'process');
  assert.equal((await verify(body, { env, rawBody: raw, headers: { 'x-smartlead-signature': 'sha256=00' } })).reason, 'signature_mismatch');
});

test('verify node: non-reply events are acknowledged (200) and duplicates are ignored', async () => {
  assert.deepEqual((({ decision, httpStatus }) => [decision, httpStatus])(await verify({ event_type: 'EMAIL_OPEN', to_email: 'a@example.com' })), ['ignore', 200]);
  const staticData = {};
  const body = loadSample('instantly-reply-received.example.json');
  assert.equal((await verify(body, { staticData })).decision, 'process');
  const dup = await verify(body, { staticData });
  assert.deepEqual([dup.decision, dup.reason], ['ignore', 'duplicate_delivery']);
});

test('pre-classifier: unsubscribe skips the LLM; sandbox skips it unless LLM_IN_SANDBOX', async () => {
  const llmEnv = Object.assign({}, SANDBOX_ENV, { LLM_PROVIDER: 'openai', LLM_MODEL: 'example-model', LLM_IN_SANDBOX: 'true' });
  const unsub = (await verify(loadSample('smartlead-unsubscribe-reply.example.json')));
  const pre1 = (await runCodeNode(wf, 'Rule Pre-Classifier', { env: llmEnv, input: [{ json: unsub }] }))[0].json;
  assert.equal(pre1.llmRequest, null);
  assert.equal(pre1.llmSkippedReason, 'decided_by_rules_unsubscribe');

  const positive = await verify(loadSample('smartlead-email-reply.example.json'));
  const pre2 = (await runCodeNode(wf, 'Rule Pre-Classifier', { env: llmEnv, input: [{ json: positive }] }))[0].json;
  assert.equal(pre2.llmRequest.provider, 'openai');
  const pre3 = (await runCodeNode(wf, 'Rule Pre-Classifier', { env: Object.assign({}, llmEnv, { LLM_IN_SANDBOX: 'false' }), input: [{ json: positive }] }))[0].json;
  assert.equal(pre3.llmSkippedReason, 'sandbox_without_llm');
});

test('finalize: uses a valid LLM answer, falls back to rules when the LLM errors', async () => {
  const env = Object.assign({}, SANDBOX_ENV, { LLM_PROVIDER: 'openai', LLM_MODEL: 'example-model', LLM_IN_SANDBOX: 'true' });
  const positive = await verify(loadSample('smartlead-email-reply.example.json'));
  const pre = await runCodeNode(wf, 'Rule Pre-Classifier', { env, input: [{ json: positive }] });
  const llmOk = { choices: [{ message: { content: '{"category":"positive","confidence":0.93,"meeting_intent":true,"reason":"Proposes a time"}' } }] };
  const fin = (await runCodeNode(wf, 'Finalize Classification', { env, input: [{ json: llmOk }], nodeOutputs: { 'Rule Pre-Classifier': pre } }))[0].json;
  assert.deepEqual([fin.classification.category, fin.classification.source, fin.llmStatus], ['positive', 'llm', 'ok']);
  const failed = (await runCodeNode(wf, 'Finalize Classification', { env, input: [{ json: { error: { message: 'timeout' } } }], nodeOutputs: { 'Rule Pre-Classifier': pre } }))[0].json;
  assert.deepEqual([failed.classification.category, failed.classification.source], ['positive', 'rules']);
});

test('end-to-end sandbox path: classification + preview, no live nodes involved', async () => {
  const objection = await verify(loadSample('instantly-reply-received.example.json'));
  const pre = await runCodeNode(wf, 'Rule Pre-Classifier', { env: SANDBOX_ENV, input: [{ json: objection }] });
  const fin = await runCodeNode(wf, 'Finalize Classification', { env: SANDBOX_ENV, input: pre, nodeOutputs: { 'Rule Pre-Classifier': pre } });
  assert.equal(fin[0].json.classification.category, 'objection');
  assert.equal(fin[0].json.mode, 'sandbox');
  const preview = await runCodeNode(wf, 'Build Sandbox Preview', { env: SANDBOX_ENV, input: fin });
  assert.equal(preview[0].json.message.channel, '#reply-review');
  assert.match(JSON.stringify(preview[0].json.message), /hs_lead_status/);
  await assert.rejects(runCodeNode(wf, 'Assert Live Mode', { env: SANDBOX_ENV, input: fin }), /Safety stop/);
});

test('live path: plan, owner DM vs fallback channel, and SMS payload', async () => {
  const env = Object.assign({}, LIVE_ENV, { SMS_ENABLED: 'true', TWILIO_ACCOUNT_SID: 'AC' + '0'.repeat(32), TWILIO_FROM_NUMBER: '+15550100000', OWNER_SMS_MAP: '{"77":"+15550100001"}' });
  const positive = await verify(loadSample('smartlead-email-reply.example.json'), { env, query: { token: TOKEN } });
  const pre = await runCodeNode(wf, 'Rule Pre-Classifier', { env, input: [{ json: positive }] });
  const fin = await runCodeNode(wf, 'Finalize Classification', { env, input: pre, nodeOutputs: { 'Rule Pre-Classifier': pre } });
  const search = { results: [{ id: '501', properties: { hubspot_owner_id: '77' } }] };
  const plan = await runCodeNode(wf, 'Plan CRM Update', { env, input: [{ json: search }], nodeOutputs: { 'Finalize Classification': fin } });
  assert.equal(plan[0].json.plan.route.hotLead, false, 'rules-only positive (0.70) stays below the 0.75 hot-lead threshold');

  const confident = JSON.parse(JSON.stringify(fin));
  confident[0].json.classification = { category: 'positive', confidence: 0.92, source: 'llm', needsReview: false, meetingIntent: true, reason: 'Proposes a time' };
  const hotPlan = await runCodeNode(wf, 'Plan CRM Update', { env, input: [{ json: search }], nodeOutputs: { 'Finalize Classification': confident } });
  assert.equal(hotPlan[0].json.plan.route.hotLead, true);
  const outputs = { 'Finalize Classification': confident, 'Plan CRM Update': hotPlan };
  const dm = (await runCodeNode(wf, 'Build Hot Lead Alert', { env, input: [{ json: { ok: true, user: { id: 'U0OWNER01' } } }], nodeOutputs: outputs }))[0].json;
  assert.equal(dm.message.channel, 'U0OWNER01');
  assert.equal(dm.sms.to, '+15550100001');
  const fallback = (await runCodeNode(wf, 'Build Hot Lead Alert', { env, input: [{ json: { ok: false, error: 'users_not_found' } }], nodeOutputs: outputs }))[0].json;
  assert.equal(fallback.message.channel, '#hot-leads');
  await assert.rejects(runCodeNode(wf, 'Plan CRM Update', { env, input: [{ json: { error: { message: '401' } } }], nodeOutputs: outputs }), /contact search failed/);
});

test('repository: env template has empty secrets and sandbox on; README embeds the disclaimer', () => {
  const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.match(env, /^SANDBOX_MODE=true$/m);
  assert.match(env, /^WEBHOOK_SHARED_TOKEN=$/m);
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const disclaimer = fs.readFileSync(path.join(ROOT, 'DISCLAIMER.md'), 'utf8').split('\n').slice(2).join('\n').trim();
  assert.ok(readme.includes(disclaimer));
  assert.ok(readme.indexOf('Disclaimer & Liability Limitation') < readme.lastIndexOf('## License'));
});
