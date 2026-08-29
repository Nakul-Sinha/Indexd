package com.farlands.telemetry;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/**
 * The buffer between the game and the network, bounded, dropping the oldest.
 *
 * Dropping telemetry is always preferable to degrading the game. That is the
 * whole reasoning behind every decision in this class:
 *
 *   - It is bounded, so an ingest outage costs a fixed amount of heap instead of
 *     growing one event at a time until the server that players are on runs out
 *     of memory.
 *   - It drops the oldest rather than refusing the newest, because during an
 *     outage the recent minutes are the ones anybody will want, and a queue that
 *     fills up and then rejects everything preserves exactly the wrong window.
 *   - offer() never blocks and never throws. It is called from the main server
 *     thread and from the async chat thread, and neither may wait on telemetry.
 *
 * ArrayDeque under a lock rather than ArrayBlockingQueue, because drop-oldest
 * needs the eviction and the insert to be one atomic step, and the blocking
 * queues offer no such operation.
 */
public final class BoundedEventQueue {

    private final ArrayDeque<WorldEvent> events;
    private final int capacity;
    private long dropped;

    public BoundedEventQueue(int capacity) {
        if (capacity < 1) {
            throw new IllegalArgumentException("capacity must be at least 1");
        }
        this.capacity = capacity;
        this.events = new ArrayDeque<>(Math.min(capacity, 1024));
    }

    /** Add one event, evicting the oldest if the queue is already full. */
    public synchronized void offer(WorldEvent event) {
        if (event == null) {
            return;
        }
        if (events.size() >= capacity) {
            events.removeFirst();
            dropped++;
        }
        events.addLast(event);
    }

    public synchronized void offerAll(Collection<WorldEvent> batch) {
        for (WorldEvent event : batch) {
            offer(event);
        }
    }

    /** Take up to max events, oldest first. Returns an empty list when idle. */
    public synchronized List<WorldEvent> drain(int max) {
        int take = Math.min(max, events.size());
        List<WorldEvent> batch = new ArrayList<>(take);
        for (int i = 0; i < take; i++) {
            batch.add(events.removeFirst());
        }
        return batch;
    }

    public synchronized int size() {
        return events.size();
    }

    public int capacity() {
        return capacity;
    }

    /** Total events evicted since startup, for the one log line an outage earns. */
    public synchronized long dropped() {
        return dropped;
    }
}
