/*
 * Copyright 2026 SponsorBlock for TikTok contributors
 * Built on icysymmetra/tiktok-patches-for-morphe (GPL-3.0).
 */
package io.github.midtano.tiktoksponsorblock;

import java.util.ArrayList;
import java.util.List;

/**
 * Finds every marked ad in one video's sound. A plain pass first; when it finds nothing, the
 * sound is retimed by a few percent each way and searched again, which catches copies that were
 * sped up or slowed down, and the times found are mapped back to the original video.
 */
public final class Scanner {
    /** The rates tried when the plain pass finds nothing. */
    private static final float[] RATES = {1.05f, 0.95f, 1.10f, 0.90f};

    private Scanner() {}

    /**
     * @param pcm     mono 16-bit samples at {@link Landmarks#SAMPLE_RATE}
     * @param retimed whether to try sped up and slowed down copies when the plain pass is empty
     */
    public static List<Matcher.Match> scan(Matcher.Index index, short[] pcm, int length,
            Matcher.Strictness strictness, boolean retimed) {
        List<Matcher.Match> found = Matcher.match(index, Landmarks.compute(pcm, length), strictness);
        if (!found.isEmpty() || !retimed) return found;
        for (float rate : RATES) {
            short[] stretched = stretch(pcm, length, rate);
            List<Matcher.Match> matches = Matcher.match(index, Landmarks.compute(stretched, stretched.length), strictness);
            if (matches.isEmpty()) continue;
            List<Matcher.Match> mapped = new ArrayList<>();
            for (Matcher.Match m : matches) {
                mapped.add(new Matcher.Match(m.segment, Math.round(m.startMs / rate), Math.round(m.endMs / rate),
                        m.votes, m.partial));
            }
            return mapped;
        }
        return found;
    }

    /**
     * The sound made {@code rate} times as long, pitch with it, which undoes a copy that was sped
     * up or slowed down by that much: its landmarks line up with the ad's again.
     */
    public static short[] stretch(short[] pcm, int length, float rate) {
        short[] out = new short[Math.max(0, (int) (length * (double) rate))];
        for (int i = 0; i < out.length; i++) {
            double at = i / (double) rate;
            int a = (int) at;
            if (a + 1 >= length) {
                out[i] = pcm[Math.max(0, Math.min(length - 1, a))];
                continue;
            }
            double t = at - a;
            out[i] = (short) Math.round(pcm[a] * (1 - t) + pcm[a + 1] * t);
        }
        return out;
    }
}
