package com.farlands.proxy;

import com.google.gson.Gson;
import com.velocitypowered.api.proxy.ProxyServer;
import com.velocitypowered.api.proxy.server.RegisteredServer;
import com.velocitypowered.api.proxy.server.ServerInfo;
import org.slf4j.Logger;

import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

public final class ServerSyncTask implements Runnable {

    private final ProxyServer proxy;
    private final Logger logger;
    private final HttpClient httpClient;
    private final Gson gson;
    private final HttpRequest request;
    private final Set<String> managedServers = new HashSet<>();
    private final Map<String, String> hostnameToServer = new java.util.concurrent.ConcurrentHashMap<>();

    public String getServerNameForHostname(String hostname) {
    if (hostname == null) return null;
    String prefix = hostname.toLowerCase().split("\\.")[0];
    
    logger.info("[FarlandsProxy] --- ROUTING DEBUG ---");
    logger.info("[FarlandsProxy] Incoming raw host: {}", hostname);
    logger.info("[FarlandsProxy] Extracted prefix: {}", prefix);
    logger.info("[FarlandsProxy] Active Map Contents: {}", hostnameToServer);
    
    String mappedServer = hostnameToServer.get(prefix);
    logger.info("[FarlandsProxy] Map returned: {}", mappedServer);
    logger.info("[FarlandsProxy] ---------------------");
    
    return mappedServer;
}

    public ServerSyncTask(ProxyServer proxy, Logger logger) {
        this.proxy = proxy;
        this.logger = logger;
        this.gson = new Gson();

        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(PluginConfig.HTTP_TIMEOUT_SECONDS))
                .build();

        String endpoint = PluginConfig.API_BASE_URL
                + "/api/servers/internal?game=minecraft&status=running";

