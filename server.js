'use strict';
const express = require('express');
const sgMail = require('@sendgrid/mail');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { Issuer, generators } = require('openid-client');

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

/* Microsoft SSO for /dashboard (mirrors the Oaks Reporting project's Auth.js
   config — same env var names, same OIDC flow, same domain allowlist). */
const AUTH_URL    = process.env.AUTH_URL;
const AUTH_SECRET = process.env.AUTH_SECRET;
const MS_CLIENT_ID     = process.env.AUTH_MICROSOFT_ENTRA_ID_ID;
const MS_CLIENT_SECRET = process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET;
const MS_TENANT_ID     = process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT || 'common';
/* Empty list = allow any email that successfully authenticates against the
   configured tenant. Set AUTH_ALLOWED_DOMAINS to restrict further. */
const AUTH_ALLOWED_DOMAINS = (process.env.AUTH_ALLOWED_DOMAINS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const OAUTH_STATE_COOKIE = 'oaks_oauth_state';
const SESSION_COOKIE     = 'oaks_session';

if (!SENDGRID_KEY || TO_EMAIL.length === 0 || !FROM_EMAIL) {
  console.warn('WARNING: Missing SendGrid env vars (SENDGRID_KEY, SENDGRID_TO, SENDGRID_FROM). Lead emails will fail.');
}
if (!DB_HOST || !DB_USER || !DB_PASSWORD || !DB_DB) {
  console.warn('WARNING: Missing DB env vars (DB_HOST, DB_USER, DB_PASSWORD, DB_DB). Lead inserts will fail.');
}
if (!MC_API_KEY || !MC_LIST_ID || !MC_DC) {
  console.warn('WARNING: Missing Mailchimp env vars (MC_API_KEY, MC_LIST_ID, MC_DC). Mailchimp sync will fail.');
}
if (!AUTH_URL || !AUTH_SECRET || !MS_CLIENT_ID || !MS_CLIENT_SECRET) {
  console.warn('WARNING: Missing Microsoft SSO env vars (AUTH_URL, AUTH_SECRET, AUTH_MICROSOFT_ENTRA_ID_ID, AUTH_MICROSOFT_ENTRA_ID_SECRET). /dashboard will return 503 until configured.');
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
app.use(cookieParser());

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
  if (phoneRaw.length !== 10) errors.push('phone');
  if (!street  || street.length  > 200) errors.push('street');
  if (!city    || city.length    > 100) errors.push('city');
  if (!/^[A-Z]{2}$/.test(state))         errors.push('state');
  if (!/^\d{5}$/.test(zipcode))          errors.push('zipcode');

  if (errors.length) {
    return res.status(400).json({ error: 'Invalid fields', fields: errors });
  }

  /* Cloudflare + Sevalla ingress + nginx = 3 proxy hops. Cloudflare's
     CF-Connecting-IP is the authoritative original-client IP; fall back to
     the leftmost X-Forwarded-For entry for non-CF traffic, then the socket
     (which will be nginx's loopback). */
  const ip = (req.headers['cf-connecting-ip'] || '').trim()
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress
    || 'unknown';

  const row = {
    first_name,
    last_name,
    email,
    phone: phoneRaw,
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

/* ── Microsoft SSO for /dashboard ─────────────────────────────────────────
   Mirrors the Oaks Reporting project's Auth.js setup: Microsoft Entra ID
   (multi-tenant, default "common"), domain allowlist, JWT session cookie.
   Apply `requireAuth` middleware to any route that needs protection. */

let oidcClient = null;
async function initOidc() {
  if (!AUTH_URL || !AUTH_SECRET || !MS_CLIENT_ID || !MS_CLIENT_SECRET) return;
  try {
    const issuer = await Issuer.discover(`https://login.microsoftonline.com/${MS_TENANT_ID}/v2.0`);
    oidcClient = new issuer.Client({
      client_id: MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      redirect_uris: [`${AUTH_URL}/auth/microsoft/callback`],
      response_types: ['code'],
    });
    console.log('[auth] Microsoft OIDC client initialized');
  } catch (err) {
    console.error('[auth] OIDC discovery failed:', err.message);
  }
}

function getSessionUser(req) {
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (!token || !AUTH_SECRET) return null;
  try { return jwt.verify(token, AUTH_SECRET); } catch (err) { return null; }
}

function requireAuth(req, res, next) {
  if (!AUTH_URL || !AUTH_SECRET || !MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    return res.status(503).type('text/plain')
      .send('Dashboard not configured. Set AUTH_URL, AUTH_SECRET, AUTH_MICROSOFT_ENTRA_ID_ID, AUTH_MICROSOFT_ENTRA_ID_SECRET env vars.');
  }
  const user = getSessionUser(req);
  if (user) { req.user = user; return next(); }
  const returnTo = req.originalUrl && req.originalUrl.startsWith('/') ? req.originalUrl : '/dashboard';
  res.redirect('/auth/login?returnTo=' + encodeURIComponent(returnTo));
}

function isSecureCookie() {
  return typeof AUTH_URL === 'string' && AUTH_URL.startsWith('https://');
}

/* Minimal login landing — shows Microsoft button and any error message. */
app.get('/auth/login', (req, res) => {
  const err = req.query.error ? String(req.query.error) : '';
  const returnTo = (req.query.returnTo && String(req.query.returnTo).startsWith('/'))
    ? String(req.query.returnTo) : '/dashboard';
  const signInHref = '/auth/microsoft/login?returnTo=' + encodeURIComponent(returnTo);
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Sign in | Oaks Disposal</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; background: #f5f5f5; color: #222; }
  .card { background: #fff; border-radius: 8px; padding: 40px; max-width: 400px; width: 90%;
    box-shadow: 0 4px 20px rgba(0,0,0,0.08); text-align: center; }
  h1 { margin: 0 0 8px; font-size: 1.3rem; color: #2d7a3a; }
  p.sub { margin: 0 0 24px; color: #666; font-size: 0.9rem; }
  a.btn { display: inline-flex; align-items: center; gap: 10px; background: #2f2f2f; color: #fff;
    padding: 12px 24px; border-radius: 4px; text-decoration: none; font-weight: 500; font-size: 0.95rem; }
  a.btn:hover { background: #000; }
  a.btn svg { width: 18px; height: 18px; }
  .error { background: #fff5f4; border: 1px solid #f0c7c3; color: #c0392b; padding: 10px 14px;
    border-radius: 4px; font-size: 0.85rem; margin-bottom: 20px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Oaks Disposal — Admin</h1>
    <p class="sub">Sign in to view the leads dashboard.</p>
    ${err ? `<div class="error">${esc(err)}</div>` : ''}
    <a class="btn" href="${esc(signInHref)}">
      <svg viewBox="0 0 23 23" xmlns="http://www.w3.org/2000/svg">
        <rect x="1"  y="1"  width="10" height="10" fill="#f25022"/>
        <rect x="12" y="1"  width="10" height="10" fill="#7fba00"/>
        <rect x="1"  y="12" width="10" height="10" fill="#00a4ef"/>
        <rect x="12" y="12" width="10" height="10" fill="#ffb900"/>
      </svg>
      Sign in with Microsoft
    </a>
  </div>
</body>
</html>`);
});

/* Start OIDC flow: build authorize URL, stash PKCE/state/nonce in a signed cookie. */
app.get('/auth/microsoft/login', (req, res) => {
  if (!oidcClient) return res.redirect('/auth/login?error=' + encodeURIComponent('SSO not configured'));
  const state         = generators.state();
  const nonce         = generators.nonce();
  const code_verifier = generators.codeVerifier();
  const code_challenge = generators.codeChallenge(code_verifier);
  const returnTo = (req.query.returnTo && String(req.query.returnTo).startsWith('/'))
    ? String(req.query.returnTo) : '/dashboard';
  const stateToken = jwt.sign({ state, nonce, code_verifier, returnTo }, AUTH_SECRET, { expiresIn: '10m' });
  res.cookie(OAUTH_STATE_COOKIE, stateToken, {
    httpOnly: true, secure: isSecureCookie(), sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/auth',
  });
  const url = oidcClient.authorizationUrl({
    scope: 'openid profile email',
    state, nonce,
    code_challenge, code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  res.redirect(url);
});

/* Handle OIDC callback: verify ID token, enforce domain allowlist, issue session cookie. */
app.get('/auth/microsoft/callback', async (req, res) => {
  if (!oidcClient) return res.redirect('/auth/login?error=' + encodeURIComponent('SSO not configured'));
  const stateToken = req.cookies && req.cookies[OAUTH_STATE_COOKIE];
  if (!stateToken) return res.redirect('/auth/login?error=' + encodeURIComponent('Session expired, try again'));
  let stateData;
  try { stateData = jwt.verify(stateToken, AUTH_SECRET); }
  catch (err) { return res.redirect('/auth/login?error=' + encodeURIComponent('Invalid state')); }
  res.clearCookie(OAUTH_STATE_COOKIE, { path: '/auth' });

  try {
    const params = oidcClient.callbackParams(req);
    const tokenSet = await oidcClient.callback(
      `${AUTH_URL}/auth/microsoft/callback`,
      params,
      { state: stateData.state, nonce: stateData.nonce, code_verifier: stateData.code_verifier }
    );
    const claims = tokenSet.claims();
    const email = String(claims.email || claims.preferred_username || '').toLowerCase();
    if (!email || !email.includes('@')) {
      return res.redirect('/auth/login?error=' + encodeURIComponent('No email returned from Microsoft'));
    }
    const domain = email.split('@')[1];
    if (AUTH_ALLOWED_DOMAINS.length && !AUTH_ALLOWED_DOMAINS.includes(domain)) {
      console.warn(`[auth] domain not allowed: ${domain}`);
      return res.redirect('/auth/login?error=' + encodeURIComponent(`Your domain (${domain}) is not authorized`));
    }
    const session = jwt.sign(
      { email, name: claims.name || email, sub: claims.sub },
      AUTH_SECRET,
      { expiresIn: '24h' }
    );
    res.cookie(SESSION_COOKIE, session, {
      httpOnly: true, secure: isSecureCookie(), sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, path: '/',
    });
    const returnTo = (stateData.returnTo && String(stateData.returnTo).startsWith('/'))
      ? String(stateData.returnTo) : '/dashboard';
    console.log(`[auth] signed in: ${email}`);
    res.redirect(returnTo);
  } catch (err) {
    console.error('[auth] callback error:', err.message);
    res.redirect('/auth/login?error=' + encodeURIComponent('Sign-in failed'));
  }
});

/* Sign out: clear the session cookie and redirect to login. */
app.get('/auth/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.redirect('/auth/login');
});

app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, created_at, first_name, last_name, email, phone, street, city, state, zipcode,
              form_location, gclid, utm_source, utm_medium, utm_campaign, ip_address
       FROM leads ORDER BY created_at DESC LIMIT 500`
    );
    const [[totals]] = await pool.query('SELECT COUNT(*) AS total FROM leads');
    const [dailyCounts] = await pool.query(
      `SELECT DATE(created_at) AS day, COUNT(*) AS count
       FROM leads
       GROUP BY DATE(created_at)
       ORDER BY day ASC`
    );
    const [zipCounts] = await pool.query(
      `SELECT zipcode, COUNT(*) AS count
       FROM leads
       WHERE zipcode IS NOT NULL AND zipcode != ''
       GROUP BY zipcode
       ORDER BY count DESC`
    );
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderDashboard(rows, totals.total, dailyCounts, zipCounts, req.user));
  } catch (err) {
    console.error('[dashboard-error]', err.message);
    res.status(500).type('text/plain').send('Database error loading dashboard');
  }
});

/* ── Startup ──────────────────────────────────────────────────────────────── */
Promise.allSettled([ensureSchema(), initOidc()]).finally(() => {
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

/* ── Rochester-area zipcode centroids for the dashboard heatmap ──────────── */
const ROCHESTER_ZIPS = {
  '14410':[42.899,-77.433],'14420':[43.211,-77.944],'14423':[42.976,-77.854],
  '14425':[42.890,-77.280],'14428':[43.103,-77.884],'14437':[42.564,-77.695],
  '14445':[43.110,-77.489],'14450':[43.097,-77.442],'14467':[43.048,-77.611],
  '14468':[43.289,-77.793],'14472':[42.957,-77.589],'14502':[43.067,-77.300],
  '14513':[43.048,-77.093],'14514':[43.092,-77.789],'14516':[43.181,-77.096],
  '14517':[42.578,-77.934],'14519':[43.224,-77.308],'14522':[43.060,-77.226],
  '14526':[43.170,-77.473],'14534':[43.085,-77.515],'14559':[43.192,-77.802],
  '14568':[43.140,-77.266],'14580':[43.211,-77.465],'14586':[43.010,-77.683],
  '14602':[43.157,-77.609],'14604':[43.157,-77.610],'14605':[43.172,-77.604],
  '14606':[43.181,-77.650],'14607':[43.151,-77.590],'14608':[43.152,-77.625],
  '14609':[43.169,-77.571],'14610':[43.142,-77.572],'14611':[43.147,-77.641],
  '14612':[43.231,-77.690],'14613':[43.172,-77.640],'14614':[43.158,-77.615],
  '14615':[43.198,-77.658],'14616':[43.222,-77.674],'14617':[43.211,-77.601],
  '14618':[43.129,-77.573],'14619':[43.143,-77.631],'14620':[43.134,-77.602],
  '14621':[43.186,-77.606],'14622':[43.220,-77.606],'14623':[43.081,-77.628],
  '14624':[43.142,-77.708],'14625':[43.151,-77.494],'14626':[43.221,-77.682],
};

/* Safely embed JSON inside <script> — escape characters that could break out
   of the tag or cause parsing weirdness across charsets. */
function safeJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function renderDashboard(rows, total, dailyCounts, zipCounts, user) {
  /* Emit data the client JS consumes. Keep the shape tight — this is an
     admin view loaded on demand, not a public API. */
  const leadsJson = safeJson(rows.map(r => ({
    id:            r.id,
    created_at:    r.created_at,
    first_name:    r.first_name,
    last_name:     r.last_name,
    email:         r.email,
    phone:         r.phone,
    street:        r.street,
    city:          r.city,
    state:         r.state,
    zipcode:       r.zipcode,
    form_location: r.form_location,
    gclid:         r.gclid,
    utm_source:    r.utm_source,
    ip_address:    r.ip_address,
  })));
  const dailyJson = JSON.stringify(dailyCounts.map(d => ({
    day:   d.day instanceof Date ? d.day.toISOString().slice(0,10) : String(d.day).slice(0,10),
    count: Number(d.count),
  })));
  const zipsJson = JSON.stringify(zipCounts.map(z => ({
    zipcode: String(z.zipcode).trim(),
    count:   Number(z.count),
  })));
  const zipCoordsJson = JSON.stringify(ROCHESTER_ZIPS);

  const empty = rows.length === 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Leads Dashboard | Oaks Disposal</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin=""/>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; color: #222; background: #f5f5f5; }
  header { background: #2d7a3a; color: #fff; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; }
  header h1 { margin: 0; font-size: 1.1rem; font-weight: 600; }
  header .stats { font-size: 0.85rem; opacity: 0.9; }
  header a { color: #fff; text-decoration: underline; }
  main { padding: 20px; }
  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
  @media (max-width: 900px) { .charts { grid-template-columns: 1fr; } }
  .card { background: #fff; border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); padding: 16px; }
  .card h2 { margin: 0 0 12px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #555; }
  .chart-wrap { position: relative; }
  #line-chart { width: 100%; height: 240px; display: block; }
  #line-chart .axis { stroke: #ccc; stroke-width: 1; }
  #line-chart .grid { stroke: #eee; stroke-width: 1; }
  #line-chart .line { fill: none; stroke: #2d7a3a; stroke-width: 2; }
  #line-chart .dot { fill: #2d7a3a; }
  #line-chart text { fill: #666; font-size: 10px; font-family: inherit; }
  #line-chart-tooltip {
    position: absolute; display: none; pointer-events: none;
    transform: translate(-50%, -100%);
    background: #222; color: #fff; padding: 6px 10px; border-radius: 4px;
    font-size: 12px; line-height: 1.4; white-space: nowrap;
    box-shadow: 0 4px 12px rgba(0,0,0,0.2); z-index: 10;
  }
  #line-chart-tooltip::after {
    content: ''; position: absolute; top: 100%; left: 50%;
    transform: translateX(-50%); border: 5px solid transparent;
    border-top-color: #222;
  }
  #line-chart-tooltip .tt-date  { opacity: 0.75; font-size: 11px; }
  #line-chart-tooltip .tt-count { font-weight: 600; font-size: 13px; }
  #lead-map { width: 100%; height: 320px; border-radius: 4px; }
  .table-wrap { background: #fff; border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 1100px; font-size: 13px; }
  th, td { padding: 10px 12px; text-align: left; vertical-align: top; border-bottom: 1px solid #eee; }
  th { background: #fafafa; font-weight: 600; color: #333; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  tr:hover td { background: #fff8ee; }
  td a { color: #2d7a3a; text-decoration: none; }
  td a:hover { text-decoration: underline; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; }
  .muted { color: #888; }
  .nowrap { white-space: nowrap; }
  .pager { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: #fafafa; border-top: 1px solid #eee; font-size: 13px; }
  .pager button { padding: 6px 14px; border: 1px solid #ccc; background: #fff; border-radius: 4px; cursor: pointer; font: inherit; }
  .pager button:disabled { opacity: 0.4; cursor: not-allowed; }
  .pager .info { color: #666; }
  .empty { padding: 40px; text-align: center; color: #666; background: #fff; border-radius: 4px; }
  .leaflet-popup-content { font-size: 13px; }
</style>
</head>
<body>
<header>
  <h1>Oaks Disposal — Leads</h1>
  <div class="stats">
    ${total} total ·
    ${user ? `signed in as ${esc(user.email || '')} · <a href="/auth/logout">sign out</a> · ` : ''}
    <a href="/">site</a>
  </div>
</header>
<main>
  ${empty ? '<p class="empty">No leads yet. Submit the form on the main site to see entries here.</p>' : `
  <div class="charts">
    <div class="card">
      <h2>Submissions per day</h2>
      <div class="chart-wrap">
        <svg id="line-chart" viewBox="0 0 600 240" preserveAspectRatio="none"></svg>
        <div id="line-chart-tooltip"></div>
      </div>
    </div>
    <div class="card">
      <h2>Submissions by zipcode</h2>
      <div id="lead-map"></div>
    </div>
  </div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>ID</th><th>Submitted</th><th>Name</th><th>Email</th>
          <th>Phone</th><th>Address</th><th>Form</th><th>Source</th><th>IP</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
    <div class="pager">
      <span class="info" id="pager-info"></span>
      <div>
        <button id="prev-page">‹ Prev</button>
        <button id="next-page">Next ›</button>
      </div>
    </div>
  </div>
  `}
</main>

<script>window.__LEADS__ = ${leadsJson};</script>
<script>window.__DAILY__ = ${dailyJson};</script>
<script>window.__ZIPS__ = ${zipsJson};</script>
<script>window.__ZIP_COORDS__ = ${zipCoordsJson};</script>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
<script>
(function () {
  var leads = window.__LEADS__ || [];
  if (leads.length === 0) return;

  /* ── Table pagination (10 rows/page) ─────────────────────────────────── */
  var PAGE_SIZE = 10;
  var page = 0;
  var totalPages = Math.max(1, Math.ceil(leads.length / PAGE_SIZE));

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function fmtPhone(p) {
    return p ? '(' + p.slice(0,3) + ') ' + p.slice(3,6) + '-' + p.slice(6) : '';
  }
  function fmtDate(d) {
    if (!d) return '';
    var dt = new Date(d);
    if (isNaN(dt)) return esc(String(d));
    return dt.toLocaleString('en-US', {
      year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false,
    });
  }
  function inferSource(r) {
    if (r.utm_source) return esc(r.utm_source);
    if (r.gclid) return 'google_ads';
    return '<span class="muted">direct</span>';
  }

  function renderTable() {
    var start = page * PAGE_SIZE;
    var slice = leads.slice(start, start + PAGE_SIZE);
    document.getElementById('tbody').innerHTML = slice.map(function (r) {
      return '<tr>'
        + '<td class="mono muted">' + r.id + '</td>'
        + '<td class="nowrap">' + esc(fmtDate(r.created_at)) + '</td>'
        + '<td>' + esc(r.first_name || '') + ' ' + esc(r.last_name || '') + '</td>'
        + '<td><a href="mailto:' + esc(r.email) + '">' + esc(r.email) + '</a></td>'
        + '<td class="nowrap">' + (r.phone
            ? '<a href="tel:' + esc(r.phone) + '">' + esc(fmtPhone(r.phone)) + '</a>'
            : '<span class="muted">—</span>') + '</td>'
        + '<td>' + esc(r.street || '') + '<br><span class="muted">'
            + esc(r.city || '') + ', ' + esc(r.state || '') + ' ' + esc(r.zipcode || '') + '</span></td>'
        + '<td>' + esc(r.form_location || '') + '</td>'
        + '<td>' + inferSource(r) + '</td>'
        + '<td class="mono muted">' + esc(r.ip_address || '') + '</td>'
        + '</tr>';
    }).join('');
    document.getElementById('pager-info').textContent =
      'Showing ' + (start + 1) + '–' + Math.min(start + PAGE_SIZE, leads.length)
      + ' of ' + leads.length + ' (page ' + (page + 1) + ' of ' + totalPages + ')';
    document.getElementById('prev-page').disabled = page === 0;
    document.getElementById('next-page').disabled = page >= totalPages - 1;
  }
  document.getElementById('prev-page').onclick = function () { if (page > 0) { page--; renderTable(); } };
  document.getElementById('next-page').onclick = function () { if (page < totalPages - 1) { page++; renderTable(); } };
  renderTable();

  /* ── Line chart: submissions per day, first submission → today ──────── */
  var daily = (window.__DAILY__ || []).map(function (d) { return { day: d.day, count: d.count }; });
  if (daily.length > 0) {
    /* Fill in 0-count days so the line is continuous */
    var firstDay = new Date(daily[0].day + 'T00:00:00');
    var today    = new Date(); today.setHours(0,0,0,0);
    var byDay = Object.create(null);
    daily.forEach(function (d) { byDay[d.day] = d.count; });
    var series = [];
    for (var dt = new Date(firstDay); dt <= today; dt.setDate(dt.getDate() + 1)) {
      var key = dt.toISOString().slice(0, 10);
      series.push({ day: key, count: byDay[key] || 0, ts: dt.getTime() });
    }

    var W = 600, H = 240;
    var padL = 36, padR = 16, padT = 16, padB = 28;
    var innerW = W - padL - padR;
    var innerH = H - padT - padB;
    var maxCount = Math.max.apply(null, series.map(function (d) { return d.count; }));
    maxCount = Math.max(1, maxCount);
    var minTs = series[0].ts, maxTs = series[series.length - 1].ts;
    var tsRange = Math.max(1, maxTs - minTs);
    var xFor = function (ts) { return padL + ((ts - minTs) / tsRange) * innerW; };
    var yFor = function (c)  { return padT + innerH - (c / maxCount) * innerH; };

    var svg = document.getElementById('line-chart');
    var NS = 'http://www.w3.org/2000/svg';
    function el(name, attrs, text) {
      var n = document.createElementNS(NS, name);
      for (var k in attrs) n.setAttribute(k, attrs[k]);
      if (text != null) n.textContent = text;
      return n;
    }

    /* Y-axis gridlines */
    var ticks = 4;
    for (var i = 0; i <= ticks; i++) {
      var v = Math.round((maxCount / ticks) * i);
      var y = yFor(v);
      svg.appendChild(el('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: 'grid' }));
      svg.appendChild(el('text', { x: padL - 6, y: y + 3, 'text-anchor': 'end' }, v));
    }

    /* X-axis date labels (first, middle, last) */
    var labels = [0, Math.floor(series.length / 2), series.length - 1];
    labels.forEach(function (idx) {
      var d = series[idx];
      var x = xFor(d.ts);
      svg.appendChild(el('text', {
        x: x, y: H - 8, 'text-anchor': idx === 0 ? 'start' : idx === series.length - 1 ? 'end' : 'middle'
      }, new Date(d.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })));
    });

    /* Axis lines */
    svg.appendChild(el('line', { x1: padL, x2: padL, y1: padT, y2: H - padB, class: 'axis' }));
    svg.appendChild(el('line', { x1: padL, x2: W - padR, y1: H - padB, y2: H - padB, class: 'axis' }));

    /* Polyline */
    var pts = series.map(function (d) { return xFor(d.ts) + ',' + yFor(d.count); }).join(' ');
    svg.appendChild(el('polyline', { points: pts, class: 'line' }));

    /* Visible dots — only for small series, to avoid visual clutter. */
    var showDots = series.length <= 60;
    if (showDots) {
      series.forEach(function (d) {
        svg.appendChild(el('circle', { cx: xFor(d.ts), cy: yFor(d.count), r: 2.5, class: 'dot' }));
      });
    }

    /* Hover tooltip — invisible hit circles covering each data point trigger
       a styled HTML tooltip. Radius 8 gives a generous hover target; always
       rendered so long series are still interactive. */
    var tooltip = document.getElementById('line-chart-tooltip');
    var hoverMarker = el('circle', { r: 4, class: 'dot', style: 'display:none;pointer-events:none' });
    svg.appendChild(hoverMarker);
    series.forEach(function (d) {
      var hit = el('circle', {
        cx: xFor(d.ts), cy: yFor(d.count), r: 10,
        fill: 'transparent', stroke: 'none', style: 'cursor:crosshair'
      });
      hit.addEventListener('mouseenter', function () {
        var rect = svg.getBoundingClientRect();
        var sx = rect.width  / W;
        var sy = rect.height / H;
        var pxX = xFor(d.ts) * sx;
        var pxY = yFor(d.count) * sy;
        tooltip.innerHTML =
          '<div class="tt-date">' + new Date(d.ts).toLocaleDateString('en-US',
            { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) + '</div>' +
          '<div class="tt-count">' + d.count + ' submission' + (d.count === 1 ? '' : 's') + '</div>';
        tooltip.style.display = 'block';
        /* Position above the point, centered */
        tooltip.style.left = pxX + 'px';
        tooltip.style.top  = (pxY - 12) + 'px';
        hoverMarker.setAttribute('cx', xFor(d.ts));
        hoverMarker.setAttribute('cy', yFor(d.count));
        hoverMarker.style.display = '';
      });
      hit.addEventListener('mouseleave', function () {
        tooltip.style.display = 'none';
        hoverMarker.style.display = 'none';
      });
      svg.appendChild(hit);
    });
  }

  /* ── Map: circles per zipcode, sized + colored by count ─────────────── */
  var zips = window.__ZIPS__ || [];
  var zipCoords = window.__ZIP_COORDS__ || {};
  var map = L.map('lead-map', { scrollWheelZoom: false, zoomControl: true })
    .setView([43.165, -77.595], 10);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);

  var maxZipCount = zips.reduce(function (m, z) { return Math.max(m, z.count); }, 0) || 1;
  var unmapped = [];
  zips.forEach(function (z) {
    var coord = zipCoords[z.zipcode];
    if (!coord) { unmapped.push(z); return; }
    /* Radius: 400m min → 2000m max based on intensity. Color: light→dark green. */
    var intensity = z.count / maxZipCount;
    var radius = 400 + intensity * 1600;
    var alpha = 0.25 + intensity * 0.45;
    L.circle(coord, {
      color: '#2d7a3a',
      weight: 1.5,
      fillColor: '#2d7a3a',
      fillOpacity: alpha,
      radius: radius,
    }).addTo(map).bindPopup(
      '<strong>' + z.zipcode + '</strong><br>' + z.count + ' lead' + (z.count === 1 ? '' : 's')
    );
  });
  if (unmapped.length) {
    console.info('[dashboard] unmapped zipcodes (not in Rochester lookup):',
      unmapped.map(function (z) { return z.zipcode + '(' + z.count + ')'; }).join(', '));
  }
})();
</script>
</body>
</html>`;
}
