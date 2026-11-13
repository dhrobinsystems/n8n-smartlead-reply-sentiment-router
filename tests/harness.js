/**
 * n8n-smartlead-reply-sentiment-router :: Runs workflow.json Code nodes in a vm sandbox that emulates n8n globals
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

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const TOKEN = 'test-shared-token-placeholder-0001';

const SANDBOX_ENV = Object.freeze({ SANDBOX_MODE: 'true', SLACK_REVIEW_CHANNEL: '#reply-review' });
const LIVE_ENV = Object.freeze({
  SANDBOX_MODE: 'false',
  WEBHOOK_SHARED_TOKEN: TOKEN,
  HUBSPOT_PORTAL_ID: '12345678',
  SLACK_HOT_LEADS_CHANNEL: '#hot-leads',
  SLACK_REVIEW_CHANNEL: '#reply-review'
});

function loadWorkflow() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8'));
}

function loadSample(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', name), 'utf8'));
}

function getNode(workflow, name) {
  const node = workflow.nodes.find((n) => n.name === name);
  if (!node) throw new Error('Node not found: ' + name);
  return node;
}

const accessor = (items) => ({ first: () => items[0], last: () => items[items.length - 1], all: () => items, item: items[0] });

/**
 * Execute one Code node exactly as stored in workflow.json.
 * Returns JSON round-tripped output (avoids cross-realm prototype issues).
 */
async function runCodeNode(workflow, nodeName, options) {
  const o = options || {};
  const node = getNode(workflow, nodeName);
  const outputs = o.nodeOutputs || {};
  const context = vm.createContext({
    $: (name) => {
      if (!outputs[name]) throw new Error('Harness: no output registered for "' + name + '"');
      return accessor(outputs[name]);
    },
    $input: accessor(o.input || [{ json: {} }]),
    $env: o.envBlocked ? new Proxy({}, { get() { throw new Error('access to env vars denied'); } }) : (o.env || {}),
    $getWorkflowStaticData: () => o.staticData || {},
    require: (m) => { if (m === 'crypto') return crypto; throw new Error('Module not allowed: ' + m); },
    console,
    Buffer
  });
  const fn = new vm.Script('(async function () {\n' + node.parameters.jsCode + '\n})').runInContext(context);
  const result = await fn.call({
    helpers: {
      getBinaryDataBuffer: async () => {
        if (o.rawBody === undefined) throw new Error('no binary');
        return Buffer.from(o.rawBody, 'utf8');
      }
    }
  });
  return JSON.parse(JSON.stringify(result));
}

/** Webhook node output as n8n produces it. */
function webhookItem(body, headers, query) {
  return [{ json: { headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), query: query || {}, body } }];
}

module.exports = { ROOT, TOKEN, SANDBOX_ENV, LIVE_ENV, loadWorkflow, loadSample, getNode, runCodeNode, webhookItem };
