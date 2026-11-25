# What leaves the phone

Nothing is sent while the shared base is off. With it on:

| When | What is sent | Why |
| --- | --- | --- |
| Once a day | a download request, with the time of the last sync | to get new and hidden segments |
| When you mark an ad | its audio landmarks (32-bit hashes and their times), its length, the name you gave it, the TikTok video id it was cut from, your sync token | so other phones can skip it; the video id lets moderators check a report |
| When you vote | the segment id, up or down, your sync token | one vote per account |
| Twice a day | for each shared ad skipped on this phone: its id, how many times, how much time it saved | the statistics card |
| On the statistics card | your sync token | your own totals |

Not sent: audio, video, where you are, anything about videos with no ad.

Landmarks are a few thousand numbers describing where the loudest points of a sound sit. They
cannot be turned back into audio.

The server sees your network address on every request, like any website. It stores the
address only as a keyed hash (HMAC-SHA-256), used to count daily limits and to stop one network from
voting many times under different account ids. The salt is a server secret, not in this
repository.

The sync token is never stored. The server keeps a keyed hash of it, and of the TikTok account id from
clients that still send the old header, which stops being accepted on 23 January 2027. The hash lets
the maintainer remove everything from one account that floods the base.

The video id of an ad you mark is kept for 30 days, then cleared. Addresses are cleared after 30 days,
and skip reports are kept for 3 days.

The public instance runs on Cloudflare Workers, D1 and R2; Cloudflare's own logging applies.
To have your segments and votes deleted, open an issue or follow [SECURITY.md](../SECURITY.md)
for a private request, with your sync token.
