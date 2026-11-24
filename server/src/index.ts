/*
 * Copyright 2026 SponsorBlock for TikTok contributors
 * Built on icysymmetra/tiktok-patches-for-morphe (GPL-3.0).
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * SponsorBlock for TikTok: the shared ad base.
 *
 * Phones send the audio landmarks of ads they cut, vote on each other's cuts, download the
 * whole base once a day and report how often they skipped each ad. A phone identifies itself
 * with a random sync token; the base keeps only a keyed hash of it, never the token. Addresses
 * are kept only as keyed hashes for the daily limits.
 *
 * Routes:
 *   GET  /v1/health                 liveness
 *   GET  /v1/stats                  totals for the whole base
 *   GET  /v1/me                     the caller's segments and what they saved others
 *   GET  /v1/db.bin                 every visible segment, built into R2 when due
 *   GET  /v1/db/since?t=EPOCH       segments changed since then, hidden ones flagged
 *   POST /v1/segments               a new segment
 *   POST /v1/segments/:id/vote      +1 or -1, one per account and per network
 *   POST /v1/skips                  the day's skip counts from one phone
 */

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  /** Bursts per network. Workers rate limits only take 10 or 60 second windows. */
  SUBMIT_LIMITER: RateLimit;
  VOTE_LIMITER: RateLimit;
  READ_LIMITER: RateLimit;
  /**
   * Salts the stored network hashes. It is a Worker secret (wrangler secret put IP_SALT): with a
   * public salt anyone holding a copy of the database could hash every IPv4 address and read
   * the addresses back.
   */
  IP_SALT: string;
  /** Keys the account hashes, so a copy of the database does not name any TikTok account. */
  USER_SECRET: string;
}

const MIN_DURATION_MS = 1_000;
const MAX_DURATION_MS = 30_000;
const MAX_NAME_LEN = 80;
const MIN_HASHES = 40;
const MAX_HASHES = 6_000;
/** A landmark value may repeat this often in one segment, and at least this share must differ. */
const MAX_REPEATS = 40;
const MIN_DISTINCT_RATIO = 0.3;

/** A segment is hidden once it has this many votes and too many of them are down. */
const HIDE_MIN_VOTES = 5;
const FRESH_HIDE_DOWN_VOTES = 2;
/** An account with this many hidden segments has its new segments held for review. */
const STRIKES_FOR_REVIEW = 2;
const HIDE_DOWN_RATIO = 0.4;
const HIDE_SCORE = -3;

/** Daily limits, counted in D1 over the last 24 hours. */
const DAY_SECONDS = 86_400;
/** A segment this young is hidden by two down-votes that outnumber the up-votes. */
const FRESH_SECONDS = 2 * DAY_SECONDS;
const SUBMITS_PER_UID_DAY = 20;
const SUBMITS_PER_IP_DAY = 60;
const NEW_SEGMENTS_PER_DAY = 300;
const VOTES_PER_UID_DAY = 300;
const VOTES_PER_IP_DAY = 600;
const REPORTS_PER_DAY = 2;
/** One report claims at most this many skips of one segment, each saving at most its length. */
const MAX_REPORTED_SKIPS = 500;
const MAX_REPORT_IDS = 200;
const MAX_SUBMIT_BODY = 256 * 1024;
const MAX_SMALL_BODY = 64 * 1024;

/** A delta page scans at most DELTA_SCAN rows and returns as many as fit in DELTA_BYTES. */
const DELTA_SCAN = 2_000;
const DELTA_BYTES = 4 * 1024 * 1024;
/** R2 multipart parts other than the last must be at least 5 MiB. */
const SNAPSHOT_PART_BYTES = 5 * 1024 * 1024;
const SNAPSHOT_PAGE = 200;

/** Keeps the source video id and the address hashes for this long, then clears them. */
const SOURCE_RETENTION_SECONDS = 30 * DAY_SECONDS;
const REPORT_RETENTION_SECONDS = 3 * DAY_SECONDS;

/**
 * Until this instant the old X-TT-UID header is still accepted. It is keyed like a token, so the
 * account id is never stored, and the header stops working after it.
 */
