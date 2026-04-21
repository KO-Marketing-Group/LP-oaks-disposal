'use strict';
const express = require('express');
const sgMail = require('@sendgrid/mail');
const mysql = require('mysql2/promise');
const crypto = require('crypto');

/* ── Env vars ─────────────────────────────────────────────────────────────── */
const SENDGRID_KEY = process.env.SENDGRID_KEY;
const FROM_EMAIL   = process.env.SENDGRID_FROM;
const TO_EMAIL     = (process.env.SENDGRID_TO || '').split(',').map(s => s.trim()).filter(Boolean);

const DB_HOST     = process.env.DB_HOST;
const DB_PORT     = parseInt(process.env.DB_PORT || '3306', 10);
const DB_USER     = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_DB       = process.env.DB_DB;

const MC_API_KEY = process.env.MC_API_KEY;
const MC_LIST_ID = process.env.MC_LIST_ID;
const MC_DC      = process.env.MC_DC || (MC_API_KEY ? MC_API_KEY.split('-')[1] : '');
const MC_TAG     = process.env.MC_TAG || 'OaksDisposal';

const DASHBOARD_USER     = process.env.DASHBOARD_USER;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

if (!SENDGRID_KEY || TO_EMAIL.length === 0 || !FROM_EMAIL) {
  console.warn('WARNING: Missing SendGrid env vars (SENDGRID_KEY, SENDGRID_TO, SENDGRID_FROM). Lead emails will fail.');
}
if (!DB_HOST || !DB_USER || !DB_PASSWORD || !DB_DB) {
  console.warn('WARNING: Missing DB env vars (DB_HOST, DB_USER, DB_PASSWORD, DB_DB). Lead inserts will fail.');
}
if (!MC_API_KEY || !MC_LIST_ID || !MC_DC) {
  console.warn('WARNING: Missing Mailchimp env vars (MC_API_KEY, MC_LIST_ID, MC_DC). Mailchimp sync will fail.');
}
if (!DASHBOARD_USER || !DASHBOARD_PASSWORD) {
  console.warn('WARNING: Missing DASHBOARD_USER / DASHBOARD_PASSWORD. /dashboard will return 503 until configured.');
}

if (SENDGRID_KEY) sgMail.setApiKey(SENDGRID_KEY);

/* ── MySQL pool ───────────────────────────────────────────────────────────── */
const pool = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_DB,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  first_name    VARCHAR(100) NOT NULL,
  last_name     VARCHAR(100) NOT NULL,
  email         VARCHAR(255) NOT NULL,
  phone         VARCHAR(20)  NULL,
  street        VARCHAR(200) NOT NULL,
  city          VARCHAR(100) NOT NULL,
  state         CHAR(2)      NOT NULL,
  zipcode       VARCHAR(10)  NOT NULL,
  form_location VARCHAR(20)  NULL,
  landing_page  VARCHAR(500) NULL,
  referrer      VARCHAR(500) NULL,
  user_agent    VARCHAR(500) NULL,
  ip_address    VARCHAR(45)  NULL,
  gclid         VARCHAR(200) NULL,
  utm_source    VARCHAR(100) NULL,
  utm_medium    VARCHAR(100) NULL,
  utm_campaign  VARCHAR(200) NULL,
  utm_content   VARCHAR(200) NULL,
  utm_term      VARCHAR(200) NULL,
  INDEX idx_email (email),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/* ── Mailchimp upsert (v3 Marketing API) ──────────────────────────────────
   PUT /lists/{list_id}/members/{subscriber_hash} upserts by email hash.
   Tags assigned via PUT are ignored for existing members, so we always
   POST to /tags afterwards to guarantee the tag sticks. */
