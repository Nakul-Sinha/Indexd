package com.farlands.telemetry;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Chat as a number.
 *
 * This is the single most important class in the emitter, and its whole design
 * is one absence: record() takes a player name and nothing else. There is no
 * overload that accepts a message, no field that could hold one, and no way for
 * a caller to pass one by mistake. Chat is the injection surface, and the
 * safest way to handle player-authored text is to never carry it, so the type
 * system is where that rule is enforced rather than a review comment.
 *
 * Counts accumulate per player and drain once per flush, so a busy player
 * produces one chat_volume event per window rather than one per message. That
 * is also why the contract documents value as a message count: the rollup wants
 * volume, and volume is all that leaves the server.
 *
 * Synchronized because Paper delivers chat off the main thread. The lock is
 * held for a map update and nothing else.
 */
public final class ChatVolumeCounter {

    private final Map<String, Long> counts = new HashMap<>();

    /** One message from this player. What they said is not a parameter. */
    public synchronized void record(String playerName) {
        if (playerName == null) {
            return;
        }
        counts.merge(playerName, 1L, Long::sum);
    }

    /** Take the accumulated counts as events and reset. */
    public synchronized List<WorldEvent> drain(Instant at) {
        if (counts.isEmpty()) {
            return List.of();
        }
        List<WorldEvent> events = new ArrayList<>(counts.size());
        for (Map.Entry<String, Long> entry : counts.entrySet()) {
            events.add(WorldEvent.chatVolume(at, entry.getKey(), entry.getValue()));
        }
        counts.clear();
        return events;
    }

    public synchronized int pendingPlayers() {
        return counts.size();
    }
}
