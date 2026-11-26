/*
 * Copyright 2026 SponsorBlock for TikTok contributors
 * SPDX-License-Identifier: GPL-3.0-only
 */
package io.github.midtano.tiktoksponsorblock;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * The shared base's binary format, the body of the CDN's {@code db.bin} and
 * {@code GET /v1/db/since}. Little-endian:
 * <pre>
 *   [4] magic "MADB" (0x4244414D)   [4] version 2   [4] segment count
 *   per segment:
 *     [16] uuid   [4] number (the N of adN)   [4] flags, bit 0 hidden by votes   [4] frames
 *     [4] duration ms   [4] score   [4] hash count
 *     [4 x count] hashes   [4 x count] times
 * </pre>
 * Version 1 files, without number, flags and frames, are still read.
 */
public final class Snapshot {
    public static final int MAGIC = 0x4244414D;
    public static final int VERSION = 2;

    /** Limits on what a snapshot may hold; anything past them is refused, not parsed. */
    static final int MAX_SEGMENTS = 50_000;
    static final int MAX_HASHES = 6_000;
    static final int MAX_TOTAL_HASHES = 3_000_000;
    static final int MIN_DURATION_MS = 1_000;
    static final int MAX_DURATION_MS = 30_000;
    /** The app cuts at most 30 s, and a landmark may sit this many frames past the cut's end. */
    static final int TIME_SLACK = 70;
    static final int MAX_FRAMES = 30 * Landmarks.FRAMES_PER_SECOND + TIME_SLACK;

    /** One segment as the base sends it. */
    public static final class Entry {
        /** The uuid, lower case with hyphens. */
        public final String id;
        public final int number;
        public final boolean hidden;
        public final int score;
        public final Segment segment;

        public Entry(String id, int number, boolean hidden, int score, Segment segment) {
            this.id = id;
            this.number = number;
            this.hidden = hidden;
            this.score = score;
            this.segment = segment;
        }
    }

    private Snapshot() {}

    /**
     * Every complete, valid entry in the data. A truncated tail stops the reading; a record that
     * breaks the limits is skipped and the rest still read.
     */
    public static List<Entry> read(byte[] data) {
        List<Entry> entries = new ArrayList<>();
        if (data.length < 12) return entries;
        ByteBuffer buf = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN);
        if (buf.getInt() != MAGIC) throw new IllegalArgumentException("Not a snapshot");
        int version = buf.getInt();
        if (version != 1 && version != 2) throw new IllegalArgumentException("Snapshot version " + version);
        int count = buf.getInt();
        long totalHashes = 0;
        for (int i = 0; i < count && entries.size() < MAX_SEGMENTS; i++) {
            if (buf.remaining() < (version == 2 ? 40 : 28)) break;
            byte[] uuid = new byte[16];
            buf.get(uuid);
            int number = version == 2 ? buf.getInt() : 0;
            int flags = version == 2 ? buf.getInt() : 0;
            int frames = version == 2 ? buf.getInt() : 0;
            int durationMs = buf.getInt();
            int score = buf.getInt();
            int n = buf.getInt();
            if (n < 0 || buf.remaining() < n * 8L) break;
            totalHashes += n;
            if (totalHashes > MAX_TOTAL_HASHES) break;
            if (n > MAX_HASHES) {
                buf.position(buf.position() + n * 8);
                continue;
            }
            int[] hashes = new int[n];
            int[] times = new int[n];
            for (int k = 0; k < n; k++) hashes[k] = buf.getInt();
            for (int k = 0; k < n; k++) times[k] = buf.getInt();
            if (frames <= 0) frames = Landmarks.msToFrame(durationMs);
            if (!isValid(number, durationMs, frames, hashes, times)) continue;
            String id = uuid(uuid);
            entries.add(new Entry(id, number, (flags & 1) != 0, score,
                    new Segment(id, number > 0 ? "ad" + number : "ad", durationMs, hashes, times, frames)));
        }
        return entries;
    }

    private static boolean isValid(int number, int durationMs, int frames, int[] hashes, int[] times) {
        if (number < 0 || durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) return false;
        if (frames < 1 || frames > MAX_FRAMES) return false;
        for (int k = 0; k < hashes.length; k++) {
            if (!isHash(hashes[k]) || times[k] < 0 || times[k] > frames + TIME_SLACK) return false;
        }
        return true;
    }

    /** Two peak bins below the band's width, then a gap of 1 to 63 frames, as {@link Landmarks#hash} packs them. */
    private static boolean isHash(int hash) {
        int f1 = hash >>> 15;
        int f2 = (hash >>> 6) & 511;
        int dt = hash & 63;
        return f1 < Landmarks.BINS && f2 < Landmarks.BINS && dt >= 1;
    }

    public static byte[] write(List<Entry> entries) {
        int size = 12;
        for (Entry entry : entries) size += 40 + entry.segment.hashes.length * 8;
        ByteBuffer buf = ByteBuffer.allocate(size).order(ByteOrder.LITTLE_ENDIAN);
        buf.putInt(MAGIC).putInt(VERSION).putInt(entries.size());
        for (Entry entry : entries) {
            String hex = entry.id.replace("-", "");
            for (int i = 0; i < 16; i++) buf.put((byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16));
            Segment s = entry.segment;
            buf.putInt(entry.number).putInt(entry.hidden ? 1 : 0).putInt(s.frames).putInt((int) s.durationMs)
                    .putInt(entry.score).putInt(s.hashes.length);
            for (int h : s.hashes) buf.putInt(h);
            for (int t : s.times) buf.putInt(t);
        }
        return buf.array();
    }

    private static String uuid(byte[] bytes) {
        StringBuilder hex = new StringBuilder(36);
        for (int i = 0; i < 16; i++) {
            if (i == 4 || i == 6 || i == 8 || i == 10) hex.append('-');
            hex.append(String.format(Locale.ROOT, "%02x", bytes[i]));
        }
        return hex.toString();
    }
}
