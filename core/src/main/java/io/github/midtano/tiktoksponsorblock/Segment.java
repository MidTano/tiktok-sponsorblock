/*
 * Copyright 2026 SponsorBlock for TikTok contributors
 * Built on icysymmetra/tiktok-patches-for-morphe (GPL-3.0).
 * SPDX-License-Identifier: GPL-3.0-only
 */
package io.github.midtano.tiktoksponsorblock;

/**
 * One marked ad: its audio landmarks, with times counted in frames from the ad's own start.
 * The matcher reads only these fields; a mod keeps whatever else it needs beside them.
 */
public final class Segment {
    /** Any stable id: a server uuid, a local number. Only used to tell segments apart. */
    public final String id;
    public final String name;
    public final long durationMs;
    public final int[] hashes;
    public final int[] times;
    /** The ad's length in landmark frames, {@link Landmarks#FRAMES_PER_SECOND} a second. */
    public final int frames;
    public volatile boolean enabled = true;

    public Segment(String id, String name, long durationMs, int[] hashes, int[] times, int frames) {
        if (hashes.length != times.length) throw new IllegalArgumentException("hashes and times differ in length");
        this.id = id;
        this.name = name;
        this.durationMs = durationMs;
        this.hashes = hashes;
        this.times = times;
        this.frames = frames;
    }

    /** The cut of a video's print between two moments, ready to save or send. */
    public static Segment cut(String id, String name, Landmarks.Print video, long startMs, long endMs) {
        Landmarks.Print cut = video.slice(Landmarks.msToFrame(startMs), Landmarks.msToFrame(endMs));
        return new Segment(id, name, endMs - startMs, java.util.Arrays.copyOf(cut.hashes, cut.count),
                java.util.Arrays.copyOf(cut.times, cut.count), cut.frames);
    }
}
