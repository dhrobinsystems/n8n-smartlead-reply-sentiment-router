#!/usr/bin/env node
/**
 * n8n-smartlead-reply-sentiment-router :: Compiles src/*.js into workflow.json Code nodes; --check validates the repo
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
 * Usage:
 *   node scripts/build-workflow.js          # rewrite generated regions in workflow.json
 *   node scripts/build-workflow.js --check  # fail (exit 1) on drift, secrets or unsafe structure
 *
 * Each n8n Code node contains a generated region:
 *   // ==== BEGIN GENERATED BUNDLE (modules: config, sentimentParser) - DO NOT EDIT ====
 *   ...src modules with CommonJS removed...
 *   // ==== END GENERATED BUNDLE ====
 * followed by hand-written node glue. Only the generated region is rewritten.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const WORKFLOW = path.join(ROOT, 'workflow.json');
const PLACEHOLDER = 'REPLACE_WITH_YOUR_CREDENTIAL_ID';
const BUNDLE_RE = /\/\/ ==== BEGIN GENERATED BUNDLE \(modules: ([A-Za-z0-9, ]+)\)[^\n]*\n[\s\S]*?\/\/ ==== END GENERATED BUNDLE ====/;
const MODULE_ORDER = ['config', 'sentimentParser', 'replyRouter'];
const SECRET_PATTERNS = [
  ['Slack token', /\bxox[abposr]-[0-9A-Za-z-]{10,}/],
  ['OpenAI/Anthropic key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}/],
  ['HubSpot private app token', /\bpat-(?:na|eu|ap)\d-[0-9a-f]{8}-/],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ['Slack incoming webhook', /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/]
];

function stripCommonJs(source, name) {
  const idx = source.search(/^module\.exports\s*=/m);
  if (idx === -1) throw new Error('src/' + name + '.js must end with module.exports.');
  let body = source.slice(0, idx).replace(/^\s*['"]use strict['"];?\s*$/m, '');
  // Drop the long licence header inside Code nodes (the workflow carries its own disclaimer note).
  body = body.replace(/^\/\*\*[\s\S]*?\*\/\s*/, '');
  if (/\brequire\s*\(/.test(body)) throw new Error('src/' + name + '.js must not require() anything.');
  return body.replace(/\n{3,}/g, '\n\n').trim();
}

function renderBundle(modules) {
  const ordered = MODULE_ORDER.filter((m) => modules.includes(m));
  const unknown = modules.filter((m) => !MODULE_ORDER.includes(m));
  if (unknown.length) throw new Error('Unknown module(s) in bundle marker: ' + unknown.join(', '));
  const parts = ['// ==== BEGIN GENERATED BUNDLE (modules: ' + ordered.join(', ') + ') - DO NOT EDIT; run `npm run build` ===='];
  for (const name of ordered) {
    parts.push('// ---- src/' + name + '.js ----');
    parts.push(stripCommonJs(fs.readFileSync(path.join(SRC, name + '.js'), 'utf8'), name));
  }
  parts.push('// ==== END GENERATED BUNDLE ====');
  return parts.join('\n');
}

function syncCode(code) {
  const match = String(code).match(BUNDLE_RE);
  if (!match) throw new Error('missing GENERATED BUNDLE markers');
  const modules = match[1].split(',').map((s) => s.trim()).filter(Boolean);
  return { code: String(code).replace(BUNDLE_RE, () => renderBundle(modules)), modules };
}

function compile(code, name) {
  return new vm.Script('(async function () {\n' + code + '\n})', { filename: name + '.js' });
}

/** Nodes reachable from the webhook without crossing a declared live-only gate output. */
function reachableInSandbox(workflow) {
  const gates = new Map();
  for (const n of workflow.nodes) {
    const m = String(n.notes || '').match(/\[sandbox-gate:live-output=(\d)\]/);
    if (m) gates.set(n.name, Number(m[1]));
  }
  const start = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook').map((n) => n.name);
  const seen = new Set(start);
  const queue = start.slice();
  while (queue.length) {
    const name = queue.shift();
    const outs = (workflow.connections[name] && workflow.connections[name].main) || [];
    outs.forEach((targets, i) => {
      if (gates.get(name) === i) return;
      for (const t of targets || []) if (!seen.has(t.node)) { seen.add(t.node); queue.push(t.node); }
    });
  }
  return { seen, gates };
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out); else out.push(full);
  }
  return out;
}

