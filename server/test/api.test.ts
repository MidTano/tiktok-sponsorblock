import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM segments'),
    env.DB.prepare('DELETE FROM votes'),
    env.DB.prepare("DELETE FROM meta WHERE key = 'skips_merged'"),
    env.DB.prepare('DELETE FROM skip_reports'),
    env.DB.prepare('DELETE FROM bans'),
    env.DB.prepare("UPDATE meta SET value = '1' WHERE key = 'snapshot_dirty'"),
    env.DB.prepare("DELETE FROM meta WHERE key = 'stats'"),
  ]);
  await env.BUCKET.delete('db.bin');
});

function base64(buffer: ArrayBufferLike): string {
  let text = '';
  for (const byte of new Uint8Array(buffer)) text += String.fromCharCode(byte);
  return btoa(text);
}

function landmarks(seed: number, count = 60) {
  const hashes = new Int32Array(count);
  const times = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const f1 = ((seed * 37 + i * 11) % 400) + 8;
    const f2 = f1 + (i % 21) - 10;
    hashes[i] = (f1 << 15) | (f2 << 6) | ((i % 30) + 1);
    times[i] = i;
  }
  return { hashes_b64: base64(hashes.buffer), times_b64: base64(times.buffer) };
}

function submit(ip: string, uid: string, seed = 1): Promise<Response> {
  return SELF.fetch('https://base.test/v1/segments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-TT-UID': uid, 'CF-Connecting-IP': ip },
    body: JSON.stringify({ name: 'Ad', duration_ms: 2000, frames: 62, ...landmarks(seed) }),
  });
}

function vote(ip: string, uid: string, id: string, value: number): Promise<Response> {
  return SELF.fetch('https://base.test/v1/segments/' + id + '/vote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-TT-UID': uid, 'CF-Connecting-IP': ip },
    body: JSON.stringify({ vote: value }),
  });
}

function skips(ip: string, uid: string, items: unknown[]): Promise<Response> {
  return SELF.fetch('https://base.test/v1/skips', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-TT-UID': uid, 'CF-Connecting-IP': ip },
    body: JSON.stringify({ skips: items }),
  });
}

async function runHourly(scheduledTime = Date.now()): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: '0 * * * *', scheduledTime }) as ScheduledController, env, ctx);
  await waitOnExecutionContext(ctx);
}

/** The run at 01:00 UTC, which also clears old records and rebuilds the snapshot. */
function runDaily(): Promise<void> {
  const at = new Date();
  at.setUTCHours(1, 0, 0, 0);
  return runHourly(at.getTime());
}

