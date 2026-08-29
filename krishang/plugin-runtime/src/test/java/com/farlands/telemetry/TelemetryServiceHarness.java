package com.farlands.telemetry;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.logging.Logger;

/**
 * Test support: services wired to senders that behave badly on purpose.
 *
 * The emitter is built so that everything except one Bukkit listener can be
 * exercised without a server, and this is what that buys. A failing endpoint, a
 * hanging endpoint and a full queue are all one line to set up here, and all
 * three are conditions a live server would only reach during an incident.
 */
final class TelemetryServiceHarness {

    static final String SERVER_ID = "srv_7f2";
    static final Instant FIXED_INSTANT = Instant.parse("2026-08-29T18:00:00.000Z");

    private TelemetryServiceHarness() {}

    static TelemetryConfig config(int queueCapacity, int batchSize) {
        return config(queueCapacity, batchSize, 15);
    }

    static TelemetryConfig config(int queueCapacity, int batchSize, int flushSeconds) {
        return config(queueCapacity, batchSize, flushSeconds, Map.of());
    }

    static TelemetryConfig config(int queueCapacity, int batchSize, int flushSeconds, Map<String, String> regions) {
        return TelemetryConfig.of(
                true,
                "http://farlands-backend.dev-deployment.svc.cluster.local:3001",
                SERVER_ID,
                batchSize,
                flushSeconds,
                queueCapacity,
                5,
                30,
                regions);
    }

    static TelemetryService serviceWith(BatchSender sender) {
        return serviceWith(sender, config(1000, 200), Clock.fixed(FIXED_INSTANT, ZoneOffset.UTC));
    }

    static TelemetryService serviceWith(BatchSender sender, TelemetryConfig config, Clock clock) {
        return new TelemetryService(config, sender, clock, Logger.getLogger("farlands-telemetry-test"));
    }

    /** Keeps every batch it is handed, so a test can read what went on the wire. */
    static final class RecordingSender implements BatchSender {
        private final List<String> batches = new CopyOnWriteArrayList<>();

        @Override
        public void send(String ndjson) {
            batches.add(ndjson);
        }

        List<String> batches() {
            return List.copyOf(batches);
        }

        String wire() {
            return String.join("", batches);
        }
    }

    /** A clock that has stopped working, to prove the record methods swallow. */
    static final class BrokenClock extends Clock {
        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            throw new IllegalStateException("the clock is broken");
        }
    }
}
