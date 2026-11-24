# Shared base API

Base URL of the public instance: `https://metra-adskip.falker600.workers.dev`.

Requests that write carry the TikTok account id of the signed-in viewer in `X-TT-UID` (5 to 30
digits). It is a claim, not a proof, so every limit is also counted per network address, kept
only as a salted hash. Errors are JSON: `{"error": "message"}`.

## Reading

### `GET /v1/db.bin`

Every visible segment, as a snapshot rebuilt daily at 01:00 UTC and cached for an hour.
`X-Db-Time` is the Unix time the snapshot is current as of. 60 requests a minute per address.

### `GET /v1/db/since?t=EPOCH`

Every segment changed at or after `t`, hidden ones included with the hidden flag set so phones
drop them. At most 2,000 rows a page. `X-Db-Time` is the `t` to ask with next, and `X-Db-More: 1`
says the page was full and the next one should be fetched now. Rows at the page boundary can
arrive twice; apply them by id.

### `GET /v1/stats`

`{"total", "active", "contributors", "votes_up", "votes_down", "skips", "saved_ms"}` for the
whole base.

### `GET /v1/me` (needs `X-TT-UID`)

`{"segments", "skips", "saved_ms", "votes_up", "votes_down"}`: the caller's visible segments and
how much they saved other viewers.

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
| `201 {"id", "num", "queued": false}` | stored |
| `200 {"id", "num", "duplicate": true}` | the same hashes and times were already sent, by anyone |
| `202 {"queued": true}` | over a limit; keep it and send it another day |
| `409` | the same sound was already voted down |
| `400` | fails validation: 1 to 30 s, 40 to 60,000 hashes, times inside the cut, no more frames and hashes than real landmarks of that length could give |
| `403` | banned |

Limits: 5 a minute per address, 20 a day per account, 60 a day per address. `source_aid` is
the TikTok video id the ad was cut from, used only by moderators to check a report; it is
optional.

### `POST /v1/segments/:id/vote`

`{"vote": 1}` or `{"vote": -1}`. One vote per segment per account, and per network address.
Sending the other value changes it; sending the same one returns `{"changed": false}`. A vote
from another account on the same address is `409`. The reply is the new tally:
`{"score", "votes_up", "votes_down", "confirmed", "hidden"}`. Limits: 30 a minute per address,
300 a day per account, 600 per address.

### `POST /v1/skips`

`{"skips": [{"id": "<uuid>", "n": 3, "ms": 41000}]}`: how many times this phone skipped each
shared segment since its last report and the time that saved. Twice a day per account. A
viewer's skips of their own segments are not counted; `n` is capped at 500 and `ms` at `n` times
the segment's length.
