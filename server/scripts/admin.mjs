#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Moderation for the shared ad base. It runs SQL through Wrangler, so whoever is logged in to
 * the Cloudflare account that owns the Worker is the admin; the Worker has no admin route to
 * attack.
 *
 *   node scripts/admin.mjs list [--hidden]      newest 50 segments
 *   node scripts/admin.mjs show <num>           one segment and its votes
 *   node scripts/admin.mjs hide <num>           take a segment off every phone
 *   node scripts/admin.mjs unhide <num>
 *   node scripts/admin.mjs ban <num> [reason]   ban who sent ad<num>, hide all they sent
 *   node scripts/admin.mjs unban <num>          lift the ban on who sent ad<num>
 *   node scripts/admin.mjs pending              segments held for review
 *   node scripts/admin.mjs approve <num>        release a held segment to every phone
 *   node scripts/admin.mjs export-user <num>    JSON of everything the sender of ad<num> added
 *   node scripts/admin.mjs delete-user <num>    remove everything the sender of ad<num> added
 *   node scripts/admin.mjs stats
 *
 * Hiding and banning remove a segment from every phone at its next sync. The snapshot is rebuilt
 * at the next hourly run.
 */
import { execFileSync } from 'node:child_process';

const DATABASE = 'metra-adskip';

const WINDOWS = process.platform === 'win32';

/**
 * Runs one statement. Windows needs a shell to start npx, so there the statement is passed in
 * double quotes; the statements here never contain a double quote or a percent sign.
 */
function sql(statement) {
  if (/["%]/.test(statement)) throw new Error('Statement must not contain " or %');
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', DATABASE, '--remote', '--json',
    '--command', WINDOWS ? '"' + statement + '"' : statement], {
    encoding: 'utf8',
    shell: WINDOWS,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(out)[0]?.results ?? [];
}

function markSnapshotDirty() {
  sql("UPDATE meta SET value = '1' WHERE key = 'snapshot_dirty'");
}

/** Names come from phones; control and format characters are shown as nothing. */
function printable(value) {
  return typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, '') : value;
}

function show(rows) {
  console.table(rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, printable(v)]))));
}

function number(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error('Expected a segment number, like 12 for ad12');
  return n;
}

