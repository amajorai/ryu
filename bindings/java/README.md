# Ryu Java library

`com.ryu:ryu-client` is the Java library for applications that need to call a
running Ryu Core node. It uses Java 17's HTTP client, so it does not load the
Rust/UniFFI binding, start a generator, or require a provider API key.

The Rust/UniFFI projects in this repository are lower-level kernel bindings for
manifest validation and Gateway-routed model calls. Most Java applications
should use this library instead.

## Install

From a checkout of the SDK hub, install the library into your local Maven
repository:

```bash
cd bindings/java
mvn install
```

Then add it to a Java 17+ application's `pom.xml`:

```xml
<dependency>
  <groupId>com.ryu</groupId>
  <artifactId>ryu-client</artifactId>
  <version>0.2.6</version>
</dependency>
```

## Use it

Point the client at Core's URL and pass the node token when the node requires
authentication:

```java
import com.ryu.sdk.RyuClient;
import java.net.URI;
import java.util.List;

try (var ryu = new RyuClient(
    URI.create("http://127.0.0.1:7980"),
    System.getenv("RYU_TOKEN"))) {
  var agents = ryu.listAgents();
  var reply = ryu.run(
      agents.get(0).id(),
      List.of(RyuClient.Message.user("Summarize today's tasks.")));
  System.out.println(reply);
}
```

For incremental output:

```java
ryu.stream(
    "pi",
    List.of(RyuClient.Message.user("Stream a short answer.")),
    chunk -> {
      if (chunk.isText()) {
        System.out.print(chunk.content());
      }
    });
```

The same client exposes `listConversations`, `getConversation`, `listSpaces`,
and `searchSpace`. Core remains the authority for agents, permissions, model
routing, and audit; the Java library is only the typed client.

## Build and test

```bash
mvn test
```

The tests use a local in-memory HTTP server. They do not call a model provider.

See the [Java library guide](https://docs.ryuhq.com/docs/extend/develop/sdk/java)
for the API and the [Core API reference](https://docs.ryuhq.com/docs/extend/develop/api-reference)
for the underlying endpoints.
