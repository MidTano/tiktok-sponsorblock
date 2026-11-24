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
 *   node scripts/admin.mjs unban-uid <uid>
 *   node scripts/admin.mjs stats
 *
 * Hidden segments leave phones at their next daily sync. The snapshot is dropped too, so the
 * next download rebuilds it without them.
 */
import { execFileSync } from 'node:child_process';

const DATABASE = 'metra-adskip';
const BUCKET = 'sponsorblock';

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

function dropSnapshot() {
  execFileSync('npx', ['wrangler', 'r2', 'object', 'delete', BUCKET + '/db.bin', '--remote'], {
    shell: WINDOWS,
    stdio: 'inherit',
  });
}

function number(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error('Expected a segment number, like 12 for ad12');
  return n;
}

function quote(text) {
  return "'" + String(text).replace(/'/g, "''") + "'";
}

const now = () => Math.floor(Date.now() / 1000);
const [command, arg, ...rest] = process.argv.slice(2);

switch (command) {
  case 'list': {
    const where = arg === '--hidden' ? 'WHERE hidden = 1' : '';
    console.table(sql(
      'SELECT num, name, duration_ms, hash_count, score, votes_up, votes_down, skips, hidden, ' +
        "datetime(created_at, 'unixepoch') AS created FROM segments " + where + ' ORDER BY num DESC LIMIT 50'));
    break;
  }
  case 'show': {
    const n = number(arg);
    console.table(sql('SELECT num, id, tt_uid, name, duration_ms, frames, hash_count, score, votes_up, votes_down, ' +
      'skips, saved_ms, hidden, source_aid FROM segments WHERE num = ' + n));
    console.table(sql('SELECT v.tt_uid, v.vote, datetime(v.created_at, \'unixepoch\') AS at FROM votes v ' +
      'JOIN segments s ON s.id = v.segment_id WHERE s.num = ' + n));
    break;
  }
  case 'hide':
  case 'unhide': {
    const n = number(arg);
    sql('UPDATE segments SET hidden = ' + (command === 'hide' ? 1 : 0) + ', updated_at = ' + now() + ' WHERE num = ' + n);
    dropSnapshot();
    console.log((command === 'hide' ? 'Hid' : 'Restored') + ' ad' + n);
    break;
  }
  case 'ban': {
    const n = number(arg);
    const [row] = sql('SELECT tt_uid, ip_hash FROM segments WHERE num = ' + n);
    if (!row) throw new Error('No ad' + n);
    const reason = quote(rest.join(' ') || 'ad' + n);
    sql('INSERT OR IGNORE INTO bans (kind, value, reason, created_at) VALUES ' +
      "('uid', " + quote(row.tt_uid) + ', ' + reason + ', ' + now() + ')' +
      (row.ip_hash ? ", ('ip', " + quote(row.ip_hash) + ', ' + reason + ', ' + now() + ')' : ''));
    sql('UPDATE segments SET hidden = 1, updated_at = ' + now() + ' WHERE tt_uid = ' + quote(row.tt_uid) +
      (row.ip_hash ? ' OR ip_hash = ' + quote(row.ip_hash) : ''));
    dropSnapshot();
    console.log('Banned the sender of ad' + n + ' and hid everything they sent');
    break;
  }
  case 'unban-uid': {
    if (!/^[0-9]{5,30}$/.test(arg ?? '')) throw new Error('Expected a TikTok uid');
    sql("DELETE FROM bans WHERE kind = 'uid' AND value = " + quote(arg));
    console.log('Unbanned ' + arg);
    break;
  }
  case 'stats':
    console.table(sql('SELECT COUNT(*) AS segments, SUM(hidden) AS hidden, COUNT(DISTINCT tt_uid) AS senders, ' +
      'SUM(skips) AS skips, SUM(saved_ms) / 3600000.0 AS saved_hours FROM segments'));
    console.table(sql('SELECT kind, COUNT(*) AS bans FROM bans GROUP BY kind'));
    break;
  default:
    console.log('Usage: node scripts/admin.mjs list [--hidden] | show <num> | hide <num> | unhide <num> | ' +
      'ban <num> [reason] | unban-uid <uid> | stats');
    process.exitCode = command ? 1 : 0;
}