        this.request = HttpRequest.newBuilder()
                .uri(URI.create(endpoint))
                .timeout(Duration.ofSeconds(PluginConfig.HTTP_TIMEOUT_SECONDS))
                .header("X-Internal-Key", PluginConfig.API_SECRET)
                .header("Accept", "application/json")
                .GET()
                .build();
    }

    @Override
    public void run() {
        List<ServerEntry> backendServers;

        try {
            backendServers = fetchServersFromApi();
        } catch (Exception ex) {
            logger.warn("[FarlandsProxy] Sync failed – retaining existing routing table. Reason: {}", ex.getMessage());
            logger.debug("[FarlandsProxy] Full stack trace:", ex);
            return;
        }

        if (backendServers == null) {
            logger.warn("[FarlandsProxy] Backend returned success=false – skipping sync cycle.");
            return;
        }

        applyDiff(backendServers);
    }

    private List<ServerEntry> fetchServersFromApi() throws Exception {
        HttpResponse<String> response = httpClient.send(
                request,
                HttpResponse.BodyHandlers.ofString()
        );

        int statusCode = response.statusCode();
        if (statusCode < 200 || statusCode >= 300) {
            throw new RuntimeException("HTTP " + statusCode + " from backend API");
        }

        ApiResponse apiResponse = gson.fromJson(response.body(), ApiResponse.class);

        if (!apiResponse.success) {
            return null;
        }

        if (apiResponse.data == null) {
            return List.of();
        }

        return apiResponse.data;
    }

    /**
     * Parses the host from proxyTarget, handling both "host:port" and plain
     * "host" formats. If proxyTarget is stored as "host:port" (e.g. from seed
     * data like "minecraft-smp-local:25565"), we extract just the host part to
     * avoid embedding ":25565" inside the hostname of InetSocketAddress.
     */
    private String extractHost(String proxyTarget) {
        if (proxyTarget == null) return null;
        int colon = proxyTarget.lastIndexOf(':');
        if (colon == -1) return proxyTarget;
        // Check if the part after the colon is a valid port number
        String maybePort = proxyTarget.substring(colon + 1);
        try {
            Integer.parseInt(maybePort);
            return proxyTarget.substring(0, colon);
        } catch (NumberFormatException e) {
            // Not a port, return as-is (e.g. IPv6 or plain hostname)
            return proxyTarget;
        }
    }

    private void applyDiff(List<ServerEntry> backendServers) {

        // ---- 1. Deduplicate by name ----------------------------------------
        Map<String, ServerEntry> deduped = new LinkedHashMap<>();
        for (ServerEntry entry : backendServers) {
            if (deduped.containsKey(entry.name)) {
                logger.warn(
                    "[FarlandsProxy] Duplicate server name '{}' in API response – " +
                    "ignoring second occurrence to prevent routing collision.", entry.name);
            } else {
                deduped.put(entry.name, entry);
            }
        }

        Collection<ServerEntry> uniqueEntries = deduped.values();
        Set<String> backendNames = deduped.keySet();

        // ---- 2. Register new / handle address changes ----------------------
        for (ServerEntry entry : uniqueEntries) {

            // Fix: skip servers with null proxyTarget instead of crashing
            if (entry.proxyTarget == null) {
                logger.warn("[FarlandsProxy] Skipping '{}': proxyTarget is null", entry.name);
                continue;
            }

            String host = extractHost(entry.proxyTarget);
            Optional<RegisteredServer> existing = proxy.getServer(entry.name);

            if (existing.isPresent()) {
                InetSocketAddress currentAddr =
                        existing.get().getServerInfo().getAddress();
                InetSocketAddress incomingAddr =
                        new InetSocketAddress(host, entry.port);

                boolean hostChanged =
                        !currentAddr.getHostString().equals(incomingAddr.getHostString());
                boolean portChanged =
                        currentAddr.getPort() != incomingAddr.getPort();

                if (hostChanged || portChanged) {
                    logger.info(
                        "[FarlandsProxy] Address change detected for '{}': " +
                        "{}:{} → {}:{} – re-registering.",
                        entry.name,
                        currentAddr.getHostString(), currentAddr.getPort(),
                        incomingAddr.getHostString(), incomingAddr.getPort());

                    ServerInfo oldInfo = existing.get().getServerInfo();
                    try {
                        proxy.unregisterServer(oldInfo);
                        try {
                            proxy.registerServer(new ServerInfo(entry.name, incomingAddr));
                            logger.info("[FarlandsProxy] Re-registered '{}' with updated address.", entry.name);
                        } catch (Exception registerEx) {
                            try {
                                proxy.registerServer(oldInfo);
                            } catch (Exception rollbackEx) {
                                logger.error("[FarlandsProxy] CRITICAL: Could not restore '{}' after failed address update – server removed from routing.", entry.name);
                            }
                            logger.warn("[FarlandsProxy] Failed to re-register '{}' with new address: {}", entry.name, registerEx.getMessage());
                        }
                    } catch (Exception ex) {
                        logger.warn("[FarlandsProxy] Failed to unregister '{}' before address change: {}", entry.name, ex.getMessage());
                    }
                }
                if (entry.hostname != null) {
                    String prefix = entry.hostname.toLowerCase().split("\\.")[0];
                    hostnameToServer.put(prefix, entry.name);
                } else {
                    logger.warn("[FarlandsProxy] API WARNING: The hostname for server '{}' was NULL during sync!", entry.name);
                }

            } else {
                try {
                    InetSocketAddress address = new InetSocketAddress(host, entry.port);
                    ServerInfo serverInfo = new ServerInfo(entry.name, address);
                    proxy.registerServer(serverInfo);
                    managedServers.add(entry.name);
                    logger.info("[FarlandsProxy] Registered server: {}", entry);
                    logger.info("[FarlandsProxy] Hostname of server: {}", entry.hostname);
                    if (entry.hostname != null) {
                        String prefix = entry.hostname.toLowerCase().split("\\.")[0];
                        hostnameToServer.put(prefix, entry.name);
                    }
                } catch (Exception ex) {
                    logger.warn("[FarlandsProxy] Failed to register server '{}': {}",
                            entry.name, ex.getMessage());
                }
            }
        }

        // ---- 3. Unregister stale managed servers ---------------------------
        Set<String> staleManaged = new HashSet<>(managedServers);
        staleManaged.removeAll(backendNames);

        for (String staleName : staleManaged) {
            proxy.getServer(staleName).ifPresent(registered -> {
                try {
                    proxy.unregisterServer(registered.getServerInfo());
                    managedServers.remove(staleName);
                    hostnameToServer.values().remove(staleName);
                    logger.info("[FarlandsProxy] Unregistered stale server: {}", staleName);
                } catch (Exception ex) {
                    logger.warn("[FarlandsProxy] Failed to unregister server '{}': {}",
                            staleName, ex.getMessage());
                }
            });
        }

        if (staleManaged.isEmpty()) {
            logger.debug(
                "[FarlandsProxy] Sync complete – {} managed server(s), {} total in proxy.",
                managedServers.size(), proxy.getAllServers().size());
        }
    }
}
