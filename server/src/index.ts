/*
 * Copyright 2026 SponsorBlock for TikTok contributors
 * Built on icysymmetra/tiktok-patches-for-morphe (GPL-3.0).
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * SponsorBlock for TikTok: the shared ad base.
 *
 * Phones send the audio landmarks of ads they cut, vote on each other's cuts, download the
 * whole base once a day and report how often they skipped each ad. Nothing here can identify
 * a viewer beyond the TikTok account id a phone sends with its writes, and addresses are kept
 * only as salted hashes for the daily limits.
 *
 * Routes:
 *   GET  /v1/health                 liveness
 *   GET  /v1/stats                  totals for the whole base
 *   GET  /v1/me                     the calling account's segments and what they saved others
 *   GET  /v1/db.bin                 every visible segment, built daily into R2
 *   GET  /v1/db/since?t=EPOCH       segments changed since then, hidden ones flagged
 *   POST /v1/segments               a new segment
 *   POST /v1/segments/:id/vote      +1 or -1, one per account and per address
 *   POST /v1/skips                  the day's skip counts from one phone
 */

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  /** Bursts per address. Workers rate limits only take 10 or 60 second windows. */
  SUBMIT_LIMITER: RateLimit;
  VOTE_LIMITER: RateLimit;
  READ_LIMITER: RateLimit;
  /**
   * Salts the stored address hashes. It is a Worker secret (wrangler secret put IP_SALT): with a
   * public salt anyone holding a copy of the database could hash every IPv4 address and read
   * the addresses back.
   */
  IP_SALT: string;
}

const MIN_DURATION_MS = 1_000;
const MAX_DURATION_MS = 30_000;
const MAX_NAME_LEN = 80;
const MIN_HASHES = 40;
const MAX_HASHES = 6_000;

/** A segment is hidden once it has this many votes and too many of them are down. */
const HIDE_MIN_VOTES = 5;
const HIDE_DOWN_RATIO = 0.4;
const HIDE_SCORE = -3;

/** Daily limits, counted in D1 over the last 24 hours. */
const DAY_SECONDS = 86_400;
const SUBMITS_PER_UID_DAY = 20;
const SUBMITS_PER_IP_DAY = 60;
const VOTES_PER_UID_DAY = 300;
const VOTES_PER_IP_DAY = 600;
const REPORTS_PER_DAY = 2;
/** One report claims at most this many skips of one segment, each saving at most its length. */
const MAX_REPORTED_SKIPS = 500;
const MAX_REPORT_ITEMS = 2_000;

/** Rows one delta request returns; a phone that gets a full page asks again from its last row. */
const DELTA_PAGE = 2_000;

/** Landmarks run at 8 kHz with a 256-sample hop and at most 30 peaks a second, 6 pairs each. */
const FRAMES_PER_SECOND = 8000 / 256;
const MAX_HASHES_PER_SECOND = 30 * 6;
const FRAME_SLACK = 70;

const SNAPSHOT_FORMAT = '2';
const MAGIC = 0x4244414d; // "MADB"
const VERSION = 2;

const TT_UID_RE = /^[0-9]{5,30}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SegmentRow = {
  id: string;
  num: number | null;
  frames: number;
  duration_ms: number;
  score: number;
  hidden: number;
  hash_count: number;
  hashes: ArrayBuffer;
  times: ArrayBuffer;
};

type SubmitBody = {
  name: string;
  duration_ms: number;
  source_aid?: string | null;
  frames: number;
  hashes_b64: string;
  times_b64: string;
};

type SkipItem = { id: string; n: number; ms: number };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.IP_SALT) return err(503, 'Server is not configured: IP_SALT secret is missing');
    const path = new URL(req.url).pathname.replace(/\/$/, '');
    if (req.method === 'GET') {
      if (path === '/v1/health') return json({ ok: true });
      if (path === '/v1/stats') return handleStats(env);
      if (path === '/v1/me') return handleMe(req, env);
      if (path === '/v1/db.bin') return handleFullDb(req, env);
      if (path === '/v1/db/since') return handleDelta(req, env);
    }
    if (req.method === 'POST') {
      if (path === '/v1/segments') return handleSubmit(req, env);
      if (path === '/v1/skips') return handleSkips(req, env);
      const vote = path.match(/^\/v1\/segments\/([^/]+)\/vote$/);
      if (vote) return handleVote(req, env, vote[1]);
    }
    return err(404, 'Not found');
  },

  /** Rebuilds the snapshot once a day. */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(rebuildSnapshot(env));
  },
};

