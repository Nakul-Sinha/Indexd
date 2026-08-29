package com.farlands.proxy;

/**
 * Immutable configuration for the Farlands proxy plugin.
 *
 * <p>All tunables live here so operators can change them in one place without
 * touching polling or registration logic.  In a future iteration these values
 * could be read from a TOML/YAML file placed next to the proxy jar; for now
 * they are compile-time constants that are easy to override via environment
 * variables at startup (see the static initialiser below).
 */
public final class PluginConfig {

    // -----------------------------------------------------------------------
    // Backend API
    // -----------------------------------------------------------------------

    /**
     * Base URL of the Farlands backend.  Must NOT end with a trailing slash.
     *
     * <p>Override at runtime by setting the environment variable
     * {@code FARLANDS_API_BASE_URL} before starting the proxy.
     */
    public static final String API_BASE_URL;

    /**
     * Shared secret sent in the {@code X-Internal-Key} request header.
     * The backend validates this to ensure the caller is the proxy.
     *
     * <p>Override at runtime by setting the environment variable
     * {@code FARLANDS_API_SECRET} before starting the proxy.
     */
    public static final String API_SECRET;

    // -----------------------------------------------------------------------
    // Polling
    // -----------------------------------------------------------------------

    /** How often (in seconds) the sync task polls the backend. */
    public static final long POLL_INTERVAL_SECONDS = 30;

    /**
     * Initial delay (in seconds) before the first poll fires.
     * Giving the proxy a few seconds to finish initialisation avoids a
     * thundering-herd issue when both the proxy and the backend start together.
     */
    public static final long INITIAL_DELAY_SECONDS = 5;

    // -----------------------------------------------------------------------
    // HTTP client
    // -----------------------------------------------------------------------

    /** Wall-clock timeout for each individual HTTP request, in seconds. */
    public static final long HTTP_TIMEOUT_SECONDS = 10;

    // -----------------------------------------------------------------------
    // Initialiser – reads from env vars with sensible local-dev defaults
    // -----------------------------------------------------------------------

    static {
        String baseUrl = System.getenv("FARLANDS_API_BASE_URL");
        // stripTrailing() removes whitespace; replaceAll strips any trailing slashes
        // so the URL matches the Javadoc contract: "Must NOT end with a trailing slash."
        API_BASE_URL = (baseUrl != null && !baseUrl.isBlank())
                ? baseUrl.stripTrailing().replaceAll("/+$", "")
                : "http://localhost:3000";

        String secret = System.getenv("FARLANDS_API_SECRET");
        API_SECRET = (secret != null && !secret.isBlank())
                ? secret
                : "change-me-in-production";
    }

    // Prevent instantiation – this is a constants-only class.
    private PluginConfig() {}
}
