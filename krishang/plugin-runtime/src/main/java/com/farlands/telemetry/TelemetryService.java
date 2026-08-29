package com.farlands.telemetry;

import java.time.Clock;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.logging.Level;
import java.util.logging.Logger;

import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * The emitter: everything the listeners call, and the thread that ships.
 *
 * Three properties hold for every method on this class, and they are the reason
 * it exists as a layer rather than the listeners talking to the queue directly:
 *
 *   1. Nothing throws. Every entry point catches Throwable, so a defect here
 *      cannot become an exception inside a Bukkit event handler, where it would
 *      cancel a join or a block place and turn a telemetry bug into a gameplay
 *      one.
 *   2. Nothing blocks. The record methods append to a bounded queue and return.
 *      All I/O happens on one daemon thread that the game never waits on.
 *   3. Nothing is retried. A batch that fails is gone, because the alternative
 *      is a retry buffer that grows during exactly the outage the bounded queue
 *      exists to survive.
 *
 * Telemetry is never allowed to hurt the game, and the three together are what
 * that sentence means in code.
 */
public final class TelemetryService implements AutoCloseable {

    /** A stopping server waits this long for a last batch, and no longer. */
    private static final long SHUTDOWN_WAIT_SECONDS = 2L;

    private final TelemetryConfig config;
    private final BoundedEventQueue queue;
    private final ChatVolumeCounter chat = new ChatVolumeCounter();
    private final RegionTracker regions = new RegionTracker();
    private final TelemetrySerializer serializer = new TelemetrySerializer();
    private final BatchSender sender;
    private final Clock clock;
    private final Logger log;

    private ScheduledExecutorService flusher;
    private long lastReportedDrops;

    public TelemetryService(TelemetryConfig config, BatchSender sender, Clock clock, Logger log) {
        this.config = config;
        this.sender = sender;
        this.clock = clock;
        this.log = log;
        this.queue = new BoundedEventQueue(config.queueCapacity());
    }

    /**
     * Read config.yml and wire the real sender.
     *
     * The only method in the emitter that touches Bukkit besides the listener,
     * which is what keeps the rest of the package testable without a server.
     */
    public static TelemetryService create(JavaPlugin plugin) {
        TelemetryConfig config;
        try {
            config = readConfig(plugin);
        } catch (RuntimeException malformed) {
            // A config.yml that cannot be read is a reason to emit nothing, not
            // a reason to fail onEnable and take the world down with it.
            plugin.getLogger().warning("Telemetry configuration could not be read, so telemetry is off.");
            config = TelemetryConfig.disabled();
        }

        BatchSender sender = config.enabled()
                ? new HttpBatchSender(config.ingestUri(), config.requestTimeout())
                : ndjson -> { };

        return new TelemetryService(config, sender, Clock.systemUTC(), plugin.getLogger());
    }

    static TelemetryConfig readConfig(JavaPlugin plugin) {
        Map<String, String> regionsByWorld = new HashMap<>();
        ConfigurationSection section = plugin.getConfig().getConfigurationSection("telemetry.regions");
        if (section != null) {
            for (String world : section.getKeys(false)) {
                regionsByWorld.put(world, section.getString(world));
            }
        }

        return TelemetryConfig.of(
                plugin.getConfig().getBoolean("telemetry.enabled", true),
                plugin.getConfig().getString("telemetry.endpoint", TelemetryConfig.DEFAULT_ENDPOINT),
                plugin.getConfig().getString("telemetry.serverId", ""),
                plugin.getConfig().getInt("telemetry.batchSize", TelemetryConfig.DEFAULT_BATCH_SIZE),
                plugin.getConfig().getInt("telemetry.flushSeconds", TelemetryConfig.DEFAULT_FLUSH_SECONDS),
                plugin.getConfig().getInt("telemetry.queueCapacity", TelemetryConfig.DEFAULT_QUEUE_CAPACITY),
                plugin.getConfig().getInt(
                        "telemetry.requestTimeoutSeconds", TelemetryConfig.DEFAULT_REQUEST_TIMEOUT_SECONDS),
                plugin.getConfig().getInt(
                        "telemetry.regionSampleSeconds", TelemetryConfig.DEFAULT_REGION_SAMPLE_SECONDS),
                regionsByWorld);
    }

    public boolean isEnabled() {
        return config.enabled();
    }

    public TelemetryConfig config() {
        return config;
    }