async function handleStats(env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN hidden = 0 THEN 1 ELSE 0 END) AS active,
            COUNT(DISTINCT CASE WHEN hidden = 0 THEN tt_uid END) AS contributors,
            SUM(votes_up) AS votes_up,
            SUM(votes_down) AS votes_down,
            SUM(skips) AS skips,
            SUM(saved_ms) AS saved_ms
     FROM segments`,
  ).first<Record<string, number | null>>();
  return json(zeroNulls(row));
}

async function handleMe(req: Request, env: Env): Promise<Response> {
  const uid = accountOf(req);
  if (!uid) return err(401, 'Provide your TikTok uid in X-TT-UID');
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS segments, SUM(skips) AS skips, SUM(saved_ms) AS saved_ms,
            SUM(votes_up) AS votes_up, SUM(votes_down) AS votes_down
     FROM segments WHERE tt_uid = ? AND hidden = 0`,
  ).bind(uid).first<Record<string, number | null>>();
  return json(zeroNulls(row));
}

async function handleFullDb(req: Request, env: Env): Promise<Response> {
  const { success } = await env.READ_LIMITER.limit({ key: clientIp(req) });
  if (!success) return err(429, 'Too many requests');

  let obj = await env.BUCKET.get('db.bin');
  if (!obj || obj.customMetadata?.format !== SNAPSHOT_FORMAT) {
    await rebuildSnapshot(env);
    obj = await env.BUCKET.get('db.bin');
  }
  if (!obj) return err(503, 'The snapshot is not ready yet, try again in a minute');
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600',
      'Last-Modified': obj.uploaded.toUTCString(),
      'X-Db-Time': obj.customMetadata?.as_of ?? String(Math.floor(obj.uploaded.getTime() / 1000)),
    },
  });
}

/** Everything changed since t, hidden segments included and flagged so phones drop them. */
async function handleDelta(req: Request, env: Env): Promise<Response> {
  const { success } = await env.READ_LIMITER.limit({ key: clientIp(req) });
  if (!success) return err(429, 'Too many requests');

  const since = Number(new URL(req.url).searchParams.get('t') ?? '0');
  if (!Number.isFinite(since) || since < 0) return err(400, 'Bad t');

  const rows = (await env.DB.prepare(
    `SELECT id, num, frames, duration_ms, score, hidden, hash_count, hashes, times, updated_at
     FROM segments WHERE updated_at >= ? ORDER BY updated_at LIMIT ?`,
  ).bind(since, DELTA_PAGE).all<SegmentRow & { updated_at: number }>()).results ?? [];

  // A full page ends mid-way: the next request starts at its last row, which it sends again.
  const full = rows.length === DELTA_PAGE;
  const asOf = full ? rows[rows.length - 1].updated_at : nowSec();
  return new Response(pack(rows), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Db-Time': String(asOf),
      'X-Db-More': full ? '1' : '0',
    },
  });
}

