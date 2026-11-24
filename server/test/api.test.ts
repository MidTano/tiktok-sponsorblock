import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM segments'),
    env.DB.prepare('DELETE FROM votes'),
    env.DB.prepare('DELETE FROM skip_inbox'),
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
    hashes[i] = (seed * 7919 + i * 104729) | 0;
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

async function runHourly(): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: '0 * * * *' }) as ScheduledController, env, ctx);
  await waitOnExecutionContext(ctx);
}

describe('request limits', () => {
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
        'INSERT INTO segments (id, num, tt_uid, name, duration_ms, frames, hash_count, hashes, times, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(crypto.randomUUID(), 1000 + i, 'seed' + i, 'seed', 2000, 62, 0, new ArrayBuffer(0), new ArrayBuffer(0), Math.floor(Date.now() / 1000), 0));
    }
    await env.DB.batch(batch);
    const res = await submit('198.51.100.3', '4444444444', 3);
    expect(res.status).toBe(202);
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
});

describe('snapshot', () => {
  it('answers 503 until the first build', async () => {
    const res = await SELF.fetch('https://base.test/v1/db.bin', { headers: { 'CF-Connecting-IP': '198.51.100.9' } });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('300');
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

  it('pages a delta by bytes, not by rows', async () => {
    const batch = [];
    for (let i = 0; i < 150; i++) {
      batch.push(env.DB.prepare(
        'INSERT INTO segments (id, num, tt_uid, name, duration_ms, frames, hash_count, hashes, times, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(crypto.randomUUID(), 2000 + i, 'bulk', 'bulk', 2000, 62, 5000, new ArrayBuffer(20000), new ArrayBuffer(20000), 1000 + i, 1000 + i));
    }
    await env.DB.batch(batch);
    const res = await SELF.fetch('https://base.test/v1/db/since?t=0', { headers: { 'CF-Connecting-IP': '198.51.100.12' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Db-More')).toBe('1');
    expect((await res.arrayBuffer()).byteLength).toBeLessThanOrEqual(4 * 1024 * 1024 + 12);
  });
});
