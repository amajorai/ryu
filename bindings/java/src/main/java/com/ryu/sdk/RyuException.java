package com.ryu.sdk;

/** An error returned by the Ryu client or by a Ryu Core node. */
public final class RyuException extends RuntimeException {
    private final String path;
    private final int status;

    RyuException(String message) {
        this(message, null, 0);
    }

    RyuException(String path, int status, String body) {
        this(formatMessage(path, status, body), path, status);
    }

    private RyuException(String message, String path, int status) {
        super(message);
        this.path = path;
        this.status = status;
    }

    /** The API path that failed, or {@code null} for a client-side failure. */
    public String path() {
        return path;
    }

    /** The HTTP status, or {@code 0} for a client-side failure. */
    public int status() {
        return status;
    }

    private static String formatMessage(String path, int status, String body) {
        String detail = body == null || body.isBlank() ? "" : ": " + body;
        return "Ryu request " + path + " failed (" + status + ")" + detail;
    }
}