async function mailchimpUpsert(email, merge_fields) {
  if (!MC_API_KEY || !MC_LIST_ID || !MC_DC) {
    throw new Error('mailchimp-not-configured');
  }
  const hash = crypto.createHash('md5').update(email.toLowerCase()).digest('hex');
  const base = `https://${MC_DC}.api.mailchimp.com/3.0/lists/${MC_LIST_ID}/members/${hash}`;
  const auth = 'Basic ' + Buffer.from('anystring:' + MC_API_KEY).toString('base64');
  const headers = { 'Content-Type': 'application/json', 'Authorization': auth };

  const memberRes = await fetch(base, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      email_address: email,
      status_if_new: 'subscribed',
      merge_fields,
    }),
  });
  if (!memberRes.ok) {
    const body = await memberRes.text();
    throw new Error(`mailchimp member upsert ${memberRes.status}: ${body}`);
  }

  const tagRes = await fetch(`${base}/tags`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tags: [{ name: MC_TAG, status: 'active' }] }),
  });
  if (!tagRes.ok && tagRes.status !== 204) {
    const body = await tagRes.text();
    throw new Error(`mailchimp tag ${tagRes.status}: ${body}`);
  }
}

async function ensureSchema() {
  try {
    await pool.query(SCHEMA);
    console.log('[db] leads table ready');
  } catch (err) {
    console.error('[db] schema migration failed:', err.message);
  }
}

/* ── Express ──────────────────────────────────────────────────────────────── */
const app = express();

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

/* Liveness — nginx handles /live directly, this is here only as a fallback
   if something is ever proxied to Node without a DB check. */
app.get('/live', (req, res) => res.json({ ok: true }));

/* Readiness — verifies the DB pool is responsive. 503 → Sevalla pulls the
   pod out of the load balancer (but doesn't restart it). */
app.get('/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'db unavailable' });
  }
});

app.all('/lead', (req, res, next) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  next();
});

