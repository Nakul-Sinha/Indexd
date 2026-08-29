package com.farlands.telemetry;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Instant;
import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The bound, and what happens when it is reached.
 *
 * An ingest outage is the case this class exists for: events keep arriving and
 * nothing is leaving. The queue must stay the same size, keep the newest events,
 * and never make a producer wait, because the producers are the main server
 * thread and Paper's chat thread.
 */
class BoundedEventQueueTest {

    private static final Instant AT = Instant.parse("2026-08-29T18:00:00.000Z");

    @Test
    @DisplayName("a full queue drops the oldest entry rather than growing")
    void dropsOldestWhenFull() {
        BoundedEventQueue queue = new BoundedEventQueue(3);

        for (int i = 0; i < 10; i++) {
            queue.offer(WorldEvent.join(AT, "player_" + i));
        }

        assertEquals(3, queue.size(), "the queue never exceeds its capacity");
        assertEquals(7, queue.dropped(), "seven evictions to make room for the last three");

        List<WorldEvent> drained = queue.drain(10);
        assertEquals(
                List.of("player_7", "player_8", "player_9"),
                drained.stream().map(WorldEvent::playerName).toList(),
                "the survivors are the newest, in order");
    }

    @Test
    @DisplayName("a sustained outage costs a fixed amount of heap")
    void heapDoesNotGrowDuringAnOutage() {
        BoundedEventQueue queue = new BoundedEventQueue(100);

        for (int i = 0; i < 100_000; i++) {
            queue.offer(WorldEvent.chatVolume(AT, "tinbucket", 1L));
        }

        assertEquals(100, queue.size(), "a hundred thousand events, a hundred retained");
        assertEquals(99_900, queue.dropped());
    }

    @Test
    @DisplayName("offering to a full queue does not block")
    void offerDoesNotBlock() {
        BoundedEventQueue queue = new BoundedEventQueue(8);
        for (int i = 0; i < 8; i++) {
            queue.offer(WorldEvent.join(AT, "filler"));
        }

        long startedAt = System.nanoTime();
        for (int i = 0; i < 50_000; i++) {
            queue.offer(WorldEvent.join(AT, "tinbucket"));
        }
        long elapsedMillis = (System.nanoTime() - startedAt) / 1_000_000L;

        // Generous by three orders of magnitude. It is not measuring speed, it is
        // catching an implementation that waits for room, which would stall the
        // tick rather than merely be slow.
        assertTrue(elapsedMillis < 2_000, "50000 offers onto a full queue took " + elapsedMillis + "ms");
        assertEquals(8, queue.size());
    }

    @Test
    @DisplayName("draining takes the oldest first and never more than asked")
    void drainIsBoundedAndOrdered() {
        BoundedEventQueue queue = new BoundedEventQueue(10);
        for (int i = 0; i < 6; i++) {
            queue.offer(WorldEvent.join(AT, "player_" + i));
        }

        List<WorldEvent> first = queue.drain(4);
        assertEquals(4, first.size());
        assertEquals("player_0", first.get(0).playerName());
        assertEquals(2, queue.size());

        assertEquals(2, queue.drain(100).size(), "drain takes what is there when asked for more");
        assertEquals(0, queue.drain(100).size(), "an empty queue drains to an empty list");
    }

    @Test
    @DisplayName("concurrent producers cannot push the queue past its bound")
    void concurrentProducersStayBounded() throws InterruptedException {
        BoundedEventQueue queue = new BoundedEventQueue(64);

        // Two producers, standing in for the main thread and Paper's chat thread.
        Runnable producer = () -> {
            for (int i = 0; i < 20_000; i++) {
                queue.offer(WorldEvent.join(AT, "tinbucket"));
            }
        };
        Thread one = new Thread(producer);
        Thread two = new Thread(producer);
        one.start();
        two.start();
        one.join();
        two.join();

        assertEquals(64, queue.size());
        assertEquals(40_000 - 64, queue.dropped());
    }
}