describe('request limits', () => {
  it('rejects bursts on all write routes before querying D1', async () => {
    let queries = 0;
    const limited = {
      ...env,
      DB: { prepare() { queries++; throw new Error('D1 must not run'); } } as unknown as D1Database,
      SUBMIT_LIMITER: { limit: async () => ({ success: false }) },
      VOTE_LIMITER: { limit: async () => ({ success: false }) },
      READ_LIMITER: { limit: async () => ({ success: false }) },
    };
    const paths = ['/v1/segments', '/v1/skips', '/v1/segments/12345678-1234-4234-8234-1234567890ab/vote'];
    for (const path of paths) {
      const response = await worker.fetch(new Request('https://base.test' + path, {
        method: 'POST', headers: { 'X-SB-Token': 'A'.repeat(43) },
      }), limited);
      expect(response.status).toBe(path === '/v1/segments' ? 202 : 429);
    }
    expect(queries).toBe(0);
  });

  it('refuses a body over the limit with 413', async () => {
    const res = await SELF.fetch('https://base.test/v1/segments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TT-UID': '1111111111', 'CF-Connecting-IP': '198.51.100.1' },
      body: JSON.stringify({ name: 'x'.repeat(300 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  it('refuses a body that is not JSON with 415', async () => {
    const res = await SELF.fetch('https://base.test/v1/skips', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-TT-UID': '1111111111', 'CF-Connecting-IP': '198.51.100.2' },
      body: '{}',
    });
    expect(res.status).toBe(415);
  });

  it('counts an IPv6 /64 as one network for votes', async () => {
    const created = await submit('2001:db8:1:2:aaaa::1', '2222222222', 2);
    expect(created.status).toBe(201);
    const { id } = await created.json<{ id: string }>();

    expect((await vote('2001:db8:1:2:aaaa::2', '4444444441', id, -1)).status).toBe(200);
    const sameNetwork = await vote('2001:db8:1:2:bbbb::9', '3333333333', id, -1);
    expect(sameNetwork.status).toBe(409);

    const otherNetwork = await vote('2001:db8:1:3::9', '3333333333', id, -1);
    expect(otherNetwork.status).toBe(200);
  });

  it('queues a segment past the daily limit for the whole base', async () => {
    const batch = [];
    for (let i = 0; i < 300; i++) {
      batch.push(env.DB.prepare(
        'INSERT INTO segments (id, num, user_id, name, duration_ms, frames, hash_count, hashes, times, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(crypto.randomUUID(), 1000 + i, 'seed' + i, 'seed', 2000, 62, 0, new ArrayBuffer(0), new ArrayBuffer(0), Math.floor(Date.now() / 1000), 0));
    }
    await env.DB.batch(batch);
    const res = await submit('198.51.100.3', '4444444444', 3);
    expect(res.status).toBe(202);
  });
});

describe('accounts', () => {
  it('refuses a request with neither a token nor a legacy uid', async () => {
    const res = await SELF.fetch('https://base.test/v1/me', { headers: { 'CF-Connecting-IP': '198.51.100.20' } });
    expect(res.status).toBe(401);
  });

  it('refuses a malformed sync token', async () => {
    const res = await SELF.fetch('https://base.test/v1/me', {
      headers: { 'X-SB-Token': 'short', 'CF-Connecting-IP': '198.51.100.21' },
    });
    expect(res.status).toBe(401);
  });

  it('stores a keyed account hash and never the legacy uid', async () => {
    const res = await submit('198.51.100.22', '1212121212', 7);
    const { id } = await res.json<{ id: string }>();
    const row = await env.DB.prepare('SELECT user_id FROM segments WHERE id = ?').bind(id).first<{ user_id: string }>();
    expect(row?.user_id.startsWith('tt:')).toBe(true);
    expect(row?.user_id).not.toContain('1212121212');
  });

  it('answers /v1/me for a sync token', async () => {
    const token = 'A'.repeat(43);
    const created = await SELF.fetch('https://base.test/v1/segments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SB-Token': token, 'CF-Connecting-IP': '198.51.100.23' },
      body: JSON.stringify({ name: 'Token ad', duration_ms: 2000, frames: 62, ...landmarks(8) }),
    });
    expect(created.status).toBe(201);
    const me = await SELF.fetch('https://base.test/v1/me', {
      headers: { 'X-SB-Token': token, 'CF-Connecting-IP': '198.51.100.24' },
    });
    expect(me.status).toBe(200);
    expect(await me.json<{ segments: number }>()).toMatchObject({ segments: 1 });
  });

  it('removes control characters from a name and refuses one left empty', async () => {
    const body = (name: string) => JSON.stringify({ name, duration_ms: 2000, frames: 62, ...landmarks(9) });
    const cleaned = await SELF.fetch('https://base.test/v1/segments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TT-UID': '1313131313', 'CF-Connecting-IP': '198.51.100.25' },
      body: body('A\u0007d\u202E \u200D'),
    });
    const { id } = await cleaned.json<{ id: string }>();
    const row = await env.DB.prepare('SELECT name FROM segments WHERE id = ?').bind(id).first<{ name: string }>();
    expect(row?.name).toBe('Ad \u200D');
    expect(row?.name).not.toMatch(/[\u0007\u202E]/);

    const empty = await SELF.fetch('https://base.test/v1/segments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TT-UID': '1414141414', 'CF-Connecting-IP': '198.51.100.26' },
      body: body('\u0007\u202E'),
    });
    expect(empty.status).toBe(400);
  });

  it('clears source ids and addresses older than 30 days', async () => {
    const old = Math.floor(Date.now() / 1000) - 31 * 86_400;
    await env.DB.prepare(
      "INSERT INTO segments (id, num, user_id, ip_hash, name, duration_ms, source_aid, frames, hash_count, hashes, times, created_at, updated_at) VALUES (?, 5000, 'sb:old', 'oldnet', 'Old', 2000, '7300000000000000001', 62, 0, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), new ArrayBuffer(0), new ArrayBuffer(0), old, old).run();
    await runDaily();
    const row = await env.DB.prepare("SELECT source_aid, ip_hash FROM segments WHERE user_id = 'sb:old'")
      .first<{ source_aid: string | null; ip_hash: string | null }>();
    expect(row).toEqual({ source_aid: null, ip_hash: null });
  });
});

describe('moderation', () => {
  it('refuses a print with a landmark the app cannot make', async () => {
    const hashes = new Int32Array(60).fill((460 << 15) | (460 << 6) | 3);
    const times = new Int32Array(60).map((_, i) => i);
    const res = await SELF.fetch('https://base.test/v1/segments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TT-UID': '1515151515', 'CF-Connecting-IP': '198.51.100.30' },
      body: JSON.stringify({ name: 'Bad', duration_ms: 2000, frames: 62, hashes_b64: base64(hashes.buffer), times_b64: base64(times.buffer) }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts a dense cut that starts in the middle of a block', async () => {
    const count = 2 * 180;
    const hashes = new Int32Array(count);
    const times = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const f1 = 8 + (i % 400);
      hashes[i] = (f1 << 15) | ((f1 + (i % 7)) << 6) | ((i % 60) + 1);
      times[i] = Math.floor((i * 31) / count);
    }
    const res = await SELF.fetch('https://base.test/v1/segments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TT-UID': '1414141414', 'CF-Connecting-IP': '198.51.100.29' },
      body: JSON.stringify({ name: 'Dense', duration_ms: 2000, frames: 62, hashes_b64: base64(hashes.buffer), times_b64: base64(times.buffer) }),
    });
    expect(res.status).toBe(201);
  });

  it('refuses one landmark repeated across the whole cut', async () => {
    const hashes = new Int32Array(60).fill((100 << 15) | (100 << 6) | 3);
    const times = new Int32Array(60).map((_, i) => i);
    const res = await SELF.fetch('https://base.test/v1/segments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TT-UID': '1616161616', 'CF-Connecting-IP': '198.51.100.31' },
      body: JSON.stringify({ name: 'Tone', duration_ms: 2000, frames: 62, hashes_b64: base64(hashes.buffer), times_b64: base64(times.buffer) }),
    });
    expect(res.status).toBe(400);
  });

  it('takes a vote back with 0', async () => {
    const { id } = await (await submit('198.51.100.34', '1818181818', 11)).json<{ id: string }>();
    expect(await (await vote('198.51.100.35', '1919191919', id, -1)).json()).toMatchObject({ votes_down: 1 });
    expect(await (await vote('198.51.100.35', '1919191919', id, 0)).json()).toMatchObject({ votes_up: 0, votes_down: 0 });
    expect(await (await vote('198.51.100.35', '1919191919', id, 0)).json()).toMatchObject({ changed: false });
  });

  it('refuses a vote on your own segment', async () => {
    const { id } = await (await submit('198.51.100.32', '1717171717', 10)).json<{ id: string }>();
    expect((await vote('198.51.100.33', '1717171717', id, 1)).status).toBe(409);
  });

  it('hides a young segment on two down-votes that outnumber up-votes', async () => {
    const { id } = await (await submit('198.51.100.34', '1818181818', 11)).json<{ id: string }>();
    await vote('198.51.100.35', '1919191919', id, -1);
    const second = await vote('198.51.100.36', '2020202020', id, -1);
    expect(await second.json<{ hidden: number }>()).toMatchObject({ hidden: 1 });
  });

  it('holds a new segment for review once the account has two hidden ones', async () => {
    const first = await (await submit('198.51.100.37', '2121212121', 12)).json<{ id: string }>();
    const second = await (await submit('198.51.100.38', '2121212121', 13)).json<{ id: string }>();
    await env.DB.prepare('UPDATE segments SET hidden = 1 WHERE id IN (?, ?)').bind(first.id, second.id).run();
    const held = await submit('198.51.100.39', '2121212121', 14);
    expect(await held.json<{ pending: boolean }>()).toMatchObject({ pending: true });
  });

  it('refuses votes on a segment the maintainer removed', async () => {
    const { id } = await (await submit('198.51.100.41', '2222222222', 16)).json<{ id: string }>();
    await env.DB.prepare("UPDATE segments SET status = 'removed', hidden = 1 WHERE id = ?").bind(id).run();
    expect((await vote('198.51.100.42', '2323232323', id, -1)).status).toBe(404);
  });
});

