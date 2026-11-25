/*
 * Copyright 2026 SponsorBlock for TikTok contributors
 * SPDX-License-Identifier: GPL-3.0-only
 */
package io.github.midtano.tiktoksponsorblock;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.List;
import java.util.Random;

public class SnapshotTest {
    @Test
    public void writesAndReadsBack() {
        Segment segment = new Segment("x", "x", 4200, new int[]{1, 2, 3}, new int[]{0, 5, 9}, 131);
        Snapshot.Entry entry = new Snapshot.Entry("839c0a7c-9726-4991-9965-e17917f26124", 12, true, -1, segment);
        List<Snapshot.Entry> read = Snapshot.read(Snapshot.write(Arrays.asList(entry)));
        assertEquals(1, read.size());
        Snapshot.Entry back = read.get(0);
        assertEquals(entry.id, back.id);
        assertEquals(12, back.number);
        assertTrue(back.hidden);
        assertEquals(-1, back.score);
        assertEquals("ad12", back.segment.name);
        assertEquals(131, back.segment.frames);
        assertEquals(4200, back.segment.durationMs);
        assertArrayEquals(segment.hashes, back.segment.hashes);
        assertArrayEquals(segment.times, back.segment.times);
    }

    @Test
    public void ignoresATruncatedTail() {
        Segment segment = new Segment("x", "x", 1000, new int[]{1, 2}, new int[]{0, 1}, 31);
        byte[] data = Snapshot.write(Arrays.asList(
                new Snapshot.Entry("00000000-0000-4000-8000-000000000001", 1, false, 0, segment),
                new Snapshot.Entry("00000000-0000-4000-8000-000000000002", 2, false, 0, segment)));
        assertEquals(1, Snapshot.read(Arrays.copyOf(data, data.length - 4)).size());
    }

    @Test
    public void skipsARecordWithAnImpossibleHash() {
        Segment bad = new Segment("x", "x", 2000, new int[]{-1, 2}, new int[]{0, 1}, 62);
        Segment good = new Segment("x", "x", 2000, new int[]{1, 2}, new int[]{0, 1}, 62);
        byte[] data = Snapshot.write(Arrays.asList(
                new Snapshot.Entry("00000000-0000-4000-8000-000000000001", 1, false, 0, bad),
                new Snapshot.Entry("00000000-0000-4000-8000-000000000002", 2, false, 0, good)));
        List<Snapshot.Entry> read = Snapshot.read(data);
        assertEquals(1, read.size());
        assertEquals(2, read.get(0).number);
    }

    @Test
    public void skipsARecordOverTheHashLimit() {
        int[] hashes = new int[6_001];
        Arrays.fill(hashes, 1);
        Segment big = new Segment("x", "x", 2000, hashes, new int[hashes.length], 62);
        Segment good = new Segment("x", "x", 2000, new int[]{1, 2}, new int[]{0, 1}, 62);
        byte[] data = Snapshot.write(Arrays.asList(
                new Snapshot.Entry("00000000-0000-4000-8000-000000000001", 1, false, 0, big),
                new Snapshot.Entry("00000000-0000-4000-8000-000000000002", 2, false, 0, good)));
        List<Snapshot.Entry> read = Snapshot.read(data);
        assertEquals(1, read.size());
        assertEquals(2, read.get(0).number);
    }

    @Test
    public void randomBytesOnlyFailAsIllegalArgument() {
        Random random = new Random(1);
        for (int i = 0; i < 10_000; i++) {
            byte[] data = new byte[12 + random.nextInt(200)];
            random.nextBytes(data);
            if (i % 2 == 0) {
                ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN).putInt(Snapshot.MAGIC).putInt(Snapshot.VERSION);
            }
            try {
                assertTrue(Snapshot.read(data).isEmpty());
            } catch (IllegalArgumentException expected) {
            }
        }
    }
}
