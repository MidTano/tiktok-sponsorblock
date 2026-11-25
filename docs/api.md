# Shared base API

Base URL of the public instance: `https://metra-adskip.falker600.workers.dev`.

Requests that write carry a sync token in `X-SB-Token`: 43 URL-safe characters that the phone creates once
and keeps private. The server stores only a keyed hash of it, so a copy of the database names no
account. Until 23 January 2027 the old `X-TT-UID` header (the TikTok account id) is still accepted and
keyed the same way. Every limit is also counted per network address, kept only as a keyed hash;
an IPv6 client counts as its /64. Errors are JSON: `{"error": "message"}`.

The public GETs (`/v1/db.bin`, `/v1/db/since`, `/v1/stats`) say `Cache-Control: public` and are
answered from Workers Caching until a minute past the next daily run at 01:00 UTC, without running
the Worker. A new deployment starts with an empty cache. Everything else says `no-store`.

## Reading

### `GET /v1/db.bin`

Every visible segment, as a snapshot. It is rebuilt at 01:00 UTC each day and cached until a minute past the next daily run. Until the first build the reply is `503` with `Retry-After: 300`.
`X-Db-Time` is the start of the hour the snapshot is current as of. 60 requests a minute per address.

### `GET /v1/db/since?t=EPOCH`

Every segment changed at or after `t`, hidden ones included with the hidden flag set so phones
drop them. A page holds at most 4 MB of data, about 100 segments at the largest size. `X-Db-Time` is the `t` to ask with next, and `X-Db-More: 1`
says the page was full and the next one should be fetched now. Pass the returned `X-Db-Cursor` UUID as `after` together with `X-Db-Time` as `t`; persist both until the final page. This advances even when many changes share one second. Rows at the page boundary can
arrive twice; apply them by id. A last page answers as of the start of the current hour, so phones
ask with whole hours and most of their requests are answered from the cache; rows changed since
that hour arrive again next time. A continuation conservatively returns its boundary hour on completion; Metra v0.12.2 and later also retain the first partial page's boundary hour until that pagination finishes, to replay concurrent changes behind a UUID cursor.

### `GET /v1/stats`

`{"total", "active", "contributors", "votes_up", "votes_down", "skips", "saved_ms"}` for the
whole base, counted by daily maintenance at 01:00 UTC and cached until the next publication.

### `GET /v1/me` (needs `X-SB-Token`)

`{"segments", "skips", "saved_ms", "votes_up", "votes_down", "base"}`: the caller's visible
segments and how much they saved other viewers, with `base` holding what `/v1/stats` returns, so
one request fills a statistics card. Never cached.

### `GET /v1/health`

`{"ok": true}`.

## Snapshot format

Little-endian. The body of both `db.bin` and `db/since`:

```text
[4] magic 0x4244414D ("MADB")   [4] version = 2   [4] segment count
per segment:
  [16] uuid bytes
  [4]  number, the N in adN, the same on every phone
  [4]  flags, bit 0: hidden by votes
  [4]  frames, the segment's length in 32 ms frames
  [4]  duration ms
  [4]  score (signed), up minus down
  [4]  hash count n
  [4 × n] hashes
  [4 × n] times, frames from the segment's start
```

`Snapshot.read` in the core library parses it.

## Writing

### `POST /v1/segments`

```json
{
  "name": "Brand jingle",
  "duration_ms": 14200,
  "frames": 444,
  "source_aid": "7300000000000000000",
  "hashes_b64": "<n little-endian int32>",
  "times_b64": "<n little-endian int32>"
}
```

| Reply | Meaning |
| --- | --- |
| `201 {"id", "num", "queued": false, "pending"}` | stored; `pending: true` means it is held for a maintainer and reaches phones only once approved |
| `200 {"id", "num", "duplicate": true}` | the same hashes and times were already sent, by anyone |
| `202 {"queued": true}` | over a limit; keep it and send it another day |
| `409` | the same sound was already voted down |
| `400` | fails validation: 1 to 30 s, 40 to 6,000 hashes, times inside the cut, no more frames and hashes than real landmarks of that length could give |
| `403` | banned |
| `413` | body over 256 KB |
| `415` | body not `application/json` |

Limits: 5 a minute per address, 20 a day per account, 60 a day per address, 300 a day across the whole base. An IPv6 client counts as its /64 network. `source_aid` is
the TikTok video id the ad was cut from, used only by moderators to check a report; it is
optional.

### `POST /v1/segments/:id/vote`

`{"vote": 1}` or `{"vote": -1}`, and `{"vote": 0}` takes your vote back. One vote per segment per account, and per network address. A vote on
your own segment is `409`; a segment that is held or removed is `404`. A segment is hidden once its
score, up-votes minus down-votes, reaches -2.
Sending the other value changes it; sending the same one returns `{"changed": false}`. A vote
from another account on the same address is `409`. The reply is the new tally:
`{"score", "votes_up", "votes_down", "confirmed", "hidden"}`. Limits: 30 a minute per address,
300 a day per account, 600 per address.

### `POST /v1/skips`

`{"report_id": "<uuid-v4>", "skips": [{"id": "<uuid>", "n": 3, "ms": 41000}]}`: how many times this phone skipped each
shared segment since its last report and the time that saved. Metra v0.12.2 and later send one a day; the server accepts two per rolling day so older versions keep working. Counts reach the segments at daily maintenance; a report covers at most 200 segments. A stable optional `report_id` is deduplicated per account for 30 days, including retries after the daily quota. Retry the exact payload/id, never reuse an id for different counts. Metra v0.12.2 and later stop retrying an unanswered report after seven days (local lifetime totals remain). Legacy reports without an id cannot be deduplicated. A
viewer's skips of their own segments count only towards `/v1/stats`, not towards `/v1/me`; `n` is capped at 500 and `ms` at `n` times
the segment's length.
