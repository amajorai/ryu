package com.ryu.sdk;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.function.Consumer;

/**
 * A small blocking Java client for a running Ryu Core node.
 *
 * <p>The client talks to Core over HTTP and server-sent events. It does not
 * load a native library, does not need provider credentials, and is safe to
 * use from a regular Java 17 application.</p>
 */
public final class RyuClient implements AutoCloseable {
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(60);
    private static final ObjectMapper JSON = new ObjectMapper();

    private final URI baseUri;
    private final HttpClient http;
    private final String token;

    public RyuClient(String baseUrl) {
        this(URI.create(baseUrl), null);
    }

    public RyuClient(String baseUrl, String token) {
        this(URI.create(baseUrl), token);
    }

    public RyuClient(URI baseUri) {
        this(baseUri, null);
    }

    public RyuClient(URI baseUri, String token) {
        this.baseUri = validateBaseUri(baseUri);
        this.token = token == null || token.isBlank() ? null : token;
        this.http = HttpClient.newBuilder()
                .connectTimeout(REQUEST_TIMEOUT)
                .build();
    }

    /** A short agent description returned by Core. */
    public record AgentSummary(String id, String name, String description, String model) {}

    /** A complete agent record returned by Core. */
    public record Agent(
            String id,
            String name,
            String description,
            String model,
            List<String> tools) {
        public Agent {
            tools = List.copyOf(tools == null ? List.of() : tools);
        }
    }

    /** A message sent to an agent. */
    public record Message(String role, String content) {
        public Message {
            if (role == null || role.isBlank()) {
                throw new IllegalArgumentException("message role must not be blank");
            }
            Objects.requireNonNull(content, "message content");
        }

        public static Message system(String content) {
            return new Message("system", content);
        }

        public static Message user(String content) {
            return new Message("user", content);
        }

        public static Message assistant(String content) {
            return new Message("assistant", content);
        }
    }

    /** One streamed text, terminal, or error event. */
    public record StreamChunk(Type type, String content) {
        public enum Type { TEXT, DONE, ERROR }

        public static StreamChunk text(String content) {
            return new StreamChunk(Type.TEXT, content);
        }

        public static StreamChunk done() {
            return new StreamChunk(Type.DONE, null);
        }

        public static StreamChunk error(String content) {
            return new StreamChunk(Type.ERROR, content);
        }

        public boolean isText() {
            return type == Type.TEXT;
        }
    }

    /** A persisted Core conversation. */
    public record Conversation(
            String id,
            String agentId,
            String title,
            String createdAt,
            String updatedAt) {}

    /** A named Core document collection. */
    public record Space(String id, String name, String description, int documentCount) {}

    /** A document chunk returned by a Space search. */
    public record SpaceMatch(String chunkId, String documentId, String content, double distance) {}

    /** List the agents installed on the node. */
    public List<AgentSummary> listAgents() {
        JsonNode root = requestJson("GET", "/api/agents", null);
        List<AgentSummary> agents = new ArrayList<>();
        for (JsonNode agent : requiredArray(root, "agents", "/api/agents")) {
            agents.add(new AgentSummary(
                    requiredText(agent, "id", "/api/agents"),
                    requiredText(agent, "name", "/api/agents"),
                    nullableText(agent, "description"),
                    nullableText(agent, "model")));
        }
        return List.copyOf(agents);
    }

    /** Fetch one agent by id. */
    public Agent getAgent(String id) {
        JsonNode agent = requestJson("GET", "/api/agents/" + encode(id), null).path("agent");
        if (agent.isMissingNode() || !agent.isObject()) {
            throw new RyuException("Core returned no agent for /api/agents/" + id);
        }
        List<String> tools = new ArrayList<>();
        JsonNode toolNodes = agent.path("tools");
        if (toolNodes.isArray()) {
            for (JsonNode tool : toolNodes) {
                if (tool.isTextual()) {
                    tools.add(tool.asText());
                }
            }
        }
        return new Agent(
                requiredText(agent, "id", "/api/agents/" + id),
                requiredText(agent, "name", "/api/agents/" + id),
                nullableText(agent, "description"),
                nullableText(agent, "model"),
                tools);
    }

    /** Send a turn and return the complete assistant response. */
    public String run(String agentId, List<Message> messages) {
        StringBuilder result = new StringBuilder();
        stream(agentId, messages, chunk -> {
            if (chunk.type() == StreamChunk.Type.TEXT) {
                result.append(chunk.content());
            } else if (chunk.type() == StreamChunk.Type.ERROR) {
                throw new RyuException(chunk.content());
            }
        });
        return result.toString();
    }

