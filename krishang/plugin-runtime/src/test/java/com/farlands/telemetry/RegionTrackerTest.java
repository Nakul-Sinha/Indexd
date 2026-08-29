package com.farlands.telemetry;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * time_in_region, which is the only one of the seven kinds that is measured
 * rather than observed.
 *
 * The rollup sums these per region, so what matters is that a stay is counted
 * once, that it is counted while it is happening rather than only when it ends,
 * and that a place the server has not named contributes nothing.
 */
class RegionTrackerTest {

    private static final Instant START = Instant.parse("2026-08-29T18:00:00.000Z");

    @Test
    @DisplayName("moving between regions closes the stay that ended")
    void movingClosesTheStay() {
        RegionTracker tracker = new RegionTracker();

        assertTrue(tracker.observe("mossgrove", "spawn", START).isEmpty(), "arriving reports nothing yet");

        List<WorldEvent> events = tracker.observe("mossgrove", "mining_world", at(203));

        assertEquals(1, events.size());
        WorldEvent event = events.get(0);
        assertEquals(WorldEventKind.TIME_IN_REGION, event.kind());
        assertEquals("mossgrove", event.playerName());
        assertEquals("spawn", event.region(), "credited to where the time was spent, not where they went");
        assertEquals(203L, event.value());
    }

    @Test
    @DisplayName("staying put still reports, once per flush")
    void aLongStayIsReportedWhileItHappens() {
        RegionTracker tracker = new RegionTracker();
        tracker.observe("mossgrove", "mining_world", START);

        List<WorldEvent> first = tracker.flush(at(15));
        List<WorldEvent> second = tracker.flush(at(30));

        assertEquals(15L, first.get(0).value());
        assertEquals(15L, second.get(0).value(), "the second window counts from the first, not from arrival");
    }

    @Test
    @DisplayName("repeated sampling in one place does not double count")
    void samplingDoesNotAccumulate() {
        RegionTracker tracker = new RegionTracker();
        tracker.observe("mossgrove", "spawn", START);
        for (int second = 1; second <= 30; second++) {
            assertTrue(tracker.observe("mossgrove", "spawn", at(second)).isEmpty(), "same place, nothing closed");
        }

        List<WorldEvent> events = tracker.forget("mossgrove", at(30));

        assertEquals(1, events.size(), "one stay, one event");
        assertEquals(30L, events.get(0).value());
    }

    @Test
    @DisplayName("sub-second remainders carry rather than being shaved off each flush")
    void remaindersCarry() {
        RegionTracker tracker = new RegionTracker();
        tracker.observe("mossgrove", "spawn", START);

        // Three flushes 1500ms apart. Truncating to whole seconds each time and
        // restarting from the flush instant would report 1, 1, 1 and quietly
        // lose a second and a half of the four and a half that elapsed.
        long total = tracker.flush(START.plusMillis(1500)).get(0).value()
                + tracker.flush(START.plusMillis(3000)).get(0).value()
                + tracker.flush(START.plusMillis(4500)).get(0).value();

        assertEquals(4L, total);
    }

    @Test
    @DisplayName("a world the server has not named contributes no region")
    void unnamedPlacesAreNotTracked() {
        RegionTracker tracker = new RegionTracker();
        tracker.observe("mossgrove", "spawn", START);

        List<WorldEvent> closed = tracker.observe("mossgrove", null, at(60));

        assertEquals(1, closed.size(), "the named stay is still credited");
        assertEquals("spawn", closed.get(0).region());
        assertEquals(0, tracker.trackedPlayers(), "and nothing is tracked afterwards");
        assertTrue(tracker.flush(at(120)).isEmpty(), "so a later flush invents no region");
    }

    @Test
    @DisplayName("a stay shorter than a second is not a line on the wire")
    void subSecondStaysAreNotEmitted() {
        RegionTracker tracker = new RegionTracker();
        tracker.observe("mossgrove", "spawn", START);

        assertTrue(tracker.observe("mossgrove", "nether_hub", START.plusMillis(400)).isEmpty());
    }

    @Test
    @DisplayName("the tracker is the size of the player list, not of the session")
    void memoryIsBoundedByPlayers() {
        RegionTracker tracker = new RegionTracker();

        for (int minute = 0; minute < 1000; minute++) {
            tracker.observe("mossgrove", minute % 2 == 0 ? "spawn" : "mining_world", at(minute * 60L));
        }

        assertEquals(1, tracker.trackedPlayers(), "one player, one entry, however long they play");
    }

    private static Instant at(long seconds) {
        return START.plus(Duration.ofSeconds(seconds));
    }
}
