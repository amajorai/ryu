package com.ryu.sdk;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class RyuClientTest {
    private HttpServer server;
    private URI baseUri;

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        baseUri = URI.create("http://127.0.0.1:" + server.getAddress().getPort());
        server.createContext("/api/agents", this::agents);
        server.createContext("/api/chat/stream", this::stream);
        server.createContext("/api/failure", this::failure);
        server.start();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    @Test
    void listsAgents() {
        try (RyuClient client = new RyuClient(baseUri, "node-token")) {
            assertEquals(
                    List.of(new RyuClient.AgentSummary("pi", "Pi", "A coding agent", "gemma4")),
                    client.listAgents());
        }
    }

    @Test
    void streamsTextDeltasAndDone() {
        List<RyuClient.StreamChunk> chunks = new ArrayList<>();
        try (RyuClient client = new RyuClient(baseUri)) {
            client.stream("pi", List.of(RyuClient.Message.user("hello")), chunks::add);
        }
        assertEquals(
                List.of(
                        RyuClient.StreamChunk.text("Hello "),
                        RyuClient.StreamChunk.text("world"),
                        RyuClient.StreamChunk.done()),
                chunks);
    }

    @Test
    void exposesHttpFailures() {
        try (RyuClient client = new RyuClient(baseUri)) {
            RyuException error = assertThrows(
                    RyuException.class,
                    () -> client.getAgent("failure"));
            assertEquals(418, error.status());
        }
    }

    private void agents(HttpExchange exchange) throws IOException {
        if (exchange.getRequestURI().getPath().equals("/api/agents/failure")) {
            respond(exchange, 418, "no tea");
            return;
        }
        if (exchange.getRequestMethod().equals("GET")) {
            respond(exchange, 200, "{\"agents\":[{\"id\":\"pi\",\"name\":\"Pi\",\"description\":\"A coding agent\",\"model\":\"gemma4\"}]}");
            return;
        }
        respond(exchange, 405, "method not allowed");
    }

    private void stream(HttpExchange exchange) throws IOException {
        exchange.getRequestBody().readAllBytes();
        byte[] body = "data: {\"type\":\"text-delta\",\"delta\":\"Hello \"}\n\ndata: {\"type\":\"text-delta\",\"delta\":\"world\"}\n\ndata: [DONE]\n\n".getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
        exchange.sendResponseHeaders(200, body.length);
        exchange.getResponseBody().write(body);
        exchange.close();
    }

    private void failure(HttpExchange exchange) throws IOException {
        respond(exchange, 418, "no tea");
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }
}