const LEGACY_UID_UNTIL = Date.UTC(2027, 0, 23);

/** Landmarks run at 8 kHz with a 256-sample hop and at most 30 peaks a second, 6 pairs each. */
const FRAMES_PER_SECOND = 8000 / 256;
const MAX_HASHES_PER_SECOND = 30 * 6;
/**
 * The app caps peaks per 31-frame block of the whole video, and a cut starts anywhere inside a
 * block, so any 31 frames of a cut can hold the hashes of two blocks.
 */
const APP_FRAMES_PER_BLOCK = 31;
const FRAME_SLACK = 70;

const SNAPSHOT_FORMAT = '2';
const MAGIC = 0x4244414d; // "MADB"
const VERSION = 2;

const TT_UID_RE = /^[0-9]{5,30}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
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

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (failure) {
      if (failure instanceof HttpError) return err(failure.status, failure.message);
      const requestId = crypto.randomUUID();
      console.error('request ' + requestId, failure);
      return json({ error: 'Internal error', request_id: requestId }, 500);
    }
  },

  /** Merges queued skip counts, refreshes the stats and clears old addresses, every hour. */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(maintain(env));
  },
};

async function route(req: Request, env: Env): Promise<Response> {
  if (!env.IP_SALT) return err(503, 'Server is not configured: IP_SALT secret is missing');
  if (!env.USER_SECRET) return err(503, 'Server is not configured: USER_SECRET secret is missing');
  const path = new URL(req.url).pathname.replace(/\/$/, '');
  if (req.method === 'GET') {
    if (path === '/v1/health') return json({ ok: true });
    if (path === '/v1/stats') return handleStats(req, env);
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
}

async function handleStats(req: Request, env: Env): Promise<Response> {
  const { success } = await env.READ_LIMITER.limit({ key: 'ip:' + clientNetwork(req) });
  if (!success) return err(429, 'Too many requests');
  const cached = await env.DB.prepare("SELECT value FROM meta WHERE key = 'stats'").first<{ value: string }>();
  const body = cached ? cached.value : JSON.stringify(await refreshStats(env));
  return new Response(body, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });
}

