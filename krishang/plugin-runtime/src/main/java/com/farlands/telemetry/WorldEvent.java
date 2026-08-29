package com.farlands.telemetry;

import java.time.Instant;

/**
 * One event, in the exact shape the WorldEvent contract type describes.
 *
 * The factories are the only way to build one, and each names a kind, so the
 * combinations the contract does not describe cannot be expressed: there is no
 * way to make a chat event with a region, or a join event with a subject.
 *
 * Note what chatVolume() does not take. It has no parameter for the message,
 * which is the "volume, never content" rule written as a method signature
 * rather than as a comment somebody has to remember to obey. Player-authored
 * text is the injection surface for everything downstream that reads telemetry,
 * and the least dangerous way to handle it is for the emitter to never hold it.
 *
 * Every string is capped at the contract's maxLength here rather than at the
 * serializer, because an over-long value is rejected by ingest as a whole line,
 * and losing a real event to a name nobody expected is worse than truncating.
 */
public record WorldEvent(
        WorldEventKind kind,
        Instant at,
        String playerName,
        String region,
        String subject,
        long value) {

    /** Contract caps: player_name and subject 64, region 32. */
    private static final int PLAYER_NAME_MAX = 64;
    private static final int REGION_MAX = 32;
    private static final int SUBJECT_MAX = 64;

    public WorldEvent {
        playerName = cap(playerName, PLAYER_NAME_MAX);
        region = cap(region, REGION_MAX);
        subject = cap(subject, SUBJECT_MAX);
        // The contract types value as a number with minimum 0. A negative
        // duration means a clock moved backwards, which is not worth losing the
        // rest of the batch over.
        value = Math.max(0L, value);
    }

    public static WorldEvent join(Instant at, String playerName) {
        return new WorldEvent(WorldEventKind.JOIN, at, playerName, null, null, 1L);
    }

    public static WorldEvent leave(Instant at, String playerName) {
        return new WorldEvent(WorldEventKind.LEAVE, at, playerName, null, null, 1L);
    }

    public static WorldEvent death(Instant at, String playerName, String region, String subject) {
        return new WorldEvent(WorldEventKind.DEATH, at, playerName, region, subject, 1L);
    }

    public static WorldEvent blockPlaced(Instant at, String playerName, String region, String subject) {
        return new WorldEvent(WorldEventKind.BLOCK_PLACED, at, playerName, region, subject, 1L);
    }

    public static WorldEvent blockBroken(Instant at, String playerName, String region, String subject) {
        return new WorldEvent(WorldEventKind.BLOCK_BROKEN, at, playerName, region, subject, 1L);
    }

    public static WorldEvent timeInRegion(Instant at, String playerName, String region, long seconds) {
        return new WorldEvent(WorldEventKind.TIME_IN_REGION, at, playerName, region, null, seconds);
    }

    /**
     * A count of messages sent by one player in one flush window.
     *
     * No message body reaches this method because none is asked for.
     */
    public static WorldEvent chatVolume(Instant at, String playerName, long messages) {
        return new WorldEvent(WorldEventKind.CHAT_VOLUME, at, playerName, null, null, messages);
    }

    private static String cap(String value, int max) {
        if (value == null || value.length() <= max) {
            return value;
        }
        return value.substring(0, max);
    }
}
