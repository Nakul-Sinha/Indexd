package com.farlands.telemetry;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * How long each player has been where they are.
 *
 * A time_in_region event is a completed stay, so one is produced when a player
 * leaves a region, disconnects, or when a flush closes off a stay that is still
 * running. Closing at a flush matters: without it a player who spends an hour
 * in one place contributes nothing until they move, and the rollup for every
 * window in between reads as an empty region.
 *
 * Stays shorter than a second produce nothing. The rollup sums seconds, so a
 * zero would be a line on the wire that changes no number.
 *
 * The tracker holds one entry per online player and no history, which keeps it
 * the same size as the player list rather than a function of how long the
 * server has been up.
 */
public final class RegionTracker {

    private record Presence(String region, Instant since) {}

    private final Map<String, Presence> presence = new HashMap<>();

    /**
     * Note where a player is now, closing off the previous stay if it ended.
     *
     * A null region means the player is somewhere the server has not named. The
     * stay is closed and nothing new is opened, because a duration credited to
     * an unnamed place would arrive at the rollup as a region that does not
     * exist on the server.
     */
    public synchronized List<WorldEvent> observe(String playerName, String region, Instant at) {
        if (playerName == null) {
            return List.of();
        }
        Presence current = presence.get(playerName);
        if (current != null && current.region().equals(region)) {
            return List.of();
        }

        List<WorldEvent> closed = close(playerName, current, at);
        if (region == null) {
            presence.remove(playerName);
        } else {
            presence.put(playerName, new Presence(region, at));
        }
        return closed;
    }

    /** Close a player's stay for good, on disconnect. */
    public synchronized List<WorldEvent> forget(String playerName, Instant at) {
        if (playerName == null) {
            return List.of();
        }
        return close(playerName, presence.remove(playerName), at);
    }

    /**
     * Close every open stay and immediately reopen it at the same place.
     *
     * Called once per flush so that time spent is reported while it is being
     * spent, rather than only once the player finally moves.
     */
    public synchronized List<WorldEvent> flush(Instant at) {
        List<WorldEvent> events = new ArrayList<>();
        for (Map.Entry<String, Presence> entry : presence.entrySet()) {
            Presence stay = entry.getValue();
            long seconds = elapsedSeconds(stay, at);
            if (seconds <= 0L) {
                continue;
            }
            events.add(WorldEvent.timeInRegion(at, entry.getKey(), stay.region(), seconds));
            // The stay reopens at the second that was just reported, not at the
            // flush instant, so the sub-second remainder is carried rather than
            // shaved off once per flush for as long as the player stands still.
            entry.setValue(new Presence(stay.region(), stay.since().plusMillis(seconds * 1000L)));
        }
        return events;
    }

    public synchronized int trackedPlayers() {
        return presence.size();
    }

    private List<WorldEvent> close(String playerName, Presence stay, Instant at) {
        if (stay == null) {
            return List.of();
        }
        long seconds = elapsedSeconds(stay, at);
        if (seconds <= 0L) {
            return List.of();
        }
        return List.of(WorldEvent.timeInRegion(at, playerName, stay.region(), seconds));
    }

    private static long elapsedSeconds(Presence stay, Instant at) {
        return (at.toEpochMilli() - stay.since().toEpochMilli()) / 1000L;
    }
}
