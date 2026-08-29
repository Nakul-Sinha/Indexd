package com.farlands.telemetry;

/**
 * Where a serialized batch goes.
 *
 * An interface with one implementation, because the failure behaviour is the
 * part of this component most worth testing and a real socket is the worst way
 * to test it. A test substitutes a sender that always throws and asserts that
 * the game side notices nothing.
 *
 * send() is declared to throw, deliberately. The caller swallows, and putting
 * the swallow in one place is what makes "fail silently" checkable rather than
 * a habit each implementation has to remember.
 */
public interface BatchSender extends AutoCloseable {

    /** Deliver one NDJSON batch, or throw. Never called on the main thread. */
    void send(String ndjson) throws Exception;

    @Override
    default void close() {
        // Most senders hold nothing.
    }
}