describe('skip reports', () => {
  it('rejects a report over 200 segments', async () => {
    const items = Array.from({ length: 201 }, () => ({ id: crypto.randomUUID(), n: 1, ms: 1000 }));
    const res = await skips('198.51.100.4', '5555555555', items);
    expect(res.status).toBe(400);
  });

  it('merges a report into its segment at the hourly run', async () => {
    const created = await submit('198.51.100.5', '6666666666', 4);
    const { id } = await created.json<{ id: string }>();
    const res = await skips('198.51.100.6', '7777777777', [{ id, n: 3, ms: 4000 }]);
    expect(res.status).toBe(200);

    const before = await env.DB.prepare('SELECT skips FROM segments WHERE id = ?').bind(id).first<{ skips: number }>();
    expect(before?.skips).toBe(0);

    await runHourly();
    const after = await env.DB.prepare('SELECT skips, saved_ms FROM segments WHERE id = ?')
      .bind(id).first<{ skips: number; saved_ms: number }>();
    expect(after).toEqual({ skips: 3, saved_ms: 4000 });
  });

  it('does not count a reader skipping their own segment', async () => {
    const created = await submit('198.51.100.7', '8888888888', 5);
    const { id } = await created.json<{ id: string }>();
    await skips('198.51.100.8', '8888888888', [{ id, n: 5, ms: 9000 }]);
    await runHourly();
    const row = await env.DB.prepare('SELECT skips FROM segments WHERE id = ?').bind(id).first<{ skips: number }>();
    expect(row?.skips).toBe(0);
  });

  it('keeps a report as one row however many ads it covers', async () => {
    const ids: string[] = [];
    for (const seed of [21, 22, 23]) ids.push((await (await submit('198.51.100.45', '2323232323', seed)).json<{ id: string }>()).id);
    await skips('198.51.100.46', '2424242424', ids.map((id) => ({ id, n: 1, ms: 1000 })));
    const reports = await env.DB.prepare('SELECT COUNT(*) AS n FROM skip_reports').first<{ n: number }>();
    expect(reports?.n).toBe(1);
    await runHourly();
    const merged = await env.DB.prepare('SELECT SUM(skips) AS n FROM segments WHERE user_id = (SELECT user_id FROM segments WHERE id = ?)')
      .bind(ids[0]).first<{ n: number }>();
    expect(merged?.n).toBe(3);
  });

  it('deletes even the newest expired receipt and keeps sequence after a quiet spell', async () => {
    const old = Math.floor(Date.now() / 1000) - 31 * 86_400;
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare("INSERT INTO skip_reports (user_id, ip_hash, created_at, items) VALUES ('sb:x', 'net', ?, '[]')").bind(old).run();
    }
    await runDaily();
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM skip_reports').first<{ n: number }>();
    expect(left?.n).toBe(0);
    await env.DB.prepare("INSERT INTO skip_reports (user_id, ip_hash, created_at, items) VALUES ('sb:y', 'net', ?, '[]')")
      .bind(Math.floor(Date.now() / 1000)).run();
    const next = await env.DB.prepare('SELECT rowid AS n FROM skip_reports').first<{ n: number }>();
    const merged = await env.DB.prepare("SELECT value FROM meta WHERE key = 'skips_merged'").first<{ value: string }>();
    expect(next!.n).toBeGreaterThan(Number(merged!.value));
  });

  it("counts an author's own skips in the base's totals but not in what they saved others", async () => {
    const { id } = await (await submit('198.51.100.40', '2020202020', 12)).json<{ id: string }>();
    await skips('198.51.100.41', '2020202020', [{ id, n: 2, ms: 1500 }]);
    await skips('198.51.100.42', '2121212121', [{ id, n: 1, ms: 1000 }]);
    await runHourly();
    const stats = await (await SELF.fetch('https://base.test/v1/stats', { headers: { 'CF-Connecting-IP': '198.51.100.43' } }))
      .json<{ skips: number; saved_ms: number }>();
    expect(stats).toMatchObject({ skips: 3, saved_ms: 2500 });
    const me = await (await SELF.fetch('https://base.test/v1/me', {
      headers: { 'X-TT-UID': '2020202020', 'CF-Connecting-IP': '198.51.100.44' },
    })).json<{ skips: number; saved_ms: number }>();
    expect(me).toMatchObject({ skips: 1, saved_ms: 1000 });
  });
});