function quote(text) {
  return "'" + String(text).replace(/'/g, "''") + "'";
}

function senderOf(n) {
  const [row] = sql('SELECT user_id, ip_hash FROM segments WHERE num = ' + n);
  if (!row) throw new Error('No ad' + n);
  return row;
}

const now = () => Math.floor(Date.now() / 1000);
const [command, arg, ...rest] = process.argv.slice(2);

switch (command) {
  case 'list': {
    const where = arg === '--hidden' ? 'WHERE hidden = 1' : '';
    show(sql(
      'SELECT num, name, duration_ms, hash_count, score, votes_up, votes_down, skips, hidden, ' +
        "datetime(created_at, 'unixepoch') AS created FROM segments " + where + ' ORDER BY num DESC LIMIT 50'));
    break;
  }
  case 'show': {
    const n = number(arg);
    show(sql('SELECT num, id, user_id, name, duration_ms, frames, hash_count, score, votes_up, votes_down, ' +
      'skips, saved_ms, hidden, source_aid FROM segments WHERE num = ' + n));
    show(sql('SELECT v.user_id, v.vote, datetime(v.created_at, \'unixepoch\') AS at FROM votes v ' +
      'JOIN segments s ON s.id = v.segment_id WHERE s.num = ' + n));
    break;
  }
  case 'hide':
  case 'unhide': {
    const n = number(arg);
    sql(command === 'hide'
      ? "UPDATE segments SET hidden = 1, status = 'removed', updated_at = " + now() + ' WHERE num = ' + n
      : "UPDATE segments SET hidden = 0, status = 'active', updated_at = " + now() + ' WHERE num = ' + n);
    markSnapshotDirty();
    console.log((command === 'hide' ? 'Hid' : 'Restored') + ' ad' + n);
    break;
  }
  case 'ban': {
    const n = number(arg);
    const row = senderOf(n);
    const reason = quote(rest.join(' ') || 'ad' + n);
    sql('INSERT OR IGNORE INTO bans (kind, value, reason, created_at) VALUES ' +
      "('user', " + quote(row.user_id) + ', ' + reason + ', ' + now() + ')' +
      (row.ip_hash ? ", ('ip', " + quote(row.ip_hash) + ', ' + reason + ', ' + now() + ')' : ''));
    sql("UPDATE segments SET hidden = 1, status = 'removed', updated_at = " + now() + ' WHERE user_id = ' + quote(row.user_id) +
      (row.ip_hash ? ' OR ip_hash = ' + quote(row.ip_hash) : ''));
    markSnapshotDirty();
    console.log('Banned the sender of ad' + n + ' and hid everything they sent');
    break;
  }
  case 'unban': {
    const n = number(arg);
    const row = senderOf(n);
    sql("DELETE FROM bans WHERE (kind = 'user' AND value = " + quote(row.user_id) + ')' +
      (row.ip_hash ? " OR (kind = 'ip' AND value = " + quote(row.ip_hash) + ')' : ''));
    console.log('Lifted the ban on the sender of ad' + n);
    break;
  }
  case 'pending': {
    show(sql("SELECT num, name, duration_ms, hash_count, datetime(created_at, 'unixepoch') AS created FROM segments WHERE status = 'pending' ORDER BY num"));
    break;
  }
  case 'approve': {
    const n = number(arg);
    sql("UPDATE segments SET status = 'active', updated_at = " + now() + ' WHERE num = ' + n + " AND status = 'pending'");
    markSnapshotDirty();
    console.log('Released ad' + n);
    break;
  }
  case 'export-user': {
    const row = senderOf(number(arg));
    const segments = sql('SELECT num, name, duration_ms, frames, hash_count, score, hidden, skips, saved_ms, ' +
      "datetime(created_at, 'unixepoch') AS created FROM segments WHERE user_id = " + quote(row.user_id));
    const votes = sql('SELECT s.num, v.vote, datetime(v.created_at, \'unixepoch\') AS at FROM votes v ' +
      'JOIN segments s ON s.id = v.segment_id WHERE v.user_id = ' + quote(row.user_id));
    console.log(JSON.stringify({ segments: segments.map((s) => ({ ...s, name: printable(s.name) })), votes }, null, 2));
    break;
  }
  case 'delete-user': {
    const n = number(arg);
    const row = senderOf(n);
    const user = quote(row.user_id);
    const owned = 'SELECT id FROM segments WHERE user_id = ' + user;
    sql('DELETE FROM skip_inbox WHERE segment_id IN (' + owned + ')');
    sql('DELETE FROM votes WHERE segment_id IN (' + owned + ') OR user_id = ' + user);
    sql('DELETE FROM skip_reports WHERE user_id = ' + user);
    sql('DELETE FROM segments WHERE user_id = ' + user);
    markSnapshotDirty();
    console.log('Deleted everything the sender of ad' + n + ' added');
    break;
  }
  case 'stats': {
    show(sql('SELECT COUNT(*) AS segments, SUM(hidden) AS hidden, COUNT(DISTINCT user_id) AS senders, ' +
      'SUM(skips) AS skips, SUM(saved_ms) / 3600000.0 AS saved_hours FROM segments'));
    show(sql('SELECT kind, COUNT(*) AS bans FROM bans GROUP BY kind'));
    break;
  }
  default:
    console.log('Usage: node scripts/admin.mjs list [--hidden] | show <num> | hide <num> | unhide <num> | ' +
      'ban <num> [reason] | unban <num> | pending | approve <num> | export-user <num> | delete-user <num> | stats');
    process.exitCode = command ? 1 : 0;
}