app.post('/lead', express.json({ limit: '10kb' }), async (req, res) => {
  const d = req.body || {};

  const first_name = (d.first_name || '').trim();
  const last_name  = (d.last_name  || '').trim();
  const email      = (d.email      || '').trim();
  const phoneRaw   = (d.phone      || '').replace(/\D/g, '');
  const street     = (d.street     || '').trim();
  const city       = (d.city       || '').trim();
  const state      = (d.state      || '').trim().toUpperCase();
  const zipcode    = (d.zipcode    || '').trim();

  const errors = [];
  if (!first_name || first_name.length > 100) errors.push('first_name');
  if (!last_name  || last_name.length  > 100) errors.push('last_name');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('email');
  if (phoneRaw && phoneRaw.length !== 10) errors.push('phone');
  if (!street  || street.length  > 200) errors.push('street');
  if (!city    || city.length    > 100) errors.push('city');
  if (!/^[A-Z]{2}$/.test(state))         errors.push('state');
  if (!/^\d{5}$/.test(zipcode))          errors.push('zipcode');

  if (errors.length) {
    return res.status(400).json({ error: 'Invalid fields', fields: errors });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress
    || 'unknown';

  const row = {
    first_name,
    last_name,
    email,
    phone: phoneRaw || null,
    street,
    city,
    state,
    zipcode,
    form_location: (d.form_location || '').toString().slice(0, 20) || null,
    landing_page:  (d.landing_page  || '').toString().slice(0, 500) || null,
    referrer:      (d.referrer      || '').toString().slice(0, 500) || null,
    user_agent:    (d.user_agent    || '').toString().slice(0, 500) || null,
    ip_address:    ip.slice(0, 45),
    gclid:         (d.gclid         || '').toString().slice(0, 200) || null,
    utm_source:    (d.utm_source    || '').toString().slice(0, 100) || null,
    utm_medium:    (d.utm_medium    || '').toString().slice(0, 100) || null,
    utm_campaign:  (d.utm_campaign  || '').toString().slice(0, 200) || null,
    utm_content:   (d.utm_content   || '').toString().slice(0, 200) || null,
    utm_term:      (d.utm_term      || '').toString().slice(0, 200) || null,
  };

  console.log(`[lead-received] ${JSON.stringify(row)}`);

  /* Run DB insert, SendGrid send, and Mailchimp upsert independently.
     Any one failing does NOT cancel the others. Lead is considered
     captured as long as at least one persistence path succeeds. */
  const dbPromise = pool.query(
    `INSERT INTO leads
     (first_name, last_name, email, phone, street, city, state, zipcode,
      form_location, landing_page, referrer, user_agent, ip_address,
      gclid, utm_source, utm_medium, utm_campaign, utm_content, utm_term)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.first_name, row.last_name, row.email, row.phone,
      row.street, row.city, row.state, row.zipcode,
      row.form_location, row.landing_page, row.referrer, row.user_agent, row.ip_address,
      row.gclid, row.utm_source, row.utm_medium, row.utm_campaign, row.utm_content, row.utm_term,
    ]
  );

  const emailConfigured = SENDGRID_KEY && TO_EMAIL.length && FROM_EMAIL;
  const emailPromise = emailConfigured
    ? sgMail.send({
        to: TO_EMAIL,
        from: FROM_EMAIL,
        replyTo: { email, name: `${first_name} ${last_name}`.trim() },
        subject: `Oaks Disposal - Pre-launch Signup: ${first_name} ${last_name}`,
        text: buildTextBody(row),
        html: buildHtmlBody(row),
        categories: ['lead', 'oaks-disposal', 'pre-launch'],
        trackingSettings: {
          clickTracking:        { enable: true },
          openTracking:         { enable: true },
          subscriptionTracking: { enable: false },
        },
      })
    : Promise.reject(new Error('sendgrid-not-configured'));

  const mailchimpPromise = mailchimpUpsert(email, {
    FNAME:   first_name,
    LNAME:   last_name,
    ZIPCODE: zipcode,
  });

  const [dbResult, emailResult, mcResult] = await Promise.allSettled([
    dbPromise, emailPromise, mailchimpPromise,
  ]);

  if (dbResult.status === 'rejected') {
    console.error(`[lead-db-failed] email=${email} err=${dbResult.reason.message}`);
  }
  if (emailResult.status === 'rejected' && emailConfigured) {
    const reason = emailResult.reason;
    const detail = {
      email,
      message: reason.message,
      code: reason.code,
      status: reason.response && reason.response.statusCode,
      headers: reason.response && reason.response.headers,
      body: reason.response && reason.response.body,
      stack: reason.stack,
    };
    console.error(`[sendgrid-error] ${JSON.stringify(detail)}`);
    console.error(`[lead-email-failed] email=${email}`);
  }
  if (mcResult.status === 'rejected') {
    console.error(`[mailchimp-failed] email=${email} err=${mcResult.reason.message}`);
  }

  /* Return 500 only if ALL persistence paths failed — a total loss that must
     be retried. If any succeeded, the lead is captured somewhere. */
  if (
    dbResult.status === 'rejected' &&
    emailResult.status === 'rejected' &&
    mcResult.status === 'rejected'
  ) {
    return res.status(500).json({ error: 'Failed to save lead' });
  }

  res.json({
    ok: true,
    db:        dbResult.status    === 'fulfilled',
    email:     emailResult.status === 'fulfilled',
    mailchimp: mcResult.status    === 'fulfilled',
  });
});

/* SendGrid Event Webhook — register URL in SendGrid: Settings → Mail Settings →
   Event Webhook. Point it at https://<host>/api/sendgrid-events.
   Failures go to stderr so Sevalla surfaces them in the error log stream. */
const SG_FAIL_EVENTS = new Set([
  'dropped',    // SendGrid refused to send
  'bounce',     // recipient server rejected
  'deferred',   // retrying after temp failure
  'blocked',    // recipient blocked
  'spamreport', // recipient marked as spam
]);

app.post('/sendgrid-events', express.json({ limit: '1mb' }), (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [];
  for (const e of events) {
    const summary = {
      ts:            e.timestamp ? new Date(e.timestamp * 1000).toISOString() : null,
      event:         e.event,
      email:         e.email,
      reason:        e.reason,
      type:          e.type,
      status:        e.status,
      response:      e.response,
      attempt:       e.attempt,
      bounce_class:  e.bounce_classification,
      ip:            e.ip,
      categories:    e.category,
      sg_message_id: e.sg_message_id,
      sg_event_id:   e.sg_event_id,
      payload:       e,
    };
    if (SG_FAIL_EVENTS.has(e.event)) {
      console.error(`[sendgrid-failure] ${JSON.stringify(summary)}`);
    } else {
      console.log(`[sendgrid-event] event=${e.event} email=${e.email || ''} sg_message_id=${e.sg_message_id || ''}`);
    }
  }
  res.status(200).end();
});

/* ── Dashboard (Basic Auth protected) ─────────────────────────────────────── */
function timingSafeStringEq(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function basicAuth(req, res, next) {
  if (!DASHBOARD_USER || !DASHBOARD_PASSWORD) {
    return res.status(503).type('text/plain').send('Dashboard not configured. Set DASHBOARD_USER and DASHBOARD_PASSWORD env vars.');
  }
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Basic' && token) {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep !== -1) {
      const u = decoded.slice(0, sep);
      const p = decoded.slice(sep + 1);
      if (timingSafeStringEq(u, DASHBOARD_USER) && timingSafeStringEq(p, DASHBOARD_PASSWORD)) {
        return next();
      }
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Oaks Dashboard", charset="UTF-8"');
  res.status(401).type('text/plain').send('Authentication required');
}

app.get('/dashboard', basicAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, created_at, first_name, last_name, email, phone, street, city, state, zipcode,
              form_location, gclid, utm_source, utm_medium, utm_campaign, ip_address
       FROM leads ORDER BY created_at DESC LIMIT 500`
    );
    const [[totals]] = await pool.query('SELECT COUNT(*) AS total FROM leads');
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderDashboard(rows, totals.total));
  } catch (err) {
    console.error('[dashboard-error]', err.message);
    res.status(500).type('text/plain').send('Database error loading dashboard');
  }
});

