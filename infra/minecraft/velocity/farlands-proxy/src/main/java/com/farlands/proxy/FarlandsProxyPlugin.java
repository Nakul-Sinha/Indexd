package com.farlands.proxy;

import com.google.inject.Inject;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.proxy.ProxyInitializeEvent;
import com.velocitypowered.api.event.proxy.ProxyShutdownEvent;
import com.velocitypowered.api.event.proxy.ProxyPingEvent;
import com.velocitypowered.api.plugin.Plugin;
import com.velocitypowered.api.proxy.ProxyServer;
import com.velocitypowered.api.proxy.server.ServerPing;
import com.velocitypowered.api.scheduler.ScheduledTask;
import org.slf4j.Logger;

import java.util.concurrent.TimeUnit;

/**
 * Entry point for the Farlands Velocity proxy plugin.
 *
 * <p>This plugin implements a "Pull Model" for server routing: instead of
 * reading static server addresses from {@code velocity.toml}, it polls the
 * Farlands backend REST API every {@link PluginConfig#POLL_INTERVAL_SECONDS}
 * seconds and dynamically registers or unregisters backend Paper servers in
 * Velocity's in-memory routing table.
 *
 * <h2>Lifecycle</h2>
 * <ol>
 *   <li>{@link ProxyInitializeEvent} → starts the async polling loop.
 *   <li>{@link ProxyShutdownEvent}   → cancels the polling loop cleanly.
 * </ol>
 *
 * <h2>Why @Plugin fields matter</h2>
 * Velocity's annotation processor reads the {@code @Plugin} annotation at
 * compile time and writes a {@code velocity-plugin.json} descriptor into the
 * jar.  The proxy loads that descriptor to discover and instantiate the plugin.
 * All fields must be compile-time string constants.
 */
@Plugin(
        // Must be lowercase, no spaces – used as the plugin's directory name.
        id = "farlands-proxy",
        name = "Farlands Proxy",
        version = "1.0.0",
        description = "Dynamically routes players to backend servers by polling the Farlands API.",
        authors = {"farlands"}
)
public final class FarlandsProxyPlugin {

    // -----------------------------------------------------------------------
    // Velocity-injected singletons
    // -----------------------------------------------------------------------

    /** Velocity's central API hub: server registration, player access, scheduler. */
    private final ProxyServer proxyServer;

    /** SLF4J logger bound to this plugin's ID by Velocity. */
    private final Logger logger;

    // -----------------------------------------------------------------------
    // Plugin state
    // -----------------------------------------------------------------------

    /**
     * Handle to the active polling task.
     * Retained so we can cancel it cleanly on shutdown, preventing the
     * scheduler from firing after Velocity has begun teardown.
     */
    private ScheduledTask syncTask;
    private ScheduledTask transferTask;
    private ServerSyncTask syncTaskInstance;

    // -----------------------------------------------------------------------
    // Constructor – called by Velocity's Guice injector
    // -----------------------------------------------------------------------

    /**
     * Velocity uses Guice to inject dependencies into plugin constructors.
     * {@link ProxyServer} and {@link Logger} are always available.
     *
     * @param proxyServer Velocity's proxy API instance.
     * @param logger      SLF4J logger scoped to this plugin.
     */
    @Inject
    public FarlandsProxyPlugin(ProxyServer proxyServer, Logger logger) {
        this.proxyServer = proxyServer;
        this.logger = logger;
    }

    // -----------------------------------------------------------------------
    // Lifecycle events
    // -----------------------------------------------------------------------

