/*
 * Copyright 2026 SponsorBlock for TikTok contributors
 * SPDX-License-Identifier: GPL-3.0-only
 */
package io.github.midtano.tiktoksponsorblock;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Finds marked ads in sound as the player plays it, for a player that hands over audio in small
 * pieces. The last {@link #WINDOW_SECONDS} of sound are matched every {@link #POLL_MS}. An ad is
 * reported when it is first found, and again only when a later find shows it running longer. An
 * ad already under way at the window's edge was reported by the poll that saw its start, so a find
 * that starts exactly at that edge is dropped rather than taken for a new start.
 */
public final class StreamScanner {
    public static final int WINDOW_SECONDS = 12;
    public static final long POLL_MS = 500;
    private static final int WINDOW = WINDOW_SECONDS * Landmarks.SAMPLE_RATE;
    private static final int POLL_SAMPLES = (int) (POLL_MS * Landmarks.SAMPLE_RATE / 1000);
    /** Two finds whose starts lie this close are the same ad. */
    private static final long SAME_START_MS = 1000;

    private final Matcher.Index index;
    private final Matcher.Strictness strictness;
    private final short[] ring = new short[WINDOW];
    private final List<Matcher.Match> reported = new ArrayList<>();
    private long written;
    private long lastPoll;

    public StreamScanner(Matcher.Index index, Matcher.Strictness strictness) {
        this.index = index;
        this.strictness = strictness;
    }

    /** The next samples of the stream: mono 16-bit at {@link Landmarks#SAMPLE_RATE}. */
    public void feed(short[] pcm, int length) {
        for (int i = 0; i < length; i++) {
            ring[(int) (written % WINDOW)] = pcm[i];
            written++;
        }
    }

    /** The ads found since the last poll that are new or longer, with times from the stream's start. */
    public List<Matcher.Match> poll() {
        if (written - lastPoll < POLL_SAMPLES) return Collections.emptyList();
        lastPoll = written;
        int length = (int) Math.min(written, WINDOW);
        long windowStart = written - length;
        short[] window = new short[length];
        for (int i = 0; i < length; i++) window[i] = ring[(int) ((windowStart + i) % WINDOW)];
        long offsetMs = windowStart * 1000L / Landmarks.SAMPLE_RATE;
        List<Matcher.Match> fresh = new ArrayList<>();
        for (Matcher.Match m : Matcher.match(index, Landmarks.compute(window, length), strictness)) {
            if (m.startMs == 0 && windowStart > 0) continue;
            Matcher.Match shifted = new Matcher.Match(m.segment, m.startMs + offsetMs, m.endMs + offsetMs,
                    m.votes, m.partial);
            if (remember(shifted)) fresh.add(shifted);
        }
        return fresh;
    }

    private boolean remember(Matcher.Match found) {
        for (int i = 0; i < reported.size(); i++) {
            Matcher.Match known = reported.get(i);
            if (known.segment != found.segment || Math.abs(known.startMs - found.startMs) > SAME_START_MS) continue;
            if (found.endMs < known.endMs + SAME_START_MS) return false;
            reported.set(i, found);
            return true;
        }
        reported.add(found);
        return true;
    }
}