    /**
     * Stream a turn from Core. The callback receives text fragments followed by
     * one {@link StreamChunk.Type#DONE} event, or one error event.
     */
    public void stream(String agentId, List<Message> messages, Consumer<StreamChunk> onChunk) {
        Objects.requireNonNull(agentId, "agentId");
        Objects.requireNonNull(messages, "messages");
        Objects.requireNonNull(onChunk, "onChunk");

        ObjectNode body = JSON.createObjectNode();
        body.put("agent_id", agentId);
        ArrayNode messageNodes = body.putArray("messages");
        for (Message message : messages) {
            ObjectNode messageNode = messageNodes.addObject();
            messageNode.put("role", message.role());
            messageNode.put("content", message.content());
        }

        HttpResponse<InputStream> response = sendStream(body);
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            try (InputStream bodyStream = response.body()) {
                throw new RyuException("/api/chat/stream", response.statusCode(),
                        new String(bodyStream.readAllBytes(), StandardCharsets.UTF_8));
            } catch (IOException error) {
                throw new RyuException("/api/chat/stream", response.statusCode(), error.getMessage());
            }
        }

        boolean terminal = false;
        try (InputStream bodyStream = response.body();
             BufferedReader reader = new BufferedReader(
                     new InputStreamReader(bodyStream, StandardCharsets.UTF_8))) {
            StringBuilder event = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    if (event.length() > 0) {
                        terminal = dispatchSse(event.toString(), onChunk);
                        event.setLength(0);
                        if (terminal) {
                            return;
                        }
                    }
                } else if (line.startsWith("data:")) {
                    if (event.length() > 0) {
                        event.append('\n');
                    }
                    event.append(line.substring(5).stripLeading());
                }
            }
            if (!terminal && event.length() > 0) {
                terminal = dispatchSse(event.toString(), onChunk);
            }
        } catch (IOException error) {
            throw new RyuException("Could not read Core chat stream: " + error.getMessage());
        }
        if (!terminal) {
            onChunk.accept(StreamChunk.done());
        }
    }

    /** List persisted conversations. */
    public List<Conversation> listConversations() {
        JsonNode root = requestJson("GET", "/api/conversations", null);
        List<Conversation> conversations = new ArrayList<>();
        for (JsonNode conversation : requiredArray(root, "conversations", "/api/conversations")) {
            conversations.add(conversation(conversation, "/api/conversations"));
        }
        return List.copyOf(conversations);
    }

    /** Fetch one persisted conversation by id. */
    public Conversation getConversation(String id) {
        return conversation(
                requestJson("GET", "/api/conversations/" + encode(id), null),
                "/api/conversations/" + id);
    }

    /** List document collections. */
    public List<Space> listSpaces() {
        JsonNode root = requestJson("GET", "/api/spaces", null);
        List<Space> spaces = new ArrayList<>();
        for (JsonNode space : requiredArray(root, "spaces", "/api/spaces")) {
            spaces.add(new Space(
                    requiredText(space, "id", "/api/spaces"),
                    requiredText(space, "name", "/api/spaces"),
                    nullableText(space, "description"),
                    space.path("document_count").asInt(0)));
        }
        return List.copyOf(spaces);
    }

    /** Search one document collection. */
    public List<SpaceMatch> searchSpace(String id, String query, int limit) {
        ObjectNode body = JSON.createObjectNode();
        body.put("query", query);
        if (limit > 0) {
            body.put("limit", limit);
        }
        JsonNode root = requestJson("POST", "/api/spaces/" + encode(id) + "/search", body);
        List<SpaceMatch> matches = new ArrayList<>();
        for (JsonNode match : requiredArray(root, "matches", "/api/spaces/" + id + "/search")) {
            matches.add(new SpaceMatch(
                    requiredText(match, "chunk_id", "/api/spaces/" + id + "/search"),
                    requiredText(match, "document_id", "/api/spaces/" + id + "/search"),
                    requiredText(match, "content", "/api/spaces/" + id + "/search"),
                    match.path("distance").asDouble()));
        }
        return List.copyOf(matches);
    }

    /** No-op close for try-with-resources ergonomics. */
    @Override
    public void close() {
        // java.net.http.HttpClient owns no closeable resource in Java 17.
    }

    private HttpResponse<InputStream> sendStream(ObjectNode body) {
        HttpRequest.Builder builder = HttpRequest.newBuilder(endpoint("/api/chat/stream"))
                .timeout(REQUEST_TIMEOUT)
                .header("Accept", "text/event-stream")
                .header("Content-Type", "application/json");
        addAuthorization(builder);
        try {
            return http.send(
                    builder.POST(HttpRequest.BodyPublishers.ofString(writeJson(body))).build(),
                    HttpResponse.BodyHandlers.ofInputStream());
        } catch (IOException error) {
            throw new RyuException("Could not connect to Ryu Core: " + error.getMessage());
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new RyuException("Ryu request interrupted");
        }
    }

    private JsonNode requestJson(String method, String path, JsonNode body) {
        HttpRequest.Builder builder = HttpRequest.newBuilder(endpoint(path))
                .timeout(REQUEST_TIMEOUT)
                .header("Accept", "application/json");
        addAuthorization(builder);
        if (body == null) {
            builder.method(method, HttpRequest.BodyPublishers.noBody());
        } else {
            builder.header("Content-Type", "application/json")
                    .method(method, HttpRequest.BodyPublishers.ofString(writeJson(body)));
        }

        HttpResponse<String> response;
        try {
            response = http.send(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (IOException error) {
            throw new RyuException("Could not connect to Ryu Core: " + error.getMessage());
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new RyuException("Ryu request interrupted");
        }
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new RyuException(path, response.statusCode(), response.body());
        }
        if (response.body().isBlank()) {
            return JSON.createObjectNode();
        }
        try {
            return JSON.readTree(response.body());
        } catch (IOException error) {
            throw new RyuException("Core returned invalid JSON for " + path + ": " + error.getMessage());
        }
    }

    private void addAuthorization(HttpRequest.Builder builder) {
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
    }

    private URI endpoint(String path) {
        String base = baseUri.toString().replaceFirst("/+$", "");
        return URI.create(base + (path.startsWith("/") ? path : "/" + path));
    }

    private static Conversation conversation(JsonNode node, String path) {
        return new Conversation(
                requiredText(node, "id", path),
                nullableText(node, "agent_id"),
                nullableText(node, "title"),
                nullableText(node, "created_at"),
                nullableText(node, "updated_at"));
    }

    private static boolean dispatchSse(String data, Consumer<StreamChunk> onChunk) {
        if (data.equals("[DONE]")) {
            onChunk.accept(StreamChunk.done());
            return true;
        }
        final JsonNode frame;
        try {
            frame = JSON.readTree(data);
        } catch (IOException ignored) {
            return false;
        }
        String type = nullableText(frame, "type");
        if (type != null && type.equals("text-delta")) {
            String delta = nullableText(frame, "delta");
            if (delta != null && !delta.isEmpty()) {
                onChunk.accept(StreamChunk.text(delta));
            }
            return false;
        }
        if (type != null && type.equals("error")) {
            String message = nullableText(frame, "errorText");
            if (message == null) {
                message = nullableText(frame, "error");
            }
            onChunk.accept(StreamChunk.error(message == null ? "Core stream error" : message));
            return true;
        }
        JsonNode choices = frame.path("choices");
        if (choices.isArray() && !choices.isEmpty()) {
            String content = nullableText(choices.get(0).path("delta"), "content");
            if (content != null && !content.isEmpty()) {
                onChunk.accept(StreamChunk.text(content));
            }
        } else {
            String content = nullableText(frame, "content");
            if (content != null && !content.isEmpty()) {
                onChunk.accept(StreamChunk.text(content));
            }
        }
        return false;
    }

    private static ArrayNode requiredArray(JsonNode node, String field, String path) {
        JsonNode value = node.path(field);
        if (!value.isArray()) {
            throw new RyuException("Core returned no " + field + " array for " + path);
        }
        return (ArrayNode) value;
    }

    private static String requiredText(JsonNode node, String field, String path) {
        String value = nullableText(node, field);
        if (value == null || value.isBlank()) {
            throw new RyuException("Core returned no " + field + " for " + path);
        }
        return value;
    }

    private static String nullableText(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value == null || value.isNull() || !value.isValueNode() ? null : value.asText();
    }

    private static String encode(String value) {
        Objects.requireNonNull(value, "path value");
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static String writeJson(JsonNode body) {
        try {
            return JSON.writeValueAsString(body);
        } catch (IOException error) {
            throw new RyuException("Could not encode request JSON: " + error.getMessage());
        }
    }

    private static URI validateBaseUri(URI uri) {
        Objects.requireNonNull(uri, "baseUri");
        if (!"http".equalsIgnoreCase(uri.getScheme()) && !"https".equalsIgnoreCase(uri.getScheme())) {
            throw new IllegalArgumentException("Ryu Core URL must use http or https");
        }
        return uri;
    }
}