describe('caching', () => {
  it('does not cache an overdue generation for another day during publication', async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('stats', '{}'), ('stats_at', ?)")
      .bind(String(Math.floor(Date.now() / 1000) - 2 * 86400)).run();
    const res = await SELF.fetch('https://base.test/v1/stats', { headers: { 'CF-Connecting-IP': '198.51.100.54' } });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
  });

  it('keeps public responses until the next daily publication, not merely the next hour', async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await SELF.fetch('https://base.test/v1/stats', { headers: { 'CF-Connecting-IP': '198.51.100.53' } });
    const after = Math.floor(Date.now() / 1000);
    const ttl = Number(res.headers.get('Cache-Control')?.split('=')[1]);
    const nextRun = (t: number) => t + 86400 - (((t - 3600) % 86400 + 86400) % 86400) + 60;
    expect(ttl).toBeGreaterThanOrEqual(60);
    expect(ttl).toBeLessThanOrEqual(86460);
    expect(before + ttl).toBeLessThanOrEqual(nextRun(after));
    expect(after + ttl).toBeGreaterThanOrEqual(nextRun(before));
  });

  it("lets Workers Caching keep the stats but never a reader's own numbers", async () => {
    const stats = await SELF.fetch('https://base.test/v1/stats', { headers: { 'CF-Connecting-IP': '198.51.100.50' } });
    expect(stats.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+$/);
    const me = await SELF.fetch('https://base.test/v1/me', {
      headers: { 'X-TT-UID': '2222222222', 'CF-Connecting-IP': '198.51.100.51' },
    });
    expect(me.headers.get('Cache-Control')).toBe('no-store');
    expect(await me.json()).toHaveProperty('base.active');
  });

  it('answers a delta as of the start of the hour, so phones share cached answers', async () => {
    const res = await SELF.fetch('https://base.test/v1/db/since?t=0', { headers: { 'CF-Connecting-IP': '198.51.100.52' } });
    expect(Number(res.headers.get('X-Db-Time')) % 3600).toBe(0);
    expect(res.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+$/);
  });
});