async function handleSubmit(req: Request, env: Env): Promise<Response> {
  const uid = accountOf(req);
  if (!uid) return err(401, 'Provide your TikTok uid in X-TT-UID');
  const ip = clientIp(req);
  const ipHash = await hashIp(env, ip);
  if (await banned(env, uid, ipHash)) return err(403, 'Banned');

  // Over a limit the reply is 202: the phone keeps the segment and sends it another day.
  const { success } = await env.SUBMIT_LIMITER.limit({ key: 'ip:' + ip });
  if (!success) return json({ queued: true }, 202);
  const used = await countsToday(env, 'segments', uid, ipHash);
  if (used.byUid >= SUBMITS_PER_UID_DAY || used.byIp >= SUBMITS_PER_IP_DAY) return json({ queued: true }, 202);

  let body: SubmitBody;
  try {
    body = (await req.json()) as SubmitBody;
  } catch {
    return err(400, 'Invalid JSON');
  }
  const invalid = validateSubmit(body);
  if (invalid) return err(400, invalid);

  let hashes: ArrayBuffer;
  let times: ArrayBuffer;
  try {
    hashes = base64ToBuffer(body.hashes_b64);
    times = base64ToBuffer(body.times_b64);
  } catch {
    return err(400, 'Bad base64');
  }
  if (hashes.byteLength % 4 !== 0 || hashes.byteLength !== times.byteLength)
    return err(400, 'hashes and times must hold the same number of int32');
  const hashCount = hashes.byteLength / 4;
  if (hashCount < MIN_HASHES) return err(400, 'Too few audio landmarks');
  if (hashCount > MAX_HASHES) return err(400, 'Too many audio landmarks');
  const badTimes = validateTimes(times, body.frames, body.duration_ms);
  if (badTimes) return err(400, badTimes);

  // The same sound sent again, by anyone, is the segment already there.
  const same = await env.DB.prepare(
    'SELECT id, num, hidden FROM segments WHERE hash_count = ? AND hashes = ? AND times = ? LIMIT 1',
  ).bind(hashCount, hashes, times).first<{ id: string; num: number; hidden: number }>();
  if (same) {
    if (same.hidden) return err(409, 'This ad was voted down');
    return json({ id: same.id, num: same.num, duplicate: true }, 200);
  }

  const id = crypto.randomUUID();
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO segments
       (id, num, tt_uid, ip_hash, name, duration_ms, source_aid, frames,
        hash_count, hashes, times, created_at, updated_at)
     VALUES (?, (SELECT COALESCE(MAX(num), 0) + 1 FROM segments), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, uid, ipHash, body.name.trim().slice(0, MAX_NAME_LEN), body.duration_ms,
    body.source_aid ?? null, body.frames, hashCount, hashes, times, now, now,
  ).run();

  const row = await env.DB.prepare('SELECT num FROM segments WHERE id = ?').bind(id).first<{ num: number }>();
  return json({ id, num: row?.num ?? 0, queued: false }, 201);
}

