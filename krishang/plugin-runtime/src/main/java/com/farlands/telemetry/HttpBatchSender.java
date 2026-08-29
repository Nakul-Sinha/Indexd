package com.farlands.telemetry;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * Delivery over java.net.http, which is in the JDK and therefore adds nothing
 * to the JAR. Nothing here needs shading, and nothing here can collide with
 * another plugin's HTTP or JSON stack.
 *
 * The request is deliberately plain. Ingest refuses anything carrying
 * x-forwarded-for and its relatives, on the reasoning that only an edge proxy
 * writes them and this endpoint is cluster-internal; the emitter posts straight
 * at the backend Service and so sends none.
 *
 * There is no retry. A retry queue during an outage is the heap growth the
 * bounded queue exists to prevent, and a batch that failed is already stale by
 * the time a retry would land. A failed batch is a dropped batch.
 */
public final class HttpBatchSender implements BatchSender {

    private static final String CONTENT_TYPE = "application/x-ndjson";

    /** A stopping server waits this long for the client to let go, and no longer. */
    private static final Duration SHUTDOWN_WAIT = Duration.ofSeconds(1);

    private final HttpClient client;
    private final URI target;
    private final Duration requestTimeout;

    public HttpBatchSender(URI target, Duration requestTimeout) {
        this.target = target;
        this.requestTimeout = requestTimeout;
        this.client = HttpClient.newBuilder()
                .connectTimeout(requestTimeout)
                // The cluster address resolves in-namespace and a redirect to
                // anywhere else would mean telemetry left the cluster.
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    @Override
    public void send(String ndjson) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder(target)
                .timeout(requestTimeout)
                .header("content-type", CONTENT_TYPE)
                .POST(HttpRequest.BodyPublishers.ofString(ndjson, StandardCharsets.UTF_8))
                .build();

        // Synchronous on purpose. This runs on the emitter's own daemon thread,
        // so blocking it costs the game nothing, and the request timeout bounds
        // how long it can block for. The asynchronous form would buy nothing
        // except a second place for a failure to escape from.
        HttpResponse<Void> response = client.send(request, HttpResponse.BodyHandlers.discarding());

        // The body is discarded unread. It can contain schema paths for rejected
        // lines, and those lines are player-adjacent, so reading it would pull
        // untrusted text into a server log for no operational gain.
        int status = response.statusCode();
        if (status / 100 != 2) {
            throw new IOException("telemetry ingest returned " + status);
        }
    }

    @Override
    public void close() {
        // shutdownNow rather than close, because close waits for in-flight
        // requests without a bound and the request that is in flight during a
        // shutdown is the one aimed at an endpoint that stopped answering.
        try {
            client.shutdownNow();
            client.awaitTermination(SHUTDOWN_WAIT);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException ignored) {
            // Shutdown is not a moment to raise a new problem.
        }
    }

    public URI target() {
        return target;
    }
}
