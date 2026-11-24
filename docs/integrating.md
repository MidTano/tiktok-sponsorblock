# Adding it to a mod

The core library knows nothing about TikTok or Android. A mod supplies four things and calls
three methods.

## What the mod has to hook

1. **Playback position and seeking.** The player's current position in milliseconds, called
   often enough to notice an ad starting (TikTok's progress callback fires a few times a
   second), and a seek to jump past it. Seek only once per match, and not while the viewer is
   dragging the seek bar.
2. **The current video's sound.** Its audio URL or file, decoded off the main thread to mono
   16-bit PCM at 8 kHz. Videos are short, so decoding the whole track once per video is fine;
   cache the result by video id.
3. **A way in to mark an ad.** Metra adds an item to the share sheet that opens an editor with
   the decoded sound, the video's thumbnails and two handles for the start and end.
4. **The signed-in account id**, only if the mod writes to the shared base. Reading needs none.

## The calls

```java
// Once, after loading the base (and after every sync):
List<Segment> segments = new ArrayList<>();
for (Snapshot.Entry entry : Snapshot.read(snapshotBytes)) {
    if (!entry.hidden) segments.add(entry.segment);
}
Matcher.Index index = Matcher.Index.build(segments);

// For every video, on a background thread:
List<Matcher.Match> ads = Scanner.scan(index, pcm, pcm.length, Matcher.Strictness.NORMAL, true);
// Each match has startMs and endMs in the video's own time. Skip when playback enters one.

// When the viewer marks an ad:
Landmarks.Print print = Landmarks.compute(pcm, pcm.length);
Segment ad = Segment.cut(localId, name, print, startMs, endMs);
// Send ad.hashes, ad.times, ad.frames and ad.durationMs to POST /v1/segments.
```

## Behaviour that keeps it trustworthy

- Show the viewer what was skipped and let them undo it with one tap.
- Offer votes on that notice, and remember the viewer's vote so they see it next time.
- Never skip into the next video: clamp the seek to the video's length.
- Let the viewer turn off the shared base and keep only their own marks.
- Sync at most once a day, and send skip counts in the same request window.
- Tell the viewer what leaves the phone; [privacy.md](privacy.md) is the list a mod can link.

## Using the library

Until it is published to a package registry, copy `core/src/main/java` into the mod, or build
the jar with `./gradlew :core:jar` and add it as a file dependency. The package is
`io.github.midtano.tiktoksponsorblock`; keep the license notice at the top of each file.
