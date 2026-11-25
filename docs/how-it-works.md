# How it works

Everything here is implemented in [`core/`](../core/src/main/java/io/github/midtano/tiktoksponsorblock).
The numbers are part of the shared base's format: a mod that fingerprints with other values
produces hashes no other phone can match, so change them only together with a new snapshot
version.

## Audio in

Mono, 16-bit PCM at **8,000 Hz**. A mod decodes the video's audio track (on Android,
`MediaExtractor` + `MediaCodec`), mixes it to mono and resamples it. 8 kHz keeps everything
up to 4 kHz, which is where speech and most jingles carry their energy, and makes a minute of
sound cheap to analyse on a phone.

## Landmarks ([`Landmarks.java`](../core/src/main/java/io/github/midtano/tiktoksponsorblock/Landmarks.java))

| Step | Value |
| --- | --- |
| FFT window | 1,024 samples, Hann |
| Hop | 256 samples, so one frame is **32 ms** and a second has 31.25 frames |
| Frequency band | bins 8 to 448, about 62 Hz to 3.5 kHz |
| Peak | louder than every cell within ±6 frames and ±9 bins, at least 6 dB above the frame mean and above a -12 dB floor |
| Density | at most 30 peaks a second, the loudest kept |
| Pairs | each peak with up to 6 peaks that follow it within 63 frames (about 2 s) and 120 bins |
| Hash | `(f1 << 15) \| (f2 << 6) \| dt`, one `int` |

A hash holds two frequencies and the time between them, never an absolute time, so it means
the same thing wherever the sound turns up. Each hash is stored with the frame of its first
peak.

A peak is the loudest cell in its block, so it survives noise, a change of volume, a new
encode and a phone microphone. Noise fills the quiet cells but rarely beats the loudest one.

## A marked ad ([`Segment.java`](../core/src/main/java/io/github/midtano/tiktoksponsorblock/Segment.java))

`Segment.cut` takes the video's landmarks between the chosen start and end and shifts their
times so the ad starts at frame 0. A segment is 1 to 30 seconds long; the server refuses
anything else, and anything with fewer than 40 hashes.

## Matching ([`Matcher.java`](../core/src/main/java/io/github/midtano/tiktoksponsorblock/Matcher.java))

All segments go into one index sorted by hash. For every hash of a new video, each segment
entry with the same hash votes for an offset: video time minus segment time. When the ad is
in the video, one offset collects far more votes than chance gives any other.

Chance is small. A one-minute video carries about 10,000 hashes and a 15 second ad about
2,500, out of millions of possible values, so a random offset collects well under one vote. A
real ad, even under a voice-over, collects dozens to hundreds.

A segment matches when its best offset (smoothed over ±1 frame) collects at least
`max(minVotes, min(maxVotes, ratio × segment hashes))` votes:

| Strictness | minVotes | ratio | maxVotes |
| --- | --- | --- | --- |
| Loose | 8 | 0.6 % | 25 |
| Normal | 12 | 1.5 % | 40 |
| Strict | 20 | 4 % | 80 |

The matched hashes also say which part of the ad is present. A video that keeps only the
ad's first half is skipped to the end of that half, not into whatever follows it. One ad can
match up to four times in one video. Overlapping matches from two marked copies of the same
ad merge into one span named after the longer copy.

## Speed changes ([`Scanner.java`](../core/src/main/java/io/github/midtano/tiktoksponsorblock/Scanner.java))

When the plain pass finds nothing, the sound is resampled to 1.05, 0.95, 1.10 and 0.90 of its
length and searched again, which catches copies sped up or slowed down by up to 10 %. Found
times are mapped back to the original video.

## Shared base

The server keeps every segment's hashes and times as they were cut. Phones download a binary
snapshot once a day and then only what changed since; the format is in [api.md](api.md).
Votes decide what stays: as in SponsorBlock, a segment is hidden once its score, up-votes minus
down-votes, reaches -2. Identical submissions, byte for byte, are one segment.
