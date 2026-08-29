package com.farlands.telemetry;

import java.net.URI;
import java.net.URISyntaxException;
import java.time.Duration;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Everything the emitter reads from config.yml, already checked.
 *
 * Validation lives here rather than at the call sites so that a misconfigured
 * world produces one refusal at boot instead of a POST every fifteen seconds to
 * an address that will never answer. A blank server id is the ordinary case,
 * not an error: the backend templates it into the ConfigMap when it deploys a
 * server, so a JAR built or run outside that path simply has telemetry off.
 *
 * The class is deliberately free of Bukkit types. read() pulls raw values out of
 * the plugin's configuration and everything after that is testable without a
 * server.
 */
public record TelemetryConfig(
        boolean enabled,
        URI endpoint,
        String serverId,
        int batchSize,
        Duration flushInterval,
        int queueCapacity,
        Duration requestTimeout,
        long regionSampleTicks,
        Map<String, String> regionsByWorld) {

    /** ServerId in packages/contracts/src/common.ts. A path segment ingest validates. */
    private static final Pattern SERVER_ID = Pattern.compile("^srv_[a-z0-9]{3,32}$");

    /** RegionName in the rule vocabulary, so telemetry names regions the way rules do. */
    private static final Pattern REGION_NAME = Pattern.compile("^[a-z][a-z0-9_]{1,31}$");

    /** TelemetryBatch caps events at 1000, so a larger batch would be refused whole. */
    public static final int MAX_BATCH_SIZE = 1000;

    public static final String DEFAULT_ENDPOINT = "http://farlands-backend.dev-deployment.svc.cluster.local:3001";
    public static final int DEFAULT_BATCH_SIZE = 200;
    public static final int DEFAULT_QUEUE_CAPACITY = 10_000;
    public static final int DEFAULT_FLUSH_SECONDS = 15;
    public static final int DEFAULT_REQUEST_TIMEOUT_SECONDS = 5;
    public static final int DEFAULT_REGION_SAMPLE_SECONDS = 30;

    /** A configuration that emits nothing, for every case where the rest is unusable. */
    public static TelemetryConfig disabled() {
        return new TelemetryConfig(
                false,
                URI.create(DEFAULT_ENDPOINT),
                "",
                DEFAULT_BATCH_SIZE,
                Duration.ofSeconds(DEFAULT_FLUSH_SECONDS),
                DEFAULT_QUEUE_CAPACITY,
                Duration.ofSeconds(DEFAULT_REQUEST_TIMEOUT_SECONDS),
                DEFAULT_REGION_SAMPLE_SECONDS * 20L,
                Map.of());
    }

    /**
     * Build a configuration, disabling the emitter rather than throwing when
     * something is unusable. A telemetry setting is never allowed to stop a
     * plugin from enabling, because that would stop the server.
     */
    public static TelemetryConfig of(
            boolean enabled,
            String endpoint,
            String serverId,
            int batchSize,
            int flushSeconds,
            int queueCapacity,
            int requestTimeoutSeconds,
            int regionSampleSeconds,
            Map<String, String> regionsByWorld) {

        String id = serverId == null ? "" : serverId.trim();
        URI parsed = parseEndpoint(endpoint);
        boolean usable = enabled && parsed != null && SERVER_ID.matcher(id).matches();

        int batch = clamp(batchSize, 1, MAX_BATCH_SIZE);
        int flush = Math.max(1, flushSeconds);
        int sample = Math.max(1, regionSampleSeconds);
        int timeout = Math.max(1, requestTimeoutSeconds);

        return new TelemetryConfig(
                usable,
                parsed == null ? URI.create(DEFAULT_ENDPOINT) : parsed,
                id,
                batch,
                Duration.ofSeconds(flush),
                // A queue that cannot hold one batch would drop events it was
                // about to send, so the floor is the batch size.
                Math.max(batch, queueCapacity),
                Duration.ofSeconds(timeout),
                sample * 20L,
                normaliseRegions(regionsByWorld));
    }

    /** The full ingest URL for this server. */
    public URI ingestUri() {
        String base = endpoint.toString();
        if (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        return URI.create(base + "/internal/telemetry/" + serverId);
    }

    /**
     * The region a world counts as, or null when the server has not named it.
     *
     * An explicit mapping wins, so an operator can call a world "nether_hub"
     * the way the rules do. Otherwise a world name that already looks like a
     * region name is used as one, which is what makes a single-world server
     * report regions without anybody configuring anything. Anything else is
     * null: a region ingest has never heard of is worse than no region.
     */
    public String regionFor(String worldName) {
        if (worldName == null) {
            return null;
        }
        String mapped = regionsByWorld.get(worldName);
        if (mapped != null) {
            return mapped;
        }
        String candidate = worldName.toLowerCase(Locale.ROOT);
        return REGION_NAME.matcher(candidate).matches() ? candidate : null;
    }

    private static URI parseEndpoint(String endpoint) {
        if (endpoint == null || endpoint.isBlank()) {
            return null;
        }
        try {
            URI uri = new URI(endpoint.trim());
            String scheme = uri.getScheme();
            if (uri.getHost() == null || scheme == null) {
                return null;
            }
            if (!scheme.equalsIgnoreCase("http") && !scheme.equalsIgnoreCase("https")) {
                return null;
            }
            return uri;
        } catch (URISyntaxException malformed) {
            return null;
        }
    }

    private static Map<String, String> normaliseRegions(Map<String, String> regions) {
        if (regions == null || regions.isEmpty()) {
            return Map.of();
        }
        Map<String, String> valid = new HashMap<>();
        for (Map.Entry<String, String> entry : regions.entrySet()) {
            String name = entry.getValue() == null ? "" : entry.getValue().trim().toLowerCase(Locale.ROOT);
            if (entry.getKey() != null && REGION_NAME.matcher(name).matches()) {
                valid.put(entry.getKey(), name);
            }
        }
        return Map.copyOf(valid);
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }
}
