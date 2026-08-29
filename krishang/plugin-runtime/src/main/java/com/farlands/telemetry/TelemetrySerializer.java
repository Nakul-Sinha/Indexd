package com.farlands.telemetry;

import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.List;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;

/**
 * Events to the NDJSON lines that POST /internal/telemetry/:serverId accepts.
 *
 * The object is assembled field by field rather than reflected off the record.
 * Ingest compiles its validator from the contract and refuses any line carrying
 * a property the contract does not define, so a field added to WorldEvent for
 * the emitter's own use would, under reflection, silently start failing every
 * batch. Here it cannot reach the wire unless somebody writes the line that
 * puts it there.
 *
 * It also means there is exactly one place to look to confirm that no chat text
 * is ever serialized: this file has no branch that could write one.
 */
public final class TelemetrySerializer {

    /**
     * The contract types ts as an ISO-8601 date-time and ingest enforces the
     * format, so the fraction is fixed at three digits rather than left to
     * ISO_INSTANT, which drops it when the millisecond happens to be zero.
     */
    private static final DateTimeFormatter TIMESTAMP =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    /**
     * serializeNulls is load bearing. player_name, region and subject are
     * required properties whose type is a union with null, so an omitted null
     * is a missing field and ingest rejects the whole line.
     *
     * HTML escaping is off because it changes the bytes without changing the
     * decoded string. Downstream is a JSON parser, so escaping "<" buys nothing
     * there, and it would make an emitted line differ from the recorded fixture
     * for a player whose name contains one.
     */
    private final Gson gson = new GsonBuilder().serializeNulls().disableHtmlEscaping().create();

    /** One event as a single JSON object, without a trailing newline. */
    public String toLine(WorldEvent event) {
        JsonObject object = new JsonObject();
        object.addProperty("kind", event.kind().wireName());
        object.addProperty("ts", TIMESTAMP.format(event.at()));
        object.addProperty("player_name", event.playerName());
        object.addProperty("region", event.region());
        object.addProperty("subject", event.subject());
        object.addProperty("value", event.value());
        return gson.toJson(object);
    }

    /** A batch as newline-delimited JSON, newline-terminated. */
    public String toNdjson(List<WorldEvent> events) {
        StringBuilder out = new StringBuilder(events.size() * 160);
        for (WorldEvent event : events) {
            out.append(toLine(event)).append('\n');
        }
        return out.toString();
    }
}
