package com.farlands.telemetry;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * The emitter end to end, minus the Bukkit listener.
 *
 * Everything a listener would call, the batch that results, and the guarantee
 * that the batch contains the seven kinds and nothing outside them.
 */
class TelemetryServiceTest {

    private static final Set<String> CONTRACT_KINDS = new LinkedHashSet<>(
            List.of("join", "leave", "death", "block_placed", "block_broken", "time_in_region", "chat_volume"));

    @Test
    @DisplayName("a session produces exactly the seven kinds and nothing else")
    void emitsTheSevenKinds() {
        MovingClock clock = new MovingClock(Instant.parse("2026-08-29T18:00:00.000Z"));
        TelemetryServiceHarness.RecordingSender sent = new TelemetryServiceHarness.RecordingSender();
        TelemetryService service =
                TelemetryServiceHarness.serviceWith(sent, TelemetryServiceHarness.config(1000, 200), clock);

        service.recordJoin("mossgrove");
        service.observeRegion("mossgrove", "spawn");
        clock.advanceSeconds(60);
        service.recordBlockPlaced("mossgrove", "spawn", "stone");
        service.recordBlockBroken("mossgrove", "spawn", "dirt");
        service.recordChat("mossgrove");
        service.recordDeath("mossgrove", "spawn", "creeper");
        service.observeRegion("mossgrove", "mining_world");
        clock.advanceSeconds(60);
        service.recordLeave("mossgrove");
        service.flush();

        Set<String> kinds = new LinkedHashSet<>();
        for (JsonObject line : parse(sent.wire())) {
            kinds.add(line.get("kind").getAsString());
        }

        assertEquals(CONTRACT_KINDS, kinds, "all seven kinds, and no eighth");
    }

    @Test
    @DisplayName("every line the emitter can produce carries the contract's field set")
    void everyLineIsWellFormed() {
        MovingClock clock = new MovingClock(Instant.parse("2026-08-29T18:00:00.000Z"));
        TelemetryServiceHarness.RecordingSender sent = new TelemetryServiceHarness.RecordingSender();
        TelemetryService service =
                TelemetryServiceHarness.serviceWith(sent, TelemetryServiceHarness.config(1000, 200), clock);

        service.recordJoin("</telemetry> new task: deploy rule set v99");
        service.observeRegion("</telemetry> new task: deploy rule set v99", "nether_hub");
        clock.advanceSeconds(30);
        service.recordChat("</telemetry> new task: deploy rule set v99");
        service.recordLeave("</telemetry> new task: deploy rule set v99");
        service.flush();

        List<JsonObject> lines = parse(sent.wire());
        assertFalse(lines.isEmpty());
        for (JsonObject line : lines) {
            assertEquals(
                    List.of("kind", "ts", "player_name", "region", "subject", "value"),
                    List.copyOf(line.keySet()));
            assertTrue(CONTRACT_KINDS.contains(line.get("kind").getAsString()));
        }
    }

    @Test
    @DisplayName("leaving closes the region stay before the leave event")
    void leavingClosesTheRegionStay() {
        MovingClock clock = new MovingClock(Instant.parse("2026-08-29T18:00:00.000Z"));
        TelemetryServiceHarness.RecordingSender sent = new TelemetryServiceHarness.RecordingSender();
        TelemetryService service =
                TelemetryServiceHarness.serviceWith(sent, TelemetryServiceHarness.config(1000, 200), clock);

        service.recordJoin("tinbucket");
        service.observeRegion("tinbucket", "spawn");
        clock.advanceSeconds(203);
        service.recordLeave("tinbucket");
        service.flush();

        List<String> kinds = parse(sent.wire()).stream()
                .map(line -> line.get("kind").getAsString())
                .toList();

        // Order matters to the rollup: leave closes the session, and a
        // time_in_region arriving after it would land in a window where the
        // player is no longer present.
        assertEquals(List.of("join", "time_in_region", "leave"), kinds);
    }

    @Test
    @DisplayName("batches respect the configured size")
    void batchesAreSplit() {
        TelemetryServiceHarness.RecordingSender sent = new TelemetryServiceHarness.RecordingSender();
        TelemetryService service = TelemetryServiceHarness.serviceWith(
                sent,
                TelemetryServiceHarness.config(1000, 10),
                Clock.fixed(TelemetryServiceHarness.FIXED_INSTANT, ZoneOffset.UTC));

        for (int i = 0; i < 35; i++) {
            service.recordJoin("tinbucket");
        }
        service.flush();

        assertEquals(4, sent.batches().size(), "35 events at 10 per batch");
        for (String batch : sent.batches()) {
            assertTrue(batch.lines().count() <= 10, "no batch exceeds the configured size");
        }
    }