async function handleMe(req: Request, env: Env): Promise<Response> {
  const user = await userOf(req, env);
  const { success } = await env.READ_LIMITER.limit({ key: 'ip:' + clientNetwork(req) });
  if (!success) return err(429, 'Too many requests');
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS segments, SUM(skips) AS skips, SUM(saved_ms) AS saved_ms,
            SUM(votes_up) AS votes_up, SUM(votes_down) AS votes_down
     FROM segments WHERE user_id = ? AND hidden = 0`,
  ).bind(user).first<Record<string, number | null>>();
  return json(zeroNulls(row));
}

async function handleFullDb(req: Request, env: Env): Promise<Response> {
  const { success } = await env.READ_LIMITER.limit({ key: 'ip:' + clientNetwork(req) });
  if (!success) return err(429, 'Too many requests');

  const obj = await env.BUCKET.get('db.bin');
  if (!obj || obj.customMetadata?.format !== SNAPSHOT_FORMAT) {
    return json({ error: 'The snapshot is not ready yet, try again later' }, 503, { 'Retry-After': '300' });
  }
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600',
      'Last-Modified': obj.uploaded.toUTCString(),
      'X-Db-Time': obj.customMetadata?.as_of ?? String(Math.floor(obj.uploaded.getTime() / 1000)),
    },
  });
}

/**
 * Everything changed since t, hidden segments included and flagged so phones drop them. A page
 * holds the segments, in order, that fit in DELTA_BYTES; the rest come with the next request.
 */
async function handleDelta(req: Request, env: Env): Promise<Response> {
  const { success } = await env.READ_LIMITER.limit({ key: 'ip:' + clientNetwork(req) });
  if (!success) return err(429, 'Too many requests');

  const since = Number(new URL(req.url).searchParams.get('t') ?? '0');
  if (!Number.isFinite(since) || since < 0) return err(400, 'Bad t');

  const scan = (await env.DB.prepare(
    `SELECT id, updated_at, 40 + hash_count * 8 AS bytes FROM segments
     WHERE updated_at >= ? AND status != 'pending' ORDER BY updated_at, id LIMIT ?`,
  ).bind(since, DELTA_SCAN).all<{ id: string; updated_at: number; bytes: number }>()).results ?? [];

  let total = 0;
  let take = 0;
  while (take < scan.length && (take === 0 || total + scan[take].bytes <= DELTA_BYTES)) total += scan[take++].bytes;
  const last = scan[take - 1];
  const more = take < scan.length || scan.length === DELTA_SCAN;

  const rows = last
    ? (await env.DB.prepare(
        `SELECT id, num, frames, duration_ms, score, hidden, hash_count, hashes, times, updated_at FROM segments
         WHERE updated_at >= ? AND status != 'pending' AND (updated_at < ? OR (updated_at = ? AND id <= ?))
         ORDER BY updated_at, id`,
      ).bind(since, last.updated_at, last.updated_at, last.id).all<SegmentRow & { updated_at: number }>()).results ?? []
    : [];

  const asOf = more && last ? last.updated_at : nowSec();
  return new Response(packRows(rows), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Db-Time': String(asOf),
      'X-Db-More': more ? '1' : '0',
    },
  });
}

async function handleSubmit(req: Request, env: Env): Promise<Response> {
  const user = await userOf(req, env);
  const net = clientNetwork(req);
  const netHash = await hashNetwork(env, net);
  if (await banned(env, user, netHash)) return err(403, 'Banned');

  // Over a limit the reply is 202: the phone keeps the segment and sends it another day.
  const { success } = await env.SUBMIT_LIMITER.limit({ key: 'ip:' + net });
  if (!success) return json({ queued: true }, 202);
  const used = await countsToday(env, 'segments', user, netHash);
  if (used.byUid >= SUBMITS_PER_UID_DAY || used.byIp >= SUBMITS_PER_IP_DAY) return json({ queued: true }, 202);
  const day = await env.DB.prepare('SELECT COUNT(*) AS n FROM segments WHERE created_at > ?')
    .bind(nowSec() - DAY_SECONDS).first<{ n: number }>();
  if ((day?.n ?? 0) >= NEW_SEGMENTS_PER_DAY) return json({ queued: true }, 202);

  const body = await readJson<SubmitBody>(req, MAX_SUBMIT_BODY);
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
  const badPrint = validatePrint(hashes, times);
  if (badPrint) return err(400, badPrint);

  const strikes = await env.DB.prepare('SELECT COUNT(*) AS n FROM segments WHERE user_id = ? AND hidden = 1')
    .bind(user).first<{ n: number }>();
  const status = (strikes?.n ?? 0) >= STRIKES_FOR_REVIEW ? 'pending' : 'active';

  const id = crypto.randomUUID();
  const now = nowSec();
  for (let attempt = 0; ; attempt++) {
    try {
      await env.DB.prepare(
        `INSERT INTO segments
           (id, num, user_id, ip_hash, name, duration_ms, source_aid, frames,
            hash_count, hashes, times, status, created_at, updated_at)
         VALUES (?, (SELECT COALESCE(MAX(num), 0) + 1 FROM segments), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id, user, netHash, cleanName(body.name), body.duration_ms,
        body.source_aid ?? null, body.frames, hashCount, hashes, times, status, now, now,
      ).run();
      break;
    } catch (failure) {
      // Two phones sending at once can both read the same highest number; the second retries.
      if (attempt === 2 || !String(failure).includes('UNIQUE')) throw failure;
    }
  }

  const row = await env.DB.prepare('SELECT num FROM segments WHERE id = ?').bind(id).first<{ num: number }>();
  return json({ id, num: row?.num ?? 0, queued: false, pending: status === 'pending' }, 201);
}

