package com.farlands.telemetry;

import java.util.Locale;

/**
 * The whole event vocabulary, and it is closed.
 *
 * Seven kinds exist because widening the set means shipping a new plugin JAR
 * and a matching change to packages/contracts/src/telemetry.ts. That expense is
 * the point: ingest compiles its validator from the contract, so a kind added
 * here alone is rejected on arrival rather than quietly changing a rollup.
 *
 * There is no kind for chat content. Chat is counted, never carried.
 */
public enum WorldEventKind {
    JOIN,
    LEAVE,
    DEATH,
    BLOCK_PLACED,
    BLOCK_BROKEN,
    TIME_IN_REGION,
    CHAT_VOLUME;

    /**
     * The literal the contract expects on the wire.
     *
     * Derived rather than declared, because a second copy of each name is a
     * second thing to keep in step with the contract, and the constant names
     * already lowercase to exactly the seven strings in WORLD_EVENT_KINDS.
     */
    public String wireName() {
        return name().toLowerCase(Locale.ROOT);
    }
}