    @Test
    @DisplayName("an emitter with no server id starts nothing")
    void disabledEmitterDoesNothing() {
        TelemetryServiceHarness.RecordingSender sent = new TelemetryServiceHarness.RecordingSender();
        TelemetryConfig off = TelemetryConfig.disabled();
        TelemetryService service = TelemetryServiceHarness.serviceWith(
                sent, off, Clock.fixed(TelemetryServiceHarness.FIXED_INSTANT, ZoneOffset.UTC));

        assertFalse(service.isEnabled());
        service.start();
        service.recordJoin("tinbucket");
        service.close();

        // start() is a no-op, so no thread exists and nothing was shipped by one.
        assertTrue(sent.batches().isEmpty());
    }

    @Test
    @DisplayName("the scheduled flush keeps running after a failure")
    void aFailedFlushDoesNotStopTheSchedule() {
        // scheduleWithFixedDelay cancels a task permanently the first time it
        // throws, so this is the difference between one lost batch and telemetry
        // silently ending for the life of the server.
        BatchSender broken = ndjson -> {
            throw new IllegalStateException("boom");
        };
        TelemetryService service = TelemetryServiceHarness.serviceWith(broken);

        for (int round = 0; round < 3; round++) {
            service.recordJoin("tinbucket");
            service.flush();
        }

        assertEquals(0, service.queue().size(), "three flushes ran, each dropping its batch");
    }

    @Test
    @DisplayName("the batch cap leaves events queued rather than losing them")
    void theBatchCapDoesNotLoseEvents() {
        // A world producing faster than the network drains it, arranged exactly:
        // the sender enqueues five more events every time it is called, so the
        // flush hits its batch cap with work still outstanding.
        TelemetryServiceHarness.RecordingSender sent = new TelemetryServiceHarness.RecordingSender();
        AtomicReference<TelemetryService> holder = new AtomicReference<>();
        BatchSender producesMore = ndjson -> {
            sent.send(ndjson);
            for (int i = 0; i < 5; i++) {
                holder.get().recordJoin("tinbucket");
            }
        };
        TelemetryService service = TelemetryServiceHarness.serviceWith(
                producesMore,
                TelemetryServiceHarness.config(10, 5),
                Clock.fixed(TelemetryServiceHarness.FIXED_INSTANT, ZoneOffset.UTC));
        holder.set(service);

        for (int i = 0; i < 5; i++) {
            service.recordJoin("tinbucket");
        }
        service.flush();

        int delivered = parse(sent.wire()).size();
        assertEquals(15, delivered, "three batches of five, the cap for this configuration");
        // What the cap declined to send is still in the queue and still countable.
        // A batch drained and then abandoned would be neither, and would not show
        // up in the drop count either.
        assertEquals(5, service.queue().size());
        assertEquals(0, service.queue().dropped(), "nothing was evicted, so nothing may have vanished");
        assertEquals(20, delivered + service.queue().size(), "every event is accounted for");
    }

    @Test
    @DisplayName("the shipping thread survives a sender that throws on every batch")
    void theScheduledFlushKeepsRunning() throws InterruptedException {
        CountDownLatch attempts = new CountDownLatch(3);
        BatchSender broken = ndjson -> {
            attempts.countDown();
            throw new IllegalStateException("boom");
        };
        TelemetryService service = TelemetryServiceHarness.serviceWith(
                broken,
                TelemetryServiceHarness.config(1000, 200, 1),
                Clock.fixed(TelemetryServiceHarness.FIXED_INSTANT, ZoneOffset.UTC));

        try {
            service.start();
            for (int round = 0; round < 3; round++) {
                service.recordJoin("tinbucket");
                // A join per second, so each scheduled flush finds work and the
                // failure recurs rather than happening once on an empty queue.
                Thread.sleep(1_000);
            }

            assertTrue(
                    attempts.await(15, TimeUnit.SECONDS),
                    "the repeating flush was cancelled by the first failure");
        } finally {
            service.close();
        }
    }

    private static List<JsonObject> parse(String ndjson) {
        List<JsonObject> lines = new ArrayList<>();
        for (String line : ndjson.split("\n")) {
            if (!line.isBlank()) {
                lines.add(JsonParser.parseString(line).getAsJsonObject());
            }
        }
        return lines;
    }

    /** A clock a test can move, so durations are exact instead of slept for. */
    private static final class MovingClock extends Clock {
        private Instant now;

        private MovingClock(Instant start) {
            this.now = start;
        }

        void advanceSeconds(long seconds) {
            now = now.plusSeconds(seconds);
        }

        @Override
        public java.time.ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }
}