async function handleVote(req: Request, env: Env, rawId: string): Promise<Response> {
  const user = await userOf(req, env);
  if (!UUID_RE.test(rawId)) return err(400, 'Invalid segment id');
  const segmentId = rawId.toLowerCase();
  const net = clientNetwork(req);
  const netHash = await hashNetwork(env, net);
  if (await banned(env, user, netHash)) return err(403, 'Banned');

  const { success } = await env.VOTE_LIMITER.limit({ key: 'ip:' + net });
  if (!success) return err(429, 'Too many votes, slow down');
  const used = await countsToday(env, 'votes', user, netHash);
  if (used.byUid >= VOTES_PER_UID_DAY || used.byIp >= VOTES_PER_IP_DAY) return err(429, 'Too many votes today');

  const body = await readJson<{ vote: number }>(req, MAX_SMALL_BODY);
  if (body.vote !== 1 && body.vote !== -1) return err(400, 'vote must be 1 or -1');

  const segment = await env.DB.prepare("SELECT id, user_id, created_at FROM segments WHERE id = ? AND status = 'active'")
    .bind(segmentId).first<{ id: string; user_id: string; created_at: number }>();
  if (!segment) return err(404, 'Segment not found');
  if (segment.user_id === user) return err(409, 'You cannot vote on your own segment');

  // One vote per segment per account, and per network too, since an account id is only a claim.
  const fromNetwork = await env.DB.prepare(
    'SELECT 1 AS found FROM votes WHERE segment_id = ? AND ip_hash = ? AND user_id != ? LIMIT 1',
  ).bind(segmentId, netHash, user).first<{ found: number }>();
  if (fromNetwork) return err(409, 'This segment already has a vote from your network');

  const existing = await env.DB.prepare('SELECT vote FROM votes WHERE segment_id = ? AND user_id = ?')
    .bind(segmentId, user).first<{ vote: number }>();
  const now = nowSec();
  if (existing?.vote === body.vote) return json({ changed: false });
  if (existing) {
    await env.DB.prepare('UPDATE votes SET vote = ?, ip_hash = ? WHERE segment_id = ? AND user_id = ?')
      .bind(body.vote, netHash, segmentId, user).run();
  } else {
    await env.DB.prepare('INSERT INTO votes (segment_id, user_id, ip_hash, vote, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(segmentId, user, netHash, body.vote, now).run();
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
  const fresh = now - segment.created_at < FRESH_SECONDS;
  const hidden = (total >= HIDE_MIN_VOTES && (score <= HIDE_SCORE || down / total >= HIDE_DOWN_RATIO))
    || (fresh && down >= FRESH_HIDE_DOWN_VOTES && down > up) ? 1 : 0;

  await env.DB.prepare(
    `UPDATE segments SET score = ?, votes_up = ?, votes_down = ?, confirmed = ?, hidden = ?, updated_at = ?
     WHERE id = ?`,
  ).bind(score, up, down, confirmed, hidden, now, segmentId).run();

  return json({ score, votes_up: up, votes_down: down, confirmed, hidden });
}

/**
 * Queues one phone's skip counts. They reach the segments at the next hourly merge, so a report
 * costs one batch instead of one update per segment. A reader's skips of their own segments are
 * not counted.
 */
async function handleSkips(req: Request, env: Env): Promise<Response> {
  const user = await userOf(req, env);
  const netHash = await hashNetwork(env, clientNetwork(req));
  if (await banned(env, user, netHash)) return err(403, 'Banned');

  const reports = await countsToday(env, 'skip_reports', user, netHash);
  if (reports.byUid >= REPORTS_PER_DAY || reports.byIp >= REPORTS_PER_DAY * 5) return err(429, 'Already reported today');

  const body = await readJson<{ skips: SkipItem[] }>(req, MAX_SMALL_BODY);
  if (!Array.isArray(body.skips)) return err(400, 'skips must be a list');

  const merged = new Map<string, SkipItem>();
  for (const item of body.skips) {
    if (typeof item?.id !== 'string' || !UUID_RE.test(item.id)) continue;
    const id = item.id.toLowerCase();
    const current = merged.get(id) ?? { id, n: 0, ms: 0 };
    current.n = Math.min(MAX_REPORTED_SKIPS, current.n + Math.max(0, Math.floor(Number(item.n) || 0)));
    current.ms += Math.max(0, Math.floor(Number(item.ms) || 0));
    merged.set(id, current);
  }
  if (merged.size > MAX_REPORT_IDS) return err(400, 'A report covers at most ' + MAX_REPORT_IDS + ' segments');

  const now = nowSec();
  const statements: D1PreparedStatement[] = [];
  for (const item of merged.values()) {
    if (item.n === 0) continue;
    statements.push(env.DB.prepare(
      `INSERT INTO skip_inbox (segment_id, n, ms, created_at)
       SELECT id, ?, MIN(?, ? * duration_ms), ? FROM segments WHERE id = ? AND user_id != ? AND hidden = 0`,
    ).bind(item.n, item.ms, item.n, now, item.id, user));
  }
  statements.push(env.DB.prepare('INSERT INTO skip_reports (user_id, ip_hash, created_at) VALUES (?, ?, ?)')
    .bind(user, netHash, now));
  await env.DB.batch(statements);
  return json({ ok: true });
}

/** Moves the queued skip counts onto their segments, up to the newest queued row. */
async function flushSkipInbox(env: Env): Promise<void> {
  const top = await env.DB.prepare('SELECT MAX(rowid) AS top FROM skip_inbox').first<{ top: number | null }>();
  if (!top?.top) return;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE segments SET
         skips = skips + (SELECT SUM(n) FROM skip_inbox WHERE skip_inbox.segment_id = segments.id AND skip_inbox.rowid <= ?),
         saved_ms = saved_ms + (SELECT SUM(ms) FROM skip_inbox WHERE skip_inbox.segment_id = segments.id AND skip_inbox.rowid <= ?)
       WHERE id IN (SELECT segment_id FROM skip_inbox WHERE rowid <= ?)`,
    ).bind(top.top, top.top, top.top),
    env.DB.prepare('DELETE FROM skip_inbox WHERE rowid <= ?').bind(top.top),
  ]);
}

async function refreshStats(env: Env): Promise<Record<string, number>> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN hidden = 0 THEN 1 ELSE 0 END) AS active,
            COUNT(DISTINCT CASE WHEN hidden = 0 THEN user_id END) AS contributors,
            SUM(votes_up) AS votes_up,
            SUM(votes_down) AS votes_down,
            SUM(skips) AS skips,
            SUM(saved_ms) AS saved_ms
     FROM segments`,
  ).first<Record<string, number | null>>();
  const stats = zeroNulls(row);
  await env.DB.prepare(
    "INSERT INTO meta (key, value) VALUES ('stats', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).bind(JSON.stringify(stats)).run();
  return stats;
}

/** Clears the source video ids and address hashes that are past their retention. */
async function clearOldRecords(env: Env): Promise<void> {
  const now = nowSec();
  const sourceCutoff = now - SOURCE_RETENTION_SECONDS;
  await env.DB.batch([
    env.DB.prepare('UPDATE segments SET source_aid = NULL, ip_hash = NULL WHERE created_at < ? AND (source_aid IS NOT NULL OR ip_hash IS NOT NULL)')
      .bind(sourceCutoff),
    env.DB.prepare('UPDATE votes SET ip_hash = NULL WHERE created_at < ? AND ip_hash IS NOT NULL').bind(sourceCutoff),
    env.DB.prepare('DELETE FROM skip_reports WHERE created_at < ?').bind(now - REPORT_RETENTION_SECONDS),
  ]);
}

async function maintain(env: Env): Promise<void> {
  await flushSkipInbox(env);
  await refreshStats(env);
  await clearOldRecords(env);
  const dirty = await env.DB.prepare("SELECT value FROM meta WHERE key = 'snapshot_dirty'").first<{ value: string }>();
  if (dirty?.value === '1' || new Date().getUTCHours() === 1) await rebuildSnapshot(env);
}

/**
 * Builds the snapshot as an R2 multipart upload, a page of segments at a time, so the whole base
 * never sits in memory. The flag is cleared before the build, so a change made during it sets
 * the flag again and the next hourly run rebuilds.
 */
async function rebuildSnapshot(env: Env): Promise<void> {
  const asOf = nowSec();
  await env.DB.prepare("UPDATE meta SET value = '0' WHERE key = 'snapshot_dirty'").run();
  const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM segments WHERE hidden = 0 AND status = 'active'")
    .first<{ n: number }>())?.n ?? 0;
  const upload = await env.BUCKET.createMultipartUpload('db.bin', {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { as_of: String(asOf), format: SNAPSHOT_FORMAT, count: String(count) },
  });
  try {
    const parts: R2UploadedPart[] = [];
    let pending: Uint8Array[] = [snapshotHeader(count)];
    let pendingBytes = 12;
    let lastNum = 0;
    for (;;) {
      const rows = (await env.DB.prepare(
        `SELECT id, num, frames, duration_ms, score, hidden, hash_count, hashes, times FROM segments
         WHERE hidden = 0 AND status = 'active' AND num > ? ORDER BY num LIMIT ?`,
      ).bind(lastNum, SNAPSHOT_PAGE).all<SegmentRow>()).results ?? [];
      if (rows.length === 0) break;
      for (const row of rows) {
        const bytes = encodeRow(row);
        pending.push(bytes);
        pendingBytes += bytes.byteLength;
      }
      const next = rows[rows.length - 1].num;
      if (next == null) throw new Error('A segment has no number');
      lastNum = next;
      if (pendingBytes >= SNAPSHOT_PART_BYTES) {
        parts.push(await upload.uploadPart(parts.length + 1, concatBytes(pending)));
        pending = [];
        pendingBytes = 0;
      }
    }
    if (pending.length > 0) parts.push(await upload.uploadPart(parts.length + 1, concatBytes(pending)));
    await upload.complete(parts);
  } catch (failure) {
    await upload.abort();
    throw failure;
  }
  await env.DB.prepare("UPDATE meta SET value = ? WHERE key = 'last_export'").bind(String(asOf)).run();
}

/**
 * The snapshot format, little-endian: magic, version 2, count, then per segment the uuid's 16
 * bytes, num, flags (bit 0 hidden), frames, duration ms, score, hash count, the hashes and the
 * times. Snapshot.java in core/ reads it.
 */
function packRows(rows: SegmentRow[]): ArrayBuffer {
  const bytes = concatBytes([snapshotHeader(rows.length), ...rows.map(encodeRow)]);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function snapshotHeader(count: number): Uint8Array {
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, count, true);
  return header;
}

function encodeRow(row: SegmentRow): Uint8Array {
  const out = new Uint8Array(40 + row.hash_count * 8);
  const view = new DataView(out.buffer);
  out.set(uuidToBytes(row.id), 0);
  view.setUint32(16, row.num ?? 0, true);
  view.setUint32(20, row.hidden ? 1 : 0, true);
  view.setUint32(24, row.frames, true);
  view.setUint32(28, row.duration_ms, true);
  view.setInt32(32, row.score, true);
  view.setUint32(36, row.hash_count, true);
  out.set(new Uint8Array(row.hashes), 40);
  out.set(new Uint8Array(row.times), 40 + row.hash_count * 4);
  return out;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * Removes control and format characters, which would hide text or bend the display, and keeps
 * the name to MAX_NAME_LEN code points, so a surrogate pair is never cut in half.
 */
function cleanName(raw: string): string {
  const text = raw.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === '\u200D' ? char : ''));
  return Array.from(text.trim()).slice(0, MAX_NAME_LEN).join('');
}

