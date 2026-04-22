#!/usr/bin/env node
'use strict';
/**
 * One-off import: Mailchimp subscriber CSV → leads table.
 *
 * CSV format (no header):
 *   email,zipcode,M/D/YY HH:MM
 *
 * Fields missing in the CSV (first_name, last_name, street, city, state)
 * are inserted as empty strings — schema NOT NULL allows that. Imported rows
 * are tagged with form_location='mailchimp_import' so they can be filtered
 * out of "real form submissions" queries and identified in the /dashboard.
 *
 * Usage:
 *   DB_HOST=... DB_PORT=3306 DB_USER=... DB_PASSWORD=... DB_DB=... \
 *     node scripts/import_mailchimp_csv.js path/to/export.csv
 *
 * Flags:
 *   --dry-run   Parse + report counts without writing to the DB
 *   --verbose   Print each inserted email
 *
 * Idempotent: skips rows where (email, created_at) already exists.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const csvPath = args.find(a => !a.startsWith('--'));
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');

if (!csvPath) {
  console.error('Usage: node scripts/import_mailchimp_csv.js <csv-path> [--dry-run] [--verbose]');
  process.exit(1);
}
if (!fs.existsSync(csvPath)) {
  console.error(`File not found: ${csvPath}`);
  process.exit(1);
}

const { DB_HOST, DB_PORT = '3306', DB_USER, DB_PASSWORD, DB_DB } = process.env;
if (!DRY_RUN && (!DB_HOST || !DB_USER || !DB_PASSWORD || !DB_DB)) {
  console.error('Missing DB env vars. Required: DB_HOST, DB_USER, DB_PASSWORD, DB_DB (DB_PORT optional, default 3306)');
  process.exit(1);
}

/* ── Parse "M/D/YY HH:MM" (24-hour) into MySQL DATETIME ────────────────── */
function parseMailchimpDate(s) {
  const trimmed = String(s || '').trim();
  if (!trimmed) return null;
  const [datePart, timePart = '00:00'] = trimmed.split(/\s+/);
  const [mStr, dStr, yStr] = datePart.split('/');
  const [hStr, minStr] = timePart.split(':');
  const m = parseInt(mStr, 10);
  const d = parseInt(dStr, 10);
  const yRaw = parseInt(yStr, 10);
  const hh = parseInt(hStr, 10) || 0;
  const mm = parseInt(minStr, 10) || 0;
  if (!m || !d || isNaN(yRaw)) return null;
  const year = yRaw < 100 ? (yRaw < 50 ? 2000 + yRaw : 1900 + yRaw) : yRaw;
  const pad = n => String(n).padStart(2, '0');
  return `${year}-${pad(m)}-${pad(d)} ${pad(hh)}:${pad(mm)}:00`;
}

/* ── Simple CSV split that tolerates quoted fields with commas ─────────── */
function splitCsvLine(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

async function main() {
  const raw = fs.readFileSync(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);

  const rows = [];
  const invalid = [];
  for (const [idx, line] of lines.entries()) {
    const cols = splitCsvLine(line);
    const [email, zipcode = '', submitted = ''] = cols;
    const lineNo = idx + 1;

    if (!email || !email.includes('@')) {
      invalid.push({ lineNo, reason: 'invalid email', line });
      continue;
    }
    const created_at = parseMailchimpDate(submitted);
    if (!created_at) {
      invalid.push({ lineNo, reason: `unparseable date: ${submitted}`, line });
      continue;
    }
    const cleanZip = String(zipcode || '').replace(/\D/g, '').slice(0, 5);
    rows.push({ email: email.toLowerCase(), zipcode: cleanZip, created_at });
  }

  console.log(`Parsed: ${rows.length} valid rows, ${invalid.length} invalid`);
  if (invalid.length) {
    console.log('First 5 invalid rows:');
    invalid.slice(0, 5).forEach(r => console.log(`  line ${r.lineNo}: ${r.reason}`));
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: no DB writes performed');
    console.log('Sample rows:');
    rows.slice(0, 3).forEach(r => console.log(`  ${JSON.stringify(r)}`));
    return;
  }

  /* Lazy-require so --dry-run works without installing deps locally. */
  const mysql = require('mysql2/promise');

  const pool = mysql.createPool({
    host: DB_HOST,
    port: parseInt(DB_PORT, 10),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_DB,
    waitForConnections: true,
    connectionLimit: 5,
  });

  let inserted = 0, skipped = 0, errored = 0;

  for (const r of rows) {
    try {
      const [dupe] = await pool.query(
        'SELECT id FROM leads WHERE email = ? AND created_at = ? LIMIT 1',
        [r.email, r.created_at]
      );
      if (dupe.length > 0) {
        skipped++;
        if (VERBOSE) console.log(`  skip (dupe): ${r.email} @ ${r.created_at}`);
        continue;
      }

      await pool.query(
        `INSERT INTO leads
         (created_at, first_name, last_name, email, street, city, state, zipcode, form_location)
         VALUES (?, '', '', ?, '', '', '', ?, 'mailchimp_import')`,
        [r.created_at, r.email, r.zipcode]
      );
      inserted++;
      if (VERBOSE) console.log(`  ✓ ${r.email} @ ${r.created_at}`);
    } catch (err) {
      errored++;
      console.error(`  ✗ ${r.email}: ${err.message}`);
    }
  }

  console.log(`\nImport complete.`);
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Skipped (duplicates): ${skipped}`);
  console.log(`  Errored: ${errored}`);
  console.log(`  Total rows processed: ${rows.length}`);

  await pool.end();
}

main().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