/* ── Startup ──────────────────────────────────────────────────────────────── */
ensureSchema().finally(() => {
  app.listen(3000, () => console.log('Lead mailer listening on :3000'));
});

/* ── Email formatters ─────────────────────────────────────────────────────── */
function buildTextBody(r) {
  const now = new Date().toISOString();
  const phoneFmt = r.phone
    ? `(${r.phone.slice(0,3)}) ${r.phone.slice(3,6)}-${r.phone.slice(6)}`
    : '';
  return [
    'OAKS DISPOSAL — PRE-LAUNCH SIGNUP',
    '─'.repeat(48),
    `Name:            ${r.first_name} ${r.last_name}`,
    `Email:           ${r.email}`,
    `Phone:           ${phoneFmt}`,
    `Address:         ${r.street}`,
    `                 ${r.city}, ${r.state} ${r.zipcode}`,
    '',
    'TRACKING DATA',
    '─'.repeat(48),
    `Form Location:   ${r.form_location || ''}`,
    `Landing Page:    ${r.landing_page || ''}`,
    `Referrer:        ${r.referrer || ''}`,
    `GCLID:           ${r.gclid || ''}`,
    `UTM Source:      ${r.utm_source || ''}`,
    `UTM Medium:      ${r.utm_medium || ''}`,
    `UTM Campaign:    ${r.utm_campaign || ''}`,
    `UTM Content:     ${r.utm_content || ''}`,
    `UTM Term:        ${r.utm_term || ''}`,
    `IP Address:      ${r.ip_address || ''}`,
    `User Agent:      ${r.user_agent || ''}`,
    `Submitted:       ${now}`,
  ].join('\n');
}