async function handleVote(req: Request, env: Env, rawId: string): Promise<Response> {
  const uid = accountOf(req);
  if (!uid) return err(401, 'Provide your TikTok uid in X-TT-UID');
  if (!UUID_RE.test(rawId)) return err(400, 'Invalid segment id');
  const segmentId = rawId.toLowerCase();
  const ip = clientIp(req);
  const ipHash = await hashIp(env, ip);
  if (await banned(env, uid, ipHash)) return err(403, 'Banned');

  const { success } = await env.VOTE_LIMITER.limit({ key: 'ip:' + ip });
  if (!success) return err(429, 'Too many votes, slow down');
  const used = await countsToday(env, 'votes', uid, ipHash);
  if (used.byUid >= VOTES_PER_UID_DAY || used.byIp >= VOTES_PER_IP_DAY) return err(429, 'Too many votes today');

  let body: { vote: number };
  try {
    body = (await req.json()) as { vote: number };
  } catch {
    return err(400, 'Invalid JSON');
  }
  if (body.vote !== 1 && body.vote !== -1) return err(400, 'vote must be 1 or -1');

  const segment = await env.DB.prepare('SELECT id FROM segments WHERE id = ? AND hidden = 0')
    .bind(segmentId).first<{ id: string }>();
  if (!segment) return err(404, 'Segment not found');

  // One vote per segment per account, and per address too, since an account id is only a claim.
  const fromNetwork = await env.DB.prepare(
    'SELECT 1 AS found FROM votes WHERE segment_id = ? AND ip_hash = ? AND tt_uid != ? LIMIT 1',
  ).bind(segmentId, ipHash, uid).first<{ found: number }>();
  if (fromNetwork) return err(409, 'This segment already has a vote from your network');

  const existing = await env.DB.prepare('SELECT vote FROM votes WHERE segment_id = ? AND tt_uid = ?')
    .bind(segmentId, uid).first<{ vote: number }>();
  const now = nowSec();
  if (existing?.vote === body.vote) return json({ changed: false });
  if (existing) {
    await env.DB.prepare('UPDATE votes SET vote = ?, ip_hash = ? WHERE segment_id = ? AND tt_uid = ?')
      .bind(body.vote, ipHash, segmentId, uid).run();
  } else {
    await env.DB.prepare('INSERT INTO votes (segment_id, tt_uid, ip_hash, vote, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(segmentId, uid, ipHash, body.vote, now).run();
  }

  const tally = await env.DB.prepare(
    `SELECT SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS up,
            SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS down
     FROM votes WHERE segment_id = ?`,
  ).bind(segmentId).first<{ up: number | null; down: number | null }>();
  const up = tally?.up ?? 0;
  const down = tally?.down ?? 0;
  const score = up - down;
  const total = up + down;
  const confirmed = total >= 2 ? 1 : 0;
  const hidden = total >= HIDE_MIN_VOTES && (score <= HIDE_SCORE || down / total >= HIDE_DOWN_RATIO) ? 1 : 0;

  await env.DB.prepare(
    `UPDATE segments SET score = ?, votes_up = ?, votes_down = ?, confirmed = ?, hidden = ?, updated_at = ?
     WHERE id = ?`,
  ).bind(score, up, down, confirmed, hidden, now, segmentId).run();

  return json({ score, votes_up: up, votes_down: down, confirmed, hidden });
}

/** Adds one phone's skip counts. A reader's skips of their own segments are not counted. */
async function handleSkips(req: Request, env: Env): Promise<Response> {
  const uid = accountOf(req);
  if (!uid) return err(401, 'Provide your TikTok uid in X-TT-UID');
  const ipHash = await hashIp(env, clientIp(req));
  if (await banned(env, uid, ipHash)) return err(403, 'Banned');

  const reports = await countsToday(env, 'skip_reports', uid, ipHash);
  if (reports.byUid >= REPORTS_PER_DAY || reports.byIp >= REPORTS_PER_DAY * 5) return err(429, 'Already reported today');

  let body: { skips: SkipItem[] };
  try {
    body = (await req.json()) as { skips: SkipItem[] };
  } catch {
    return err(400, 'Invalid JSON');
  }
  if (!Array.isArray(body.skips) || body.skips.length > MAX_REPORT_ITEMS) return err(400, 'skips must be a list');

  const updates: D1PreparedStatement[] = [];
  for (const item of body.skips) {
    if (typeof item?.id !== 'string' || !UUID_RE.test(item.id)) continue;
    const n = Math.min(MAX_REPORTED_SKIPS, Math.max(0, Math.floor(Number(item.n) || 0)));
    if (n === 0) continue;
    const ms = Math.max(0, Math.floor(Number(item.ms) || 0));
    updates.push(env.DB.prepare(
      `UPDATE segments SET skips = skips + ?, saved_ms = saved_ms + MIN(?, ? * duration_ms)
       WHERE id = ? AND tt_uid != ?`,
    ).bind(n, ms, n, item.id.toLowerCase(), uid));
  }
  updates.push(env.DB.prepare('INSERT INTO skip_reports (tt_uid, ip_hash, created_at) VALUES (?, ?, ?)')
    .bind(uid, ipHash, nowSec()));
  await env.DB.batch(updates);
  return json({ counted: updates.length - 1 });
}

async function rebuildSnapshot(env: Env): Promise<void> {
  const asOf = nowSec();
  const rows = await env.DB.prepare(
    `SELECT id, num, frames, duration_ms, score, hidden, hash_count, hashes, times
     FROM segments WHERE hidden = 0 ORDER BY num`,
  ).all<SegmentRow>();
  const list = rows.results ?? [];
  await env.BUCKET.put('db.bin', pack(list), {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { as_of: String(asOf), format: SNAPSHOT_FORMAT, count: String(list.length) },
  });
  await env.DB.prepare("UPDATE meta SET value = ? WHERE key = 'last_export'").bind(String(asOf)).run();
}

/**
 * The snapshot format, little-endian: magic, version 2, count, then per segment the uuid's 16
 * bytes, num, flags (bit 0 hidden), frames, duration ms, score, hash count, the hashes and the
 * times. Snapshot.java in core/ reads it.
 */
function pack(rows: SegmentRow[]): ArrayBuffer {
  let size = 12;
  for (const row of rows) size += 40 + row.hash_count * 8;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  let at = 0;
  const u32 = (value: number) => {
    view.setUint32(at, value, true);
    at += 4;
  };
  u32(MAGIC);
  u32(VERSION);
  u32(rows.length);
  for (const row of rows) {
    new Uint8Array(buffer, at, 16).set(uuidToBytes(row.id));
    at += 16;
    u32(row.num ?? 0);
    u32(row.hidden ? 1 : 0);
    u32(row.frames);
    u32(row.duration_ms);
    view.setInt32(at, row.score, true);
    at += 4;
    u32(row.hash_count);
    for (const blob of [row.hashes, row.times]) {
      const bytes = new Uint8Array(blob);
      new Uint8Array(buffer, at, bytes.length).set(bytes);
      at += bytes.length;
    }
  }
  return buffer;
}

function validateSubmit(body: SubmitBody): string | null {
  if (typeof body?.name !== 'string' || !body.name.trim()) return 'name required';
  if (typeof body.duration_ms !== 'number' || body.duration_ms < MIN_DURATION_MS || body.duration_ms > MAX_DURATION_MS)
    return 'duration_ms must be ' + MIN_DURATION_MS + '-' + MAX_DURATION_MS;
  if (!Number.isInteger(body.frames) || body.frames <= 0) return 'frames must be a positive integer';
  if (typeof body.hashes_b64 !== 'string' || !body.hashes_b64) return 'hashes_b64 required';
  if (typeof body.times_b64 !== 'string' || !body.times_b64) return 'times_b64 required';
  if (body.source_aid != null && !/^[0-9]{0,30}$/.test(String(body.source_aid).trim()))
    return 'source_aid must be a numeric string';
  return null;
}

/** A cut whose landmarks could not come from the app's own fingerprinting is refused. */
function validateTimes(times: ArrayBuffer, frames: number, durationMs: number): string | null {
  if (frames > (durationMs / 1000) * FRAMES_PER_SECOND + FRAME_SLACK) return 'frames do not fit duration_ms';
  const count = times.byteLength / 4;
  if (count > (durationMs / 1000 + 1) * MAX_HASHES_PER_SECOND) return 'Too many landmarks for this length';
  const view = new DataView(times);
  for (let i = 0; i < count; i++) {
    const t = view.getInt32(i * 4, true);
    if (t < 0 || t > frames + FRAME_SLACK) return 'Landmark time outside the cut';
  }
  return null;
}

/** Rows this account and this address added to a table in the last 24 hours. */
async function countsToday(env: Env, table: 'segments' | 'votes' | 'skip_reports', uid: string, ipHash: string) {
  const since = nowSec() - DAY_SECONDS;
  const row = await env.DB.prepare(
    'SELECT (SELECT COUNT(*) FROM ' + table + ' WHERE tt_uid = ? AND created_at > ?) AS by_uid, ' +
      '(SELECT COUNT(*) FROM ' + table + ' WHERE ip_hash = ? AND created_at > ?) AS by_ip',
  ).bind(uid, since, ipHash, since).first<{ by_uid: number; by_ip: number }>();
  return { byUid: row?.by_uid ?? 0, byIp: row?.by_ip ?? 0 };
}

/** Whether the maintainer banned this account or address with scripts/admin.mjs. */
async function banned(env: Env, uid: string, ipHash: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS found FROM bans WHERE (kind = 'uid' AND value = ?) OR (kind = 'ip' AND value = ?) LIMIT 1",
  ).bind(uid, ipHash).first<{ found: number }>();
  return row != null;
}

function zeroNulls(row: Record<string, number | null> | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(row ?? {})) out[key] = value ?? 0;
  return out;
}

function accountOf(req: Request): string | null {
  const uid = req.headers.get('X-TT-UID')?.trim();
  return uid && TT_UID_RE.test(uid) ? uid : null;
}

function clientIp(req: Request): string {
  return req.headers.get('CF-Connecting-IP') ?? 'unknown';
}

async function hashIp(env: Env, ip: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.IP_SALT + ':' + ip));
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function err(status: number, message: string): Response {
  return json({ error: message }, status);
}
