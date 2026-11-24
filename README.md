# SponsorBlock for TikTok

Skip ads inside TikTok videos by their sound. Someone marks an ad once, and every phone with a
supporting mod skips it in every video where the same sound plays again, even under a voice-over,
re-encoded, or sped up a little.

This repository holds the parts any TikTok mod can reuse:

- **[`core/`](core)**: a dependency-free Java 11 library that fingerprints audio, cuts a marked
  ad out of a video's fingerprint and finds marked ads in new videos.
- **[`server/`](server)**: the shared ad base, a Cloudflare Worker with D1 and R2 that stores
  marked ads, takes votes and serves the whole base to phones once a day.
- **[`docs/`](docs)**: how the matching works, the HTTP API and the snapshot format, what a mod
  has to hook to support it, and what data leaves the phone.

> Unofficial. Not affiliated with [SponsorBlock](https://sponsor.ajay.app) or TikTok. The name
> only says what it does: SponsorBlock-style skipping, for TikTok.

## How it works, in short

1. A viewer sees an ad inside a video and opens **Mark ad** from the share sheet.
2. The mod decodes the video's sound, the viewer drags the start and end over it, and the core
   library turns that stretch into audio landmarks: pairs of spectrogram peaks packed into
   32-bit hashes, the way Shazam identifies songs.
3. The ad's landmarks go to the shared base. No audio is uploaded, and the hashes cannot be
   turned back into sound.
4. Every phone downloads the base once a day. When a video starts, the mod fingerprints its
   sound and the matcher looks for any marked ad in it. A match is skipped when playback
   reaches it.
5. Viewers vote on what was skipped. A segment with too many down-votes is hidden from every
   phone at their next sync.

The details are in [docs/how-it-works.md](docs/how-it-works.md).

## For users

You need a TikTok mod that supports it. The first is the **Skip ads by sound** feature in a
build of [Metra](https://github.com/icysymmetra/tiktok-patches-for-morphe), TikTok patches for
[Morphe](https://github.com/MorpheApp). Other mods are welcome to add it; see below.

What the feature shows you: marks on the seek bar where an ad sits, a short notice when one is
skipped with buttons to undo or vote, a list of the ads you marked, and statistics on how many
ads were skipped and how much time that saved you and others.

What it sends is listed in [docs/privacy.md](docs/privacy.md).

## For mod developers

Adding sound-based ad skipping to your mod takes four hooks: the video's playback position,
a way to seek, the decoded audio of the current video, and an entry point for marking. The core
library does the rest. Start with [docs/integrating.md](docs/integrating.md).

You can use the public base at `https://metra-adskip.falker600.workers.dev` or run your own; the
API is in [docs/api.md](docs/api.md) and the deployment steps in
[server/README.md](server/README.md). A shared base works better the more mods feed it, so
using the public one is encouraged.

## Building

```sh
./gradlew :core:build          # library and its tests (JDK 21 toolchain, Java 11 bytecode)
cd server && npm install && npm run typecheck
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Security problems go through
[SECURITY.md](SECURITY.md), not public issues. Bad segments in the public base can be reported
with the **Bad segment** issue form.

## License

GPL-3.0, see [LICENSE](LICENSE). Built on
[icysymmetra/tiktok-patches-for-morphe](https://github.com/icysymmetra/tiktok-patches-for-morphe),
see [NOTICE.md](NOTICE.md).