/** Run every repository check. Returns a list of problems (empty = pass). */
function runChecks(workflow) {
  const errors = [];
  const wf = workflow || JSON.parse(fs.readFileSync(WORKFLOW, 'utf8'));
  if (wf.active !== false) errors.push('workflow.json must ship with "active": false.');
  const names = new Set();
  const usedModules = new Set();
  for (const node of wf.nodes || []) {
    if (names.has(node.name)) errors.push('Duplicate node name: ' + node.name);
    names.add(node.name);
    for (const [type, cred] of Object.entries(node.credentials || {})) {
      if (!cred || cred.id !== PLACEHOLDER) errors.push('Node "' + node.name + '" credential ' + type + ' must use ' + PLACEHOLDER + '.');
    }
    for (const h of ((node.parameters && node.parameters.headerParameters) || {}).parameters || []) {
      if (/^(authorization|x-api-key)$/i.test(h.name)) errors.push('Node "' + node.name + '" sets an auth header inline; use an n8n credential.');
    }
    if (node.type === 'n8n-nodes-base.code') {
      try {
        const { code, modules } = syncCode(node.parameters.jsCode);
        modules.forEach((m) => usedModules.add(m));
        if (code !== node.parameters.jsCode) errors.push('Code node "' + node.name + '" is out of sync with src/ (run npm run build).');
        compile(node.parameters.jsCode, node.name);
      } catch (error) {
        errors.push('Code node "' + node.name + '": ' + error.message);
      }
    }
  }
  for (const [from, conn] of Object.entries(wf.connections || {})) {
    if (!names.has(from)) errors.push('Connection from unknown node ' + from);
    for (const targets of conn.main || []) for (const t of targets || []) if (!names.has(t.node)) errors.push('Connection to unknown node ' + t.node);
  }
  for (const m of MODULE_ORDER) if (!usedModules.has(m)) errors.push('src/' + m + '.js is not used by any Code node.');

  const { seen, gates } = reachableInSandbox(wf);
  if (gates.size === 0) errors.push('No [sandbox-gate] node declared.');
  for (const node of wf.nodes) {
    if (!seen.has(node.name) || node.type !== 'n8n-nodes-base.httpRequest') continue;
    const method = String(node.parameters.method || 'GET').toUpperCase();
    if (method !== 'GET' && !/\[sandbox-safe\]/.test(String(node.notes || ''))) {
      errors.push('HTTP node "' + node.name + '" can run in SANDBOX_MODE without a live-only gate.');
    }
  }

  for (const file of walk(ROOT, [])) {
    if (!/\.(js|json|md|yml|example)$/.test(file) && !file.endsWith('.gitignore')) continue;
    if (path.basename(file) === '.env') errors.push('.env must never be committed.');
    const text = fs.readFileSync(file, 'utf8');
    for (const [label, re] of SECRET_PATTERNS) if (re.test(text)) errors.push(path.relative(ROOT, file) + ': possible hardcoded secret (' + label + ').');
    if (/samples[\\/]/.test(file)) {
      for (const email of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []) {
        const domain = email.split('@')[1].toLowerCase();
        if (!/(^|\.)(example\.(com|net|org)|domain\.com)$/.test(domain)) errors.push(path.relative(ROOT, file) + ': non-placeholder email domain ' + domain);
      }
    }
  }
  return errors;
}

function build() {
  const original = fs.readFileSync(WORKFLOW, 'utf8');
  const wf = JSON.parse(original);
  const changed = [];
  for (const node of wf.nodes) {
    if (node.type !== 'n8n-nodes-base.code') continue;
    const { code } = syncCode(node.parameters.jsCode);
    compile(code, node.name);
    if (code !== node.parameters.jsCode) { node.parameters.jsCode = code; changed.push(node.name); }
  }
  const output = JSON.stringify(wf, null, 2) + '\n';
  if (output !== original) fs.writeFileSync(WORKFLOW, output);
  return changed;
}

if (require.main === module) {
  try {
    if (process.argv.includes('--check')) {
      const errors = runChecks();
      if (errors.length) {
        console.error('\u2716 ' + errors.length + ' problem(s):\n - ' + errors.join('\n - '));
        process.exit(1);
      }
      console.log('\u2714 workflow.json in sync with src/, credentials placeholdered, no secrets, sandbox gates enforced.');
    } else {
      const changed = build();
      console.log(changed.length ? '\u2714 Updated ' + changed.length + ' Code node(s): ' + changed.join(', ') : '\u2714 workflow.json already in sync.');
    }
  } catch (error) {
    console.error('\u2716 ' + error.message);
    process.exit(1);
  }
}

module.exports = { renderBundle, syncCode, runChecks, reachableInSandbox, stripCommonJs, SECRET_PATTERNS };