function validateSubmit(body: SubmitBody): string | null {
  if (typeof body?.name !== 'string' || !cleanName(body.name)) return 'name required';
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

/** A print the app's own fingerprinting could make: valid pairs, in time order, not flooding one second or repeating one value. */
function validatePrint(hashes: ArrayBuffer, times: ArrayBuffer): string | null {
  const hashView = new DataView(hashes);
  const timeView = new DataView(times);
  const count = hashes.byteLength / 4;
  const repeats = new Map<number, number>();
  const perSecond = new Map<number, number>();
  let previous = -1;
  for (let i = 0; i < count; i++) {
    const hash = hashView.getInt32(i * 4, true);
    const t = timeView.getInt32(i * 4, true);
    const f1 = hash >>> 15;
    const f2 = (hash >>> 6) & 511;
    const dt = hash & 63;
    if (dt === 0 || f1 >= 448 || f2 >= 448 || Math.abs(f1 - f2) > 120) return 'A landmark is not one the app makes';
    if (t < previous) return 'Landmark times go backwards';
    previous = t;
    const repeated = (repeats.get(hash) ?? 0) + 1;
    repeats.set(hash, repeated);
    if (repeated > MAX_REPEATS) return 'One landmark repeats too often';
    const second = Math.floor(t / APP_FRAMES_PER_BLOCK);
    const landed = (perSecond.get(second) ?? 0) + 1;
    perSecond.set(second, landed);
    if (landed > 2 * MAX_HASHES_PER_SECOND) return 'Too many landmarks in one second';
  }
  if (repeats.size < count * MIN_DISTINCT_RATIO) return 'Too few different landmarks';
  return null;
}

/** Rows this account and this network added to a table in the last 24 hours. */
async function countsToday(env: Env, table: 'segments' | 'votes' | 'skip_reports', user: string, netHash: string) {
  const since = nowSec() - DAY_SECONDS;
  const row = await env.DB.prepare(
    'SELECT (SELECT COUNT(*) FROM ' + table + ' WHERE user_id = ? AND created_at > ?) AS by_uid, ' +
      '(SELECT COUNT(*) FROM ' + table + ' WHERE ip_hash = ? AND created_at > ?) AS by_ip',
  ).bind(user, since, netHash, since).first<{ by_uid: number; by_ip: number }>();
  return { byUid: row?.by_uid ?? 0, byIp: row?.by_ip ?? 0 };
}

/** Whether the maintainer banned this account or network with scripts/admin.mjs. */
async function banned(env: Env, user: string, netHash: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS found FROM bans WHERE (kind = 'user' AND value = ?) OR (kind = 'ip' AND value = ?) LIMIT 1",
  ).bind(user, netHash).first<{ found: number }>();
  return row != null;
}

