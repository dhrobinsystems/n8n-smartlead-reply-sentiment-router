/**
 * n8n-smartlead-reply-sentiment-router :: Webhook verification, de-duplication, HubSpot update plan, Slack & SMS payloads
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
 * Pure, dependency-free routing logic. Crypto is injected by the caller so
 * this module also runs inside n8n Code nodes.
 */

const MAX_SLACK_TEXT = 2900;

/* ------------------------------------------------------------------------ */
/* Webhook authenticity                                                     */
/* ------------------------------------------------------------------------ */

function constantTimeEqual(a, b) {
  const left = String(a === undefined || a === null ? '' : a);
  const right = String(b === undefined || b === null ? '' : b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      const v = headers[key];
      return Array.isArray(v) ? String(v[0] || '') : String(v === undefined || v === null ? '' : v);
    }
  }
  return '';
}

/**
 * Shared-token check. Instantly lets you add custom headers to a webhook;
 * Smartlead webhooks can carry the token as a ?token= query parameter.
 * @returns {{valid:boolean, reason:string}}
 */
function verifySharedToken(params) {
  const p = params || {};
  if (!p.expected) return p.required ? { valid: false, reason: 'token_not_configured' } : { valid: true, reason: 'token_check_disabled' };
  const bearer = getHeader(p.headers, 'authorization').replace(/^Bearer\s+/i, '');
  const provided = getHeader(p.headers, 'x-webhook-token') || bearer || String((p.query && p.query.token) || '');
  if (!provided) return { valid: false, reason: 'missing_token' };
  return constantTimeEqual(provided, p.expected) ? { valid: true, reason: 'ok' } : { valid: false, reason: 'token_mismatch' };
}

/**
 * Optional Smartlead HMAC check: X-Smartlead-Signature = "sha256=" + hex(HMAC-SHA256(secret, rawBody)).
 */
function verifySmartleadSignature(params) {
  const p = params || {};
  if (!p.secret) return { valid: true, reason: 'signature_check_disabled' };
  if (typeof p.hmacSha256Hex !== 'function') return { valid: false, reason: 'missing_hmac_implementation' };
  if (typeof p.rawBody !== 'string' || !p.rawBody) return { valid: false, reason: 'missing_raw_body' };
  const signature = String(p.signature || '').trim();
  if (!signature) return { valid: false, reason: 'missing_signature' };
  const expected = 'sha256=' + p.hmacSha256Hex(p.secret, p.rawBody);
  const normalized = /^sha256=/i.test(signature) ? signature.replace(/^sha256=/i, 'sha256=') : 'sha256=' + signature;
  return constantTimeEqual(normalized, expected) ? { valid: true, reason: 'ok' } : { valid: false, reason: 'signature_mismatch' };
}

/* ------------------------------------------------------------------------ */
/* Duplicate-delivery protection                                            */
/* ------------------------------------------------------------------------ */

function fnv1a(input, seed) {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Content-based key. Neither platform guarantees a stable event ID across
 * retries, so the key is derived from what identifies the reply itself.
 * The key is a hash: no email address is stored in workflow static data.
 */
function buildDedupeKey(reply) {
  const r = reply || {};
  const canonical = [r.platform, r.leadEmail, r.campaignId, r.messageId, r.repliedAt, String(r.replyText || '').slice(0, 200)].join('|');
  return 'rpl-' + fnv1a(canonical, 0x811c9dc5) + fnv1a(canonical.split('').reverse().join(''), 0x9747b28c);
}

/**
 * Record a delivery in a TTL ledger (n8n workflow static data). Mutates the
 * ledger in place, as n8n requires.
 * @returns {{duplicate:boolean}}
 */
function registerDelivery(ledger, key, nowMs, ttlMs, maxEntries) {
  if (!ledger || typeof ledger !== 'object') throw new Error('registerDelivery requires a ledger object.');
  for (const k of Object.keys(ledger)) if (nowMs - ledger[k] >= ttlMs) delete ledger[k];
  if (ledger[key] !== undefined) return { duplicate: true };
  ledger[key] = nowMs;
  const keys = Object.keys(ledger);
  const cap = maxEntries || 5000;
  if (keys.length > cap) {
    keys.sort((a, b) => ledger[a] - ledger[b]);
    for (const k of keys.slice(0, keys.length - cap)) delete ledger[k];
  }
  return { duplicate: false };
}

/* ------------------------------------------------------------------------ */
/* HubSpot                                                                  */
/* ------------------------------------------------------------------------ */

function buildContactSearchBody(email) {
  return {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: String(email || '').toLowerCase() }] }],
    properties: ['email', 'firstname', 'lastname', 'company', 'hubspot_owner_id', 'hs_lead_status'],
    limit: 1
  };
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function contactUrl(portalId, contactId) {
  return portalId && contactId ? 'https://app.hubspot.com/contacts/' + portalId + '/record/0-1/' + contactId : '';
}