describe('report receipts', () => {
  it('deduplicates retries including retries after daily quota', async () => {
    const { id } = await (await submit('198.51.100.80', '8181818181', 30)).json<{ id: string }>();
    const report = (reportId: string) => SELF.fetch('https://base.test/v1/skips', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TT-UID': '8282828282', 'CF-Connecting-IP': '198.51.100.81' },
      body: JSON.stringify({ report_id: reportId, skips: [{ id, n: 2, ms: 2000 }] }),
    });
    const first = crypto.randomUUID();
    expect((await report(first)).status).toBe(200);
    expect((await report(crypto.randomUUID())).status).toBe(200);
    expect((await report(first)).status).toBe(200);
    await runDaily();
    await runDaily();
    const row = await env.DB.prepare('SELECT skips FROM segments WHERE id = ?').bind(id).first<{ skips: number }>();
    expect(row?.skips).toBe(4);
  });

  it('clears old payloads while retaining a deduplication receipt', async () => {
    await env.DB.prepare("INSERT INTO skip_reports(user_id, ip_hash, created_at, items, report_id) VALUES ('x', 'net', ?, '[]', ?)")
      .bind(Math.floor(Date.now() / 1000) - 4 * 86400, crypto.randomUUID()).run();
    await runDaily();
    const row = await env.DB.prepare('SELECT items, report_id FROM skip_reports').first<{ items: string | null; report_id: string }>();
    expect(row?.items).toBeNull();
    expect(row?.report_id).toBeTruthy();
  });
});