/**
 * The account a request acts for: a keyed hash of the sync token the phone keeps, or until
 * LEGACY_UID_UNTIL, of the TikTok account id it still sends. Either way only the hash is used.
 */
async function userOf(req: Request, env: Env): Promise<string> {
  const token = req.headers.get('X-SB-Token')?.trim();
  if (token) {
    if (!TOKEN_RE.test(token)) throw new HttpError(401, 'The sync token is not valid');
    return 'sb:' + (await hmacHex(env.USER_SECRET, token)).slice(0, 32);
  }
  const uid = req.headers.get('X-TT-UID')?.trim();
  if (uid && TT_UID_RE.test(uid) && Date.now() < LEGACY_UID_UNTIL) {
    return 'tt:' + (await hmacHex(env.USER_SECRET, uid)).slice(0, 32);
  }
  throw new HttpError(401, 'Provide your sync token in X-SB-Token');
}

async function readJson<T>(req: Request, limit: number): Promise<T> {
  if (!req.headers.get('Content-Type')?.startsWith('application/json')) throw new HttpError(415, 'Send application/json');
  const declared = Number(req.headers.get('Content-Length') ?? '0');
  if (declared > limit) throw new HttpError(413, 'Request body too large');
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, 'Invalid JSON');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, 'Request body too large');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(new TextDecoder().decode(concatBytes(chunks))) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function zeroNulls(row: Record<string, number | null> | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(row ?? {})) out[key] = value ?? 0;
  return out;
}

/**
 * The network a request comes from: the address of an IPv4 client, or the first 64 bits of an
 * IPv6 one. A household or mobile carrier owns a whole /64, so counting single addresses would
 * let one customer rotate through unlimited quota.
 */
function clientNetwork(req: Request): string {
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const fill = new Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0');
  return [...headGroups, ...fill, ...tailGroups].slice(0, 4).map((group) => group.padStart(4, '0')).join(':');
}

async function hashNetwork(env: Env, net: string): Promise<string> {
  return (await hmacHex(env.IP_SALT, net)).slice(0, 24);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
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

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function err(status: number, message: string): Response {
  return json({ error: message }, status);
}