    /** Start the shipping thread. Does nothing when telemetry is off. */
    public synchronized void start() {
        if (!config.enabled() || flusher != null) {
            return;
        }
        flusher = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "farlands-telemetry");
            // Daemon, so a stuck request can never be the reason a server
            // refuses to exit.
            thread.setDaemon(true);
            return thread;
        });
        long period = config.flushInterval().toSeconds();
        flusher.scheduleWithFixedDelay(this::flush, period, period, TimeUnit.SECONDS);
        log.info("Telemetry emitting to " + config.ingestUri());
    }

    public void recordJoin(String playerName) {
        offer(() -> queue.offer(WorldEvent.join(now(), playerName)));
    }

    public void recordLeave(String playerName) {
        offer(() -> {
            Instant at = now();
            queue.offerAll(regions.forget(playerName, at));
            queue.offer(WorldEvent.leave(at, playerName));
        });
    }

    public void recordDeath(String playerName, String region, String subject) {
        offer(() -> queue.offer(WorldEvent.death(now(), playerName, region, subject)));
    }

    public void recordBlockPlaced(String playerName, String region, String subject) {
        offer(() -> queue.offer(WorldEvent.blockPlaced(now(), playerName, region, subject)));
    }

    public void recordBlockBroken(String playerName, String region, String subject) {
        offer(() -> queue.offer(WorldEvent.blockBroken(now(), playerName, region, subject)));
    }

    /** One chat message from this player. The message itself is not a parameter. */
    public void recordChat(String playerName) {
        offer(() -> chat.record(playerName));
    }

    /** Where a player is right now, sampled on the main thread. */
    public void observeRegion(String playerName, String region) {
        offer(() -> queue.offerAll(regions.observe(playerName, region, now())));
    }

    public String regionFor(String worldName) {
        return config.regionFor(worldName);
    }

    /**
     * Drain and ship, catching everything.
     *
     * Catching Throwable is not defensive habit here: scheduleWithFixedDelay
     * cancels a repeating task permanently the first time it throws, so an
     * escape would silence telemetry for the rest of the server's life and
     * leave no trace beyond a missing number.
     */
    public void flush() {
        try {
            Instant at = now();
            queue.offerAll(chat.drain(at));
            queue.offerAll(regions.flush(at));

            // Several batches per flush, so a queue that filled during an outage
            // drains once the endpoint comes back rather than losing ground at
            // one batch per interval. Capped so that a world busy enough to
            // out-produce the network ends the flush and lets the queue drop,
            // instead of holding this thread in a loop it can never win.
            //
            // The budget is spent before the drain, never after, so the cap can
            // never take events out of the queue and then decline to send them.
            // Those events would be lost without being dropped, which is not the
            // same thing and would not show up in the drop count.
            int remaining = maxBatchesPerFlush();
            while (remaining-- > 0) {
                List<WorldEvent> batch = queue.drain(config.batchSize());
                if (batch.isEmpty()) {
                    break;
                }
                deliver(batch);
            }
            reportDrops();
        } catch (Throwable failure) {
            logQuietly("Telemetry flush failed", failure);
        }
    }

    /**
     * Stop shipping.
     *
     * One last flush is attempted because the quit events for everybody online
     * arrive moments before this, and they are what closes their sessions in the
     * rollup. It is bounded: a shutdown never waits longer than
     * SHUTDOWN_WAIT_SECONDS on an endpoint that has stopped answering, and
     * whatever is still queued is dropped, which is the same trade the queue
     * makes every other time it is full.
     */
    @Override
    public synchronized void close() {
        ScheduledExecutorService running = flusher;
        flusher = null;
        try {
            if (running != null) {
                running.execute(this::flush);
                running.shutdown();
                if (!running.awaitTermination(SHUTDOWN_WAIT_SECONDS, TimeUnit.SECONDS)) {
                    running.shutdownNow();
                }
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        } catch (Throwable failure) {
            logQuietly("Telemetry shutdown failed", failure);
        } finally {
            closeSender();
        }
    }

    BoundedEventQueue queue() {
        return queue;
    }

    /** Enough batches to empty a full queue in one pass, and not more. */
    private int maxBatchesPerFlush() {
        return (config.queueCapacity() / config.batchSize()) + 1;
    }

    private void deliver(List<WorldEvent> batch) {
        try {
            sender.send(serializer.toNdjson(batch));
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        } catch (Exception unreachable) {
            // The batch is already out of the queue and is not put back. A world
            // whose telemetry endpoint is unreachable keeps playing and loses
            // events, which is the entire deal.
            logQuietly("Telemetry batch dropped", unreachable);
        }
    }

    private void offer(Runnable action) {
        try {
            action.run();
        } catch (Throwable failure) {
            logQuietly("Telemetry event dropped", failure);
        }
    }

    private void closeSender() {
        try {
            sender.close();
        } catch (Throwable failure) {
            logQuietly("Telemetry sender did not close cleanly", failure);
        }
    }

    /**
     * Report evictions once per flush, at FINE.
     *
     * An outage produces a drop on nearly every event, and a warning per drop
     * would bury the server log in the exact situation where an operator needs
     * to read it.
     */
    private void reportDrops() {
        long dropped = queue.dropped();
        if (dropped > lastReportedDrops) {
            long since = dropped - lastReportedDrops;
            lastReportedDrops = dropped;
            logQuietly("Telemetry queue dropped " + since + " events to stay bounded", null);
        }
    }

    private void logQuietly(String message, Throwable cause) {
        // FINE, because none of this is actionable by the person running the
        // server and none of it affects play. The exception message is logged
        // without its stack trace: it can carry a URL and a status, never an
        // event, so no player-authored text reaches the log from here.
        if (log.isLoggable(Level.FINE)) {
            log.fine(cause == null ? message : message + ": " + cause);
        }
    }

    private Instant now() {
        return clock.instant();
    }
}
