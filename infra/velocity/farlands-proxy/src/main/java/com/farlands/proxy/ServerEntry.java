package com.farlands.proxy;

/**
 * Plain-data class that mirrors one element of the {@code data} array returned
 * by {@code GET /api/servers/internal}.
 *
 * <p>Gson's reflective deserialiser populates these fields directly from the
 * JSON keys, so the field names must exactly match the JSON property names
 * (they do – both use lower-case snake_case).
 */
public final class ServerEntry {

    /** Unique logical name of the backend server, e.g. {@code "survival-1"}. */
    public String name;

    /** Game type, e.g. {@code "minecraft"}. */
    public String game;

    /**
     * Current lifecycle status reported by the backend, e.g. {@code "running"}.
     * Only servers with {@code "running"} are expected to be returned by the
     * filtered endpoint, but we keep the field for defensive logging.
     */
    public String status;

    /**
     * Optional Kubernetes node hostname.  Used for display / debugging only;
     * the proxy connects via {@code ip} and {@code port}.
     */
    public String hostname;
    
    /**
     * Public routing hostname for this server, e.g. "johns-server.farlands.app".
     * Used by the proxy to route players who connect via that subdomain.
     */
    public String routingHostname;

    /**
     * IPv4 address (or resolvable hostname) of the backend Paper server.
     * This is the address Velocity will open a TCP connection to.
     */
    public String ip;

    /**
     * TCP port the Paper server is listening on.
     * Combined with {@code ip} to form the {@link java.net.InetSocketAddress}.
     */
    public int port;
    public String proxyTarget;

    @Override
    public String toString() {
        return name + "@" + proxyTarget + ":" + port;
    }
}