describe('snapshot', () => {
  it('answers 503 until the first build', async () => {
    const res = await SELF.fetch('https://base.test/v1/db.bin', { headers: { 'CF-Connecting-IP': '198.51.100.9' } });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('300');
  });

  it('publishes equal-sized multipart chunks and an exact count for a large base', async () => {
    for (let start = 0; start < 450; start += 50) {
      await env.DB.batch(Array.from({ length: 50 }, (_, i) => env.DB.prepare(
        "INSERT INTO segments(id, num, user_id, name, duration_ms, frames, hash_count, hashes, times, created_at, updated_at) VALUES (?, ?, 'large', 'large', 2000, 62, ?, ?, ?, 1000, 1000)")
        .bind(crypto.randomUUID(), start + i + 1, 4000 + i * 20,
          new ArrayBuffer((4000 + i * 20) * 4), new ArrayBuffer((4000 + i * 20) * 4))));
    }
    const sizes: number[] = [];
    let headerCount = 0;
    const bucket = {
      async createMultipartUpload() {
        return {
          async uploadPart(partNumber: number, bytes: Uint8Array) {
            sizes[partNumber - 1] = bytes.byteLength;
            if (partNumber === 1) headerCount = new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
            return { partNumber, etag: String(partNumber) };
          },
          async complete(parts: R2UploadedPart[]) {
            expect(parts.map(p => p.partNumber)).toEqual(sizes.map((_, i) => i + 1));
          },
          async abort() { throw new Error('Unexpected abort'); },
        };
      },
    } as unknown as R2Bucket;
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now() }) as ScheduledController, { ...env, BUCKET: bucket }, ctx);
    await waitOnExecutionContext(ctx);
    expect(headerCount).toBe(450);
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    expect(sizes.slice(0, -1).every(size => size === 5 * 1024 * 1024)).toBe(true);
    expect(sizes.at(-1)).toBeLessThanOrEqual(5 * 1024 * 1024);
  });

  it('serves the built snapshot with its segments', async () => {
    await submit('198.51.100.10', '9999999999', 6);
    await runHourly();
    const res = await SELF.fetch('https://base.test/v1/db.bin', { headers: { 'CF-Connecting-IP': '198.51.100.11' } });
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new DataView(bytes.buffer).getUint32(8, true)).toBe(1);
    expect(bytes.byteLength).toBe(12 + 40 + 60 * 8);
  });

  it('advances across a full page of changes with identical timestamps', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => env.DB.prepare(
      "INSERT INTO segments(id, num, user_id, name, duration_ms, frames, hash_count, hashes, times, created_at, updated_at) VALUES (?, ?, 'bulk', 'bulk', 2000, 62, 5000, ?, ?, 1000, 1000)")
      .bind(crypto.randomUUID(), i + 1, new ArrayBuffer(20000), new ArrayBuffer(20000)));
    await env.DB.batch(rows);
    const first = await SELF.fetch('https://base.test/v1/db/since?t=1000');
    expect(first.headers.get('X-Db-More')).toBe('1');
    expect(first.headers.get('X-Db-Time')).toBe('1000');
    const count1 = new DataView(await first.arrayBuffer()).getUint32(8, true);
    const second = await SELF.fetch('https://base.test/v1/db/since?t=1000&after=' + first.headers.get('X-Db-Cursor'));
    expect(second.headers.get('X-Db-More')).toBe('0');
    // Replay the boundary hour instead of advancing past a concurrent same-second change.
    expect(second.headers.get('X-Db-Time')).toBe('0');
    expect(count1 + new DataView(await second.arrayBuffer()).getUint32(8, true)).toBe(150);
  });

  it('pages a delta by bytes, not by rows', async () => {
    const batch = [];
    for (let i = 0; i < 150; i++) {
      batch.push(env.DB.prepare(
        'INSERT INTO segments (id, num, user_id, name, duration_ms, frames, hash_count, hashes, times, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(crypto.randomUUID(), 2000 + i, 'bulk', 'bulk', 2000, 62, 5000, new ArrayBuffer(20000), new ArrayBuffer(20000), 1000 + i, 1000 + i));
    }
    await env.DB.batch(batch);
    const res = await SELF.fetch('https://base.test/v1/db/since?t=0', { headers: { 'CF-Connecting-IP': '198.51.100.12' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Db-More')).toBe('1');
    expect((await res.arrayBuffer()).byteLength).toBeLessThanOrEqual(4 * 1024 * 1024 + 12);
  });
});