const CATEGORY_LABELS = Object.freeze({
  positive: 'Positive',
  neutral: 'Neutral',
  objection: 'Objection',
  out_of_office: 'Out of office',
  unsubscribe: 'Unsubscribe request'
});

/**
 * Turn the HubSpot search response + classification into an exact plan:
 * which properties to PATCH, which note to create and where to route.
 */
function planCrmUpdate(params) {
  const p = params || {};
  const config = p.config;
  const reply = p.reply;
  const c = p.classification;
  if (!config || !reply || !c) throw new Error('planCrmUpdate requires config, reply and classification.');
  const results = (p.searchResponse && Array.isArray(p.searchResponse.results)) ? p.searchResponse.results : [];
  const contact = results[0] || null;
  const contactId = contact ? String(contact.id) : '';
  const ownerId = contact && contact.properties && contact.properties.hubspot_owner_id ? String(contact.properties.hubspot_owner_id) : '';
  const nowIso = p.nowIso || new Date().toISOString();

  const properties = {};
  const status = config.hubspot.leadStatusMap[c.category];
  if (status) properties.hs_lead_status = status;
  if (config.hubspot.writeSentimentProperties) {
    const names = config.hubspot.sentimentProperties;
    properties[names.category] = c.category;
    properties[names.confidence] = String(Number(c.confidence).toFixed(2));
    properties[names.receivedAt] = nowIso;
  }
  if (c.category === 'unsubscribe' && config.hubspot.dncProperty) properties[config.hubspot.dncProperty] = 'true';

  const excerptLimit = config.hubspot.noteExcerptChars;
  const excerpt = excerptLimit > 0 ? String(reply.replyText || '').slice(0, excerptLimit) : '';
  const lines = [
    'Sentiment: ' + (CATEGORY_LABELS[c.category] || c.category) + ' (' + Math.round(c.confidence * 100) + '% confidence, via ' + c.source + ')',
    c.needsReview ? 'Flagged for human review.' : '',
    c.reason ? 'Reason: ' + c.reason : '',
    'Platform: ' + reply.platform + (reply.campaignName ? ' | Campaign: ' + reply.campaignName : ''),
    reply.subject ? 'Subject: ' + reply.subject : ''
  ].filter(Boolean);
  const noteBody = '<p><strong>Cold email reply received</strong></p><ul>' + lines.map((l) => '<li>' + escapeHtml(l) + '</li>').join('') + '</ul>'
    + (excerpt ? '<p><em>Reply excerpt:</em></p><blockquote>' + escapeHtml(excerpt).replace(/\n/g, '<br>') + '</blockquote>' : '');

  const note = contactId ? {
    properties: { hs_timestamp: nowIso, hs_note_body: noteBody },
    // 202 = HUBSPOT_DEFINED note-to-contact association.
    associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }]
  } : null;

  const hotLead = c.category === 'positive' && !c.needsReview && c.confidence >= config.routing.hotLeadMinConfidence;
  return {
    contactFound: Boolean(contactId),
    contactId,
    ownerId,
    contactUrl: contactUrl(config.hubspot.portalId, contactId),
    update: { properties },
    note,
    route: {
      hotLead,
      unsubscribe: c.category === 'unsubscribe',
      needsReview: c.needsReview || !contactId,
      smsRecipient: hotLead && config.sms.enabled ? (config.sms.ownerNumbers[ownerId] || '') : ''
    }
  };
}

/* ------------------------------------------------------------------------ */
/* Slack & SMS payloads                                                     */
/* ------------------------------------------------------------------------ */

function escapeMrkdwn(value) {
  return String(value === undefined || value === null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(value, max) {
  const text = String(value || '');
  return text.length <= max ? text : text.slice(0, max - 3) + '...';
}

function quoteBlock(text) {
  return truncate(text, 1500).split('\n').map((line) => '>' + escapeMrkdwn(line)).join('\n');
}

function link(url, label) {
  return url && /^https:\/\/[^\s|<>]+$/.test(url) ? '<' + url + '|' + escapeMrkdwn(label) + '>' : escapeMrkdwn(label);
}

function replySummaryFields(reply, classification) {
  return [
    '*Lead*\n' + escapeMrkdwn(reply.leadName || reply.leadEmail) + (reply.companyName ? ' \u2022 ' + escapeMrkdwn(reply.companyName) : ''),
    '*Sentiment*\n' + escapeMrkdwn(CATEGORY_LABELS[classification.category] || classification.category) + ' (' + Math.round(classification.confidence * 100) + '%, ' + escapeMrkdwn(classification.source) + ')',
    '*Campaign*\n' + escapeMrkdwn(reply.campaignName || reply.campaignId || 'n/a'),
    '*Platform*\n' + escapeMrkdwn(reply.platform)
  ].map((text) => ({ type: 'mrkdwn', text: truncate(text, 1900) }));
}

/** Hot-lead alert: DM to the HubSpot owner, or the fallback channel. */
function buildHotLeadAlert(params) {
  const p = params || {};
  const r = p.reply;
  const c = p.classification;
  const mention = p.ownerSlackId ? '<@' + p.ownerSlackId + '> ' : '';
  return {
    channel: p.channel,
    text: 'Hot lead: positive reply from ' + (r.leadName || r.leadEmail),
    unfurl_links: false,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Hot lead: positive reply', emoji: true } },
      { type: 'section', fields: replySummaryFields(r, c) },
      { type: 'section', text: { type: 'mrkdwn', text: truncate(mention + '*Reply:*\n' + quoteBlock(r.replyText), MAX_SLACK_TEXT) } },
      { type: 'section', text: { type: 'mrkdwn', text: [link(p.contactUrl, 'Open HubSpot contact'), link(r.inboxUrl, 'Open in sending platform')].filter((x) => x.startsWith('<')).join('  |  ') || '_No deep links configured._' } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: truncate((c.meetingIntent ? 'Meeting intent detected. ' : '') + 'Reply within the hour for best conversion.' + (p.ownerFallback ? ' Owner could not be matched in Slack; posted to the fallback channel.' : ''), 1900) }] }
    ]
  };
}