    /**
     * Fires once after Velocity has finished loading all plugins and is ready
     * to accept connections.
     *
     * <p>We start the polling loop here rather than in the constructor because
     * the scheduler and proxy API are not guaranteed to be fully initialised
     * before this event fires.
     *
     * @param event the initialisation event (unused – we only care that it fired).
     */
    @Subscribe
    public void onProxyInitialize(ProxyInitializeEvent event) {
        logger.info("[FarlandsProxy] Plugin initialising.");
        logger.info("[FarlandsProxy] Backend API base URL : {}", PluginConfig.API_BASE_URL);
        // Never log the raw secret – just confirm it is not a known placeholder.
        // IMPORTANT: both "change-me-in-production" (class default) and
        // "dummy-secret-replace-me" (K8s Secret template value) are treated as
        // placeholders.  Applying the bundled manifests without replacing the
        // Secret will cause every poll to get a 401 from the backend; operators
        // must see a clear warning rather than a false "✔ custom value" message.
        boolean isPlaceholder = PluginConfig.API_SECRET.equals("change-me-in-production")
                || PluginConfig.API_SECRET.equals("dummy-secret-replace-me");
        logger.info("[FarlandsProxy] API secret configured : {}",
                isPlaceholder
                        ? "⚠ PLACEHOLDER (replace velocity-plugin-secret in the cluster before production!)"
                        : "✔ custom value");

        syncTaskInstance = new ServerSyncTask(proxyServer, logger);

        syncTask = proxyServer.getScheduler()
                .buildTask(this, syncTaskInstance)
                .delay(PluginConfig.INITIAL_DELAY_SECONDS, TimeUnit.SECONDS)
                .repeat(PluginConfig.POLL_INTERVAL_SECONDS, TimeUnit.SECONDS)
                .schedule();

        transferTask = proxyServer.getScheduler()
                .buildTask(this, new TransferSyncTask(proxyServer, logger))
                .delay(PluginConfig.INITIAL_DELAY_SECONDS, TimeUnit.SECONDS)
                .repeat(PluginConfig.POLL_INTERVAL_SECONDS, TimeUnit.SECONDS)
                .schedule();

        /*
         * Velocity Scheduler usage:
         *   buildTask(plugin, runnable)
         *       .delay(initial delay)
         *       .repeat(interval)
         *       .schedule()
         *
         * We use ASYNC so the HTTP call never blocks Velocity's main event
         * loop.  The ProxyServer register/unregister methods are thread-safe.
         */
        

        logger.info("[FarlandsProxy] Polling loop started: first poll in {}s, then every {}s.",
                PluginConfig.INITIAL_DELAY_SECONDS,
                PluginConfig.POLL_INTERVAL_SECONDS);
    }

    /**
     * Fires when the proxy is shutting down (e.g. {@code /velocity shutdown} or
     * SIGTERM from Kubernetes).
     *
     * <p>Cancelling the task here ensures no poll fires mid-shutdown and no
     * thread is left dangling after the JVM exits.
     *
     * @param event the shutdown event (unused).
     */
    @Subscribe
    public void onProxyShutdown(ProxyShutdownEvent event) {
        if (syncTask != null) {
            syncTask.cancel();
        }
        if (transferTask != null) {
            transferTask.cancel();
        }
        logger.info("[FarlandsProxy] Polling loops cancelled – shutting down.");
    }
    /**
     * Fires when a player first connects and Velocity needs to pick an
     * initial backend server. We check the hostname they connected with
     * (e.g. "johns-server.farlands.app") against the routing map maintained
     * by ServerSyncTask, and route them there if a match is found.
     *
     * @param event the initial-server-selection event.
     */
    @Subscribe
    public void onChooseInitialServer(com.velocitypowered.api.event.player.PlayerChooseInitialServerEvent event) {
        if (syncTaskInstance == null) return;
        event.getPlayer().getVirtualHost().ifPresent(host -> {
            String incomingHostname = host.getHostString().toLowerCase();
            logger.info("[FarlandsProxy] Player connecting with hostname: '{}'", incomingHostname);
            String serverName = syncTaskInstance.getServerNameForHostname(incomingHostname);
            if (serverName != null) {
                proxyServer.getServer(serverName).ifPresent(event::setInitialServer);
            }
            else {
                logger.warn("[FarlandsProxy] No server mapped for hostname: '{}'", incomingHostname);
            }
        });
    }

    @Subscribe
    public void onProxyPing(ProxyPingEvent event) {
        if (syncTaskInstance == null) return;

        event.getConnection().getVirtualHost().ifPresent(address -> {
            String incomingHostname = address.getHostString().toLowerCase();
            
            // Map the hostname to the backend server name
            String serverName = syncTaskInstance.getServerNameForHostname(incomingHostname);
            
            if (serverName != null) {
                // Find the registered server in Velocity
                proxyServer.getServer(serverName).ifPresent(registeredServer -> {
                    try {
                        // Ping the backend server directly and overwrite the proxy's default ping
                        ServerPing backendPing = registeredServer.ping().join();
                        event.setPing(backendPing);
                    } catch (Exception e) {
                        logger.debug("[FarlandsProxy] Could not fetch ping for backend server: {}", serverName);
                    }
                });
            }
        });
    }
}