function buildHtmlBody(r) {
  const now = new Date().toUTCString();
  const phoneFmt = r.phone
    ? `(${r.phone.slice(0,3)}) ${r.phone.slice(3,6)}-${r.phone.slice(6)}`
    : '';
  const row = (label, value) => value
    ? `<tr><td style="padding:6px 12px;color:#666;white-space:nowrap;vertical-align:top">${esc(label)}</td><td style="padding:6px 12px;font-weight:600">${esc(value)}</td></tr>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;font-size:14px;color:#222;background:#f4f4f4;margin:0;padding:20px">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:6px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)">

  <div style="background:#2d7a3a;padding:20px 28px">
    <h2 style="margin:0;color:#fff;font-size:18px">Pre-launch Signup — Oaks Disposal</h2>
    <p style="margin:4px 0 0;color:#c8e6c9;font-size:13px">${esc(now)}</p>
  </div>

  <div style="padding:24px 28px">
    <h3 style="margin:0 0 12px;font-size:15px;color:#2d7a3a;border-bottom:2px solid #e8e8e8;padding-bottom:8px">Lead Details</h3>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">
      ${row('Name', `${r.first_name} ${r.last_name}`)}
      ${row('Email', r.email)}
      ${row('Phone', phoneFmt)}
      ${row('Street', r.street)}
      ${row('City/State/Zip', `${r.city}, ${r.state} ${r.zipcode}`)}
      ${row('Form Location', r.form_location)}
    </table>
  </div>

  <div style="padding:0 28px 24px">
    <h3 style="margin:0 0 12px;font-size:15px;color:#2d7a3a;border-bottom:2px solid #e8e8e8;padding-bottom:8px">Tracking Data</h3>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">
      ${row('Landing Page', r.landing_page)}
      ${row('Referrer', r.referrer)}
      ${row('GCLID', r.gclid)}
      ${row('UTM Source', r.utm_source)}
      ${row('UTM Medium', r.utm_medium)}
      ${row('UTM Campaign', r.utm_campaign)}
      ${row('UTM Content', r.utm_content)}
      ${row('UTM Term', r.utm_term)}
      ${row('IP Address', r.ip_address)}
      ${row('User Agent', r.user_agent)}
    </table>
  </div>

</div>
</body>
</html>`;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Dashboard renderer ───────────────────────────────────────────────────── */
function renderDashboard(rows, total) {
  const formatPhone = (p) => p
    ? `(${p.slice(0,3)}) ${p.slice(3,6)}-${p.slice(6)}`
    : '';
  const formatDate = (d) => {
    if (!d) return '';
    const dt = new Date(d);
    return dt.toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  };
  const inferSource = (r) => {
    if (r.utm_source) return esc(r.utm_source);
    if (r.gclid) return 'google_ads';
    return '<span class="muted">direct</span>';
  };

  const tbody = rows.map(r => `<tr>
    <td class="mono muted">${r.id}</td>
    <td class="nowrap">${esc(formatDate(r.created_at))}</td>
    <td>${esc(r.first_name)} ${esc(r.last_name)}</td>
    <td><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></td>
    <td class="nowrap">${r.phone ? `<a href="tel:${esc(r.phone)}">${esc(formatPhone(r.phone))}</a>` : '<span class="muted">—</span>'}</td>
    <td>${esc(r.street)}<br><span class="muted">${esc(r.city)}, ${esc(r.state)} ${esc(r.zipcode)}</span></td>
    <td>${esc(r.form_location || '')}</td>
    <td>${inferSource(r)}</td>
    <td class="mono muted">${esc(r.ip_address || '')}</td>
  </tr>`).join('');

  const emptyState = rows.length === 0
    ? '<p class="empty">No leads yet. Submit the form on the main site to see entries here.</p>'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Leads Dashboard | Oaks Disposal</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; color: #222; background: #f5f5f5; }
  header { background: #2d7a3a; color: #fff; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; }
  header h1 { margin: 0; font-size: 1.1rem; font-weight: 600; }
  header .stats { font-size: 0.85rem; opacity: 0.9; }
  main { padding: 20px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 1200px; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.08); font-size: 13px; }
  th, td { padding: 10px 12px; text-align: left; vertical-align: top; border-bottom: 1px solid #eee; }
  th { background: #fafafa; font-weight: 600; color: #333; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; position: sticky; top: 0; z-index: 1; }
  tr:hover td { background: #fff8ee; }
  td a { color: #2d7a3a; text-decoration: none; }
  td a:hover { text-decoration: underline; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; }
  .muted { color: #888; }
  .nowrap { white-space: nowrap; }
  .empty { padding: 40px; text-align: center; color: #666; background: #fff; border-radius: 4px; }
</style>
</head>
<body>
<header>
  <h1>Oaks Disposal — Leads</h1>
  <div class="stats">Showing ${rows.length} of ${total} total · <a href="/" style="color:#fff;text-decoration:underline">site</a></div>
</header>
<main>
  ${emptyState || `<table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Submitted</th>
        <th>Name</th>
        <th>Email</th>
        <th>Phone</th>
        <th>Address</th>
        <th>Form</th>
        <th>Source</th>
        <th>IP</th>
      </tr>
    </thead>
    <tbody>${tbody}</tbody>
  </table>`}
</main>
</body>
</html>`;
}
