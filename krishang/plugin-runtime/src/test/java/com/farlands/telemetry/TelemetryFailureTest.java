package com.farlands.telemetry;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.time.ZoneOffset;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.sun.net.httpserver.HttpServer;

/**
 * A world whose telemetry endpoint is unreachable keeps playing normally.
 *
 * That sentence from the work order is the only requirement this file tests, and
 * it decomposes into three checkable claims: nothing throws where a Bukkit event
 * handler would see it, nothing waits for the network on a thread the game
 * needs, and a failed batch is dropped rather than retried into a growing queue.
 *
 * The endpoints here are real. One is a port with nothing listening, one is a
 * server that answers 500, and one hangs, because those are the three shapes an
 * outage actually takes and a mock of any of them would be a guess about how the
 * HTTP client behaves.
 */
class TelemetryFailureTest {

    @Test
    @DisplayName("a sender that always throws produces no exception and no growth")
    void aFailingSenderIsSilent() {
        BatchSender broken = ndjson -> {
            throw new IOException("connection refused");
        };
        TelemetryService service = TelemetryServiceHarness.serviceWith(broken);

        assertDoesNotThrow(() -> {
            for (int i = 0; i < 500; i++) {
                service.recordJoin("tinbucket");
                service.recordChat("tinbucket");
                service.recordDeath("tinbucket", "spawn", "fall");
                service.recordBlockPlaced("tinbucket", "spawn", "stone");
                service.recordBlockBroken("tinbucket", "spawn", "dirt");
                service.recordLeave("tinbucket");
            }
            service.flush();
        });

        assertEquals(0, service.queue().size(), "a failed batch is dropped, not put back");
    }

    @Test
    @DisplayName("nothing escapes when the clock itself is broken")
    void aBrokenClockIsSwallowed() {
        TelemetryService service = TelemetryServiceHarness.serviceWith(
                new TelemetryServiceHarness.RecordingSender(),
                TelemetryServiceHarness.config(100, 10),
                new TelemetryServiceHarness.BrokenClock());

        // Stands in for any defect inside the emitter. A Bukkit event handler
        // calls these, so a throw here would cancel the player's action.
        assertDoesNotThrow(() -> {
            service.recordJoin("tinbucket");
            service.recordLeave("tinbucket");
            service.recordDeath("tinbucket", "spawn", "fall");
            service.recordBlockPlaced("tinbucket", "spawn", "stone");
            service.recordBlockBroken("tinbucket", "spawn", "dirt");
            service.recordChat("tinbucket");
            service.observeRegion("tinbucket", "spawn");
            service.flush();
            service.close();
        });
    }

    @Test
    @DisplayName("a hanging endpoint never makes a producer wait")
    void producersDoNotWaitOnTheNetwork() throws InterruptedException {
        CountDownLatch released = new CountDownLatch(1);
        CountDownLatch sending = new CountDownLatch(1);
        BatchSender hangs = ndjson -> {
            sending.countDown();
            released.await();
        };

        TelemetryService service = TelemetryServiceHarness.serviceWith(
                hangs, TelemetryServiceHarness.config(32, 8), Clock.fixed(TelemetryServiceHarness.FIXED_INSTANT, ZoneOffset.UTC));

        service.recordJoin("tinbucket");
        Thread shipper = new Thread(service::flush, "test-shipper");
        shipper.start();
        assertTrue(sending.await(5, TimeUnit.SECONDS), "the shipper reached the hanging send");

        // The game thread carries on while the shipping thread is stuck in a
        // send that will never return.
        long startedAt = System.nanoTime();
        for (int i = 0; i < 10_000; i++) {
            service.recordJoin("quietfen");
        }
        long elapsedMillis = (System.nanoTime() - startedAt) / 1_000_000L;

        assertTrue(elapsedMillis < 2_000, "producing during a hung send took " + elapsedMillis + "ms");
        assertEquals(32, service.queue().size(), "the queue held its bound while the network was stuck");

        released.countDown();
        shipper.join(5_000);
    }

    @Test
    @DisplayName("a port with nothing listening is not an error the game sees")
    void unreachableEndpointIsSilent() throws IOException {
        URI unreachable = URI.create("http://127.0.0.1:" + closedPort() + "/internal/telemetry/srv_7f2");
        HttpBatchSender sender = new HttpBatchSender(unreachable, Duration.ofSeconds(2));
        TelemetryService service = TelemetryServiceHarness.serviceWith(sender);

        service.recordJoin("tinbucket");

        assertDoesNotThrow(service::flush, "an unreachable endpoint must not throw out of flush");
        assertDoesNotThrow(service::close);
        assertEquals(0, service.queue().size(), "the batch was dropped rather than retried");
    }

    @Test
    @DisplayName("an endpoint answering 500 is not an error the game sees")
    void failingEndpointIsSilent() throws IOException {
        AtomicInteger requests = new AtomicInteger();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/internal/telemetry/srv_7f2", exchange -> {
            requests.incrementAndGet();
            exchange.sendResponseHeaders(500, 0);
            try (OutputStream body = exchange.getResponseBody()) {
                body.write("{\"error\":\"boom\"}".getBytes());
            }
        });
        server.start();

        try {
            URI target = URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/internal/telemetry/srv_7f2");
            TelemetryService service = TelemetryServiceHarness.serviceWith(
                    new HttpBatchSender(target, Duration.ofSeconds(5)));

            service.recordJoin("tinbucket");
            assertDoesNotThrow(service::flush);

            assertEquals(1, requests.get(), "the batch was attempted once and not retried");
            assertEquals(0, service.queue().size(), "and then dropped");
            assertDoesNotThrow(service::close);
        } finally {
            server.stop(0);
        }
    }

    @Test
    @DisplayName("a well formed batch reaches an endpoint that is answering")
    void healthyEndpointReceivesTheBatch() throws IOException, InterruptedException {
        AtomicReference<String> received = new AtomicReference<>("");
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/internal/telemetry/srv_7f2", exchange -> {
            received.set(new String(exchange.getRequestBody().readAllBytes()));
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        server.start();

        try {
            URI target = URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/internal/telemetry/srv_7f2");
            TelemetryService service = TelemetryServiceHarness.serviceWith(
                    new HttpBatchSender(target, Duration.ofSeconds(5)));

            service.recordJoin("tinbucket");
            service.flush();
            service.close();

            String body = received.get();
            assertTrue(body.startsWith("{\"kind\":\"join\""), "NDJSON arrived, not a wrapper object");
            assertTrue(body.endsWith("\n"), "newline terminated");
        } finally {
            server.stop(0);
        }
    }

    @Test
    @DisplayName("a non-2xx is reported to the caller that swallows it, not to the game")
    void theSenderItselfSignalsFailure() throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/internal/telemetry/srv_7f2", exchange -> {
            exchange.sendResponseHeaders(404, -1);
            exchange.close();
        });
        server.start();

        try {
            URI target = URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/internal/telemetry/srv_7f2");
            HttpBatchSender sender = new HttpBatchSender(target, Duration.ofSeconds(5));

            // The sender throws so that one place, TelemetryService, decides what
            // silence means. It is the service that must never let it out.
            assertThrows(IOException.class, () -> sender.send("{}\n"));
            sender.close();
        } finally {
            server.stop(0);
        }
    }

    /** A port that was bound and released, so nothing is listening on it. */
    private static int closedPort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }
}
