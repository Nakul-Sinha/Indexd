package com.farlands.telemetry;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * What the emitter does with configuration it cannot use.
 *
 * It emits nothing, and it does that quietly. A telemetry setting is never a
 * reason for a plugin to fail to enable, because that would take the world down
 * over a number nobody is currently reading.
 */
class TelemetryConfigTest {

    private static final String ENDPOINT = "http://farlands-backend.dev-deployment.svc.cluster.local:3001";

    @Test
    @DisplayName("a valid configuration builds the ingest URL from the contract's route")
    void buildsTheIngestUrl() {
        TelemetryConfig config = config(ENDPOINT, "srv_7f2");

        assertTrue(config.enabled());
        assertEquals(
                "http://farlands-backend.dev-deployment.svc.cluster.local:3001/internal/telemetry/srv_7f2",
                config.ingestUri().toString());
    }

    @Test
    @DisplayName("a trailing slash on the endpoint does not produce a double slash")
    void toleratesATrailingSlash() {
        assertEquals(
                "http://backend:3001/internal/telemetry/srv_7f2",
                config("http://backend:3001/", "srv_7f2").ingestUri().toString());
    }

    @Test
    @DisplayName("a server id the ingest route would reject turns the emitter off")
    void refusesAnInvalidServerId() {
        // Ingest validates :serverId against the contract's ServerId before it
        // reads a body, so an emitter posting anything else is posting into a
        // 404 every fifteen seconds forever.
        assertFalse(config(ENDPOINT, "").enabled(), "blank, which is the default in a JAR nobody deployed");
        assertFalse(config(ENDPOINT, "7f2").enabled(), "no prefix");
        assertFalse(config(ENDPOINT, "srv_ab").enabled(), "too short");
        assertFalse(config(ENDPOINT, "srv_UPPER").enabled(), "uppercase");
        assertFalse(config(ENDPOINT, "srv_a/../b").enabled(), "a path traversal in a path segment");
        assertTrue(config(ENDPOINT, "srv_7f2").enabled());
    }

    @Test
    @DisplayName("an endpoint that is not an http URL turns the emitter off")
    void refusesAnUnusableEndpoint() {
        assertFalse(config("", "srv_7f2").enabled());
        assertFalse(config("not a url", "srv_7f2").enabled());
        assertFalse(config("ftp://backend:3001", "srv_7f2").enabled(), "only http and https");
        assertTrue(config("https://backend:3001", "srv_7f2").enabled());
    }

    @Test
    @DisplayName("batch size is clamped to the limit the ingest contract enforces")
    void clampsBatchSize() {
        // TelemetryBatch caps events at 1000 and ingest refuses a larger batch
        // whole, so a misconfigured batch size would lose every event rather
        // than some.
        assertEquals(1000, of(ENDPOINT, "srv_7f2", 5000, 10_000).batchSize());
        assertEquals(1, of(ENDPOINT, "srv_7f2", 0, 10_000).batchSize());
        assertEquals(200, of(ENDPOINT, "srv_7f2", 200, 10_000).batchSize());
    }

    @Test
    @DisplayName("the queue is never smaller than one batch")
    void queueHoldsAtLeastABatch() {
        assertEquals(500, of(ENDPOINT, "srv_7f2", 500, 10).queueCapacity());
    }

    @Test
    @DisplayName("worlds map to region names, and unnamed worlds map to nothing")
    void resolvesRegions() {
        TelemetryConfig config = TelemetryConfig.of(
                true,
                ENDPOINT,
                "srv_7f2",
                200,
                15,
                10_000,
                5,
                30,
                Map.of("world", "spawn", "world_nether", "nether_hub", "Broken World", "Not A Region"));

        assertEquals("spawn", config.regionFor("world"), "an explicit mapping wins");
        assertEquals("nether_hub", config.regionFor("world_nether"));
        assertEquals(
                "mining_world",
                config.regionFor("mining_world"),
                "an unmapped world that already looks like a region is used as one");
        assertNull(config.regionFor("A World With Spaces"), "a name the rule vocabulary would reject is no region");
        // The mapping is dropped because "Not A Region" is not a region name, and
        // the world falls back to its own name, which is not one either. A region
        // the server has never declared would arrive at the rollup as a place
        // that does not exist.
        assertNull(config.regionFor("Broken World"), "an invalid mapping is discarded rather than sent");
        assertNull(config.regionFor(null));
    }

    @Test
    @DisplayName("disabled is a usable configuration, not a half-built one")
    void disabledIsComplete() {
        TelemetryConfig config = TelemetryConfig.disabled();

        assertFalse(config.enabled());
        assertTrue(config.queueCapacity() > 0, "so nothing downstream has to check before constructing a queue");
        assertTrue(config.batchSize() > 0);
    }

    private static TelemetryConfig config(String endpoint, String serverId) {
        return of(endpoint, serverId, 200, 10_000);
    }

    private static TelemetryConfig of(String endpoint, String serverId, int batchSize, int queueCapacity) {
        return TelemetryConfig.of(true, endpoint, serverId, batchSize, 15, queueCapacity, 5, 30, Map.of());
    }
}