/** Review / compliance alert for unsubscribes, low confidence or unmatched contacts. */
function buildReviewAlert(params) {
  const p = params || {};
  const r = p.reply;
  const c = p.classification;
  const reasons = [];
  if (c.category === 'unsubscribe') reasons.push('Unsubscribe request: suppress this address in every sending tool.');
  if (!p.contactFound) reasons.push('No HubSpot contact matched this email.');
  if (c.needsReview) reasons.push('Low confidence or conflicting signals: confirm the category.');
  return {
    channel: p.channel,
    text: 'Reply needs review: ' + (CATEGORY_LABELS[c.category] || c.category),
    unfurl_links: false,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: '*Reply needs attention*\n' + reasons.map((x) => '\u2022 ' + escapeMrkdwn(x)).join('\n') } },
      { type: 'section', fields: replySummaryFields(r, c) },
      { type: 'section', text: { type: 'mrkdwn', text: truncate(quoteBlock(r.replyText), MAX_SLACK_TEXT) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: truncate((c.reason ? 'Classifier note: ' + escapeMrkdwn(c.reason) + ' | ' : '') + link(p.contactUrl, 'HubSpot contact'), 1900) }] }
    ]
  };
}

/** Sandbox dry run: shows exactly what live mode would do. */
function buildSandboxPreview(params) {
  const p = params || {};
  const r = p.reply;
  const c = p.classification;
  const actions = [
    'HubSpot: find contact by email, then PATCH ' + Object.keys(p.plannedProperties || {}).map((k) => '`' + k + '`').join(', ') + ' and add a timeline note',
    c.category === 'positive' && !c.needsReview && c.confidence >= p.hotLeadMinConfidence ? 'Slack: DM the HubSpot owner (fallback ' + escapeMrkdwn(p.hotLeadsChannel) + ')' + (p.smsEnabled ? ' + SMS' : '') : 'No hot-lead alert',
    c.category === 'unsubscribe' || c.needsReview ? 'Slack: review/compliance alert to ' + escapeMrkdwn(p.channel) : ''
  ].filter(Boolean);
  return {
    channel: p.channel,
    text: '[SANDBOX] Reply classified as ' + (CATEGORY_LABELS[c.category] || c.category) + ' - no CRM writes or alerts sent.',
    unfurl_links: false,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'SANDBOX DRY RUN - reply sentiment router', emoji: true } },
      { type: 'section', fields: replySummaryFields(r, c) },
      { type: 'section', text: { type: 'mrkdwn', text: truncate(quoteBlock(r.replyText), MAX_SLACK_TEXT) } },
      { type: 'section', text: { type: 'mrkdwn', text: '*Live mode would:*\n' + actions.map((a) => '\u2022 ' + a).join('\n') } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: truncate('Rules: ' + escapeMrkdwn(p.rulesCategory || 'no match') + ' | LLM: ' + escapeMrkdwn(p.llmStatus) + (c.reason ? ' | ' + escapeMrkdwn(c.reason) : ''), 1900) }] }
    ]
  };
}

/** SMS body: minimal personal data (first name + company), no reply text. */
function buildSmsBody(params) {
  const p = params || {};
  const who = [p.reply.leadFirstName, p.reply.companyName ? '(' + p.reply.companyName + ')' : ''].filter(Boolean).join(' ') || 'A prospect';
  return truncate('Hot lead: ' + who + ' replied positively to your outreach. Check Slack/HubSpot and reply fast.', 160);
}

module.exports = {
  constantTimeEqual,
  getHeader,
  verifySharedToken,
  verifySmartleadSignature,
  buildDedupeKey,
  registerDelivery,
  buildContactSearchBody,
  planCrmUpdate,
  buildHotLeadAlert,
  buildReviewAlert,
  buildSandboxPreview,
  buildSmsBody,
  escapeMrkdwn
};
