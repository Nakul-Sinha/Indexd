package com.farlands.proxy;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import com.velocitypowered.api.proxy.Player;
import com.velocitypowered.api.proxy.ProxyServer;
import com.velocitypowered.api.proxy.server.RegisteredServer;
import org.slf4j.Logger;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * Polls GET /internal/velocity/transfers and moves connected players
 * backend-to-backend. The TCP session to Velocity never drops.
 */
public final class TransferSyncTask implements Runnable {

    private final ProxyServer proxy;
    private final Logger logger;
    private final HttpClient httpClient;
    private final Gson gson;
    private final Set<String> seen = new HashSet<>();

    public TransferSyncTask(ProxyServer proxy, Logger logger) {
        this.proxy = proxy;
        this.logger = logger;
        this.gson = new Gson();
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(PluginConfig.HTTP_TIMEOUT_SECONDS))
                .build();
    }

    @Override
    public void run() {
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(PluginConfig.API_BASE_URL + "/internal/velocity/transfers"))
                    .timeout(Duration.ofSeconds(PluginConfig.HTTP_TIMEOUT_SECONDS))
                    .header("X-Internal-Key", PluginConfig.API_SECRET)
                    .header("Accept", "application/json")
                    .GET()
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                return;
            }
            List<TransferInstruction> transfers = gson.fromJson(
                    response.body(),
                    new TypeToken<List<TransferInstruction>>(){}.getType()
            );
            if (transfers == null) return;
            for (TransferInstruction transfer : transfers) {
                if (transfer.transferId == null || !seen.add(transfer.transferId)) continue;
                execute(transfer);
            }
        } catch (Exception ex) {
            logger.debug("[FarlandsProxy] transfer poll failed: {}", ex.getMessage());
        }
    }

    private void execute(TransferInstruction transfer) {
        Optional<RegisteredServer> target = proxy.getServer(transfer.toRoute);
        if (target.isEmpty()) {
            ack(transfer.transferId, List.of(), List.of(
                    failure("all", "target route not registered: " + transfer.toRoute)
            ));
            return;
        }
        List<String> moved = new ArrayList<>();
        List<AckFailure> failures = new ArrayList<>();
        for (Player player : proxy.getAllPlayers()) {
            try {
                player.createConnectionRequest(target.get()).connect().join();
                moved.add(player.getUsername());
            } catch (Exception ex) {
                failures.add(failure(player.getUsername(), String.valueOf(ex.getMessage())));
            }
        }
        ack(transfer.transferId, moved, failures);
    }

    private void ack(String id, List<String> moved, List<AckFailure> failures) {
        try {
            String body = gson.toJson(new AckBody(moved, failures));
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(PluginConfig.API_BASE_URL + "/internal/velocity/transfers/" + id + "/ack"))
                    .timeout(Duration.ofSeconds(PluginConfig.HTTP_TIMEOUT_SECONDS))
                    .header("X-Internal-Key", PluginConfig.API_SECRET)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();
            httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (Exception ex) {
            logger.warn("[FarlandsProxy] transfer ack failed for {}: {}", id, ex.getMessage());
        }
    }

    private static AckFailure failure(String player, String reason) {
        AckFailure f = new AckFailure();
        f.player = player;
        f.reason = reason;
        return f;
    }

    static final class AckBody {
        final List<String> movedPlayers;
        final List<AckFailure> failures;
        AckBody(List<String> movedPlayers, List<AckFailure> failures) {
            this.movedPlayers = movedPlayers;
            this.failures = failures;
        }
    }

    static final class AckFailure {
        String player;
        String reason;
    }
}
