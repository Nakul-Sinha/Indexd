package com.farlands.proxy;

import java.util.List;

/**
 * Top-level wrapper that mirrors the full JSON response body returned by
 * {@code GET /api/servers/internal}.
 *
 * <pre>
 * {
 *   "success": true,
 *   "data": [ { "name": "survival-1", ... }, ... ]
 * }
 * </pre>
 *
 * <p>Gson populates both fields reflectively.  We only use {@code data} for
 * actual routing decisions; {@code success} is checked as a fast-fail guard
 * before attempting to iterate the list.
 */
public final class ApiResponse {

    /**
     * Backend-side success flag.  If {@code false} the backend itself
     * encountered an error and the {@code data} list should be treated as
     * unreliable – the sync task will skip the cycle and retain the existing
     * routing table.
     */
    public boolean success;

    /**
     * List of currently active backend servers.  May be empty (no running
     * servers), but must not be {@code null} after a successful parse.
     */
    public List<ServerEntry> data;
}
