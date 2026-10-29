# Ryu Node Protocol v0

RNP v0 is Ryu's application-level continuity contract. It lets a trusted client move a bounded, reviewed conversation snapshot from one configured Core node to another, then continue with a fresh node-local execution session.

RNP is not a transport. It runs over the existing authenticated Core API. It does not replace RHP for physical devices, ACP for agent sessions, MCP for tools, model-provider APIs, or cloud conversation sync.

## Wire bundle

The canonical TypeScript shape and limits live in [`src/continuity.ts`](./src/continuity.ts). A v0 bundle has:

```json
{
  "protocol": "ryu-node-continuity",
  "version": 0,
  "bundleId": "uuid",
  "createdAt": 1800000000000,
  "source": {
    "conversationId": "conversation-id",
    "updatedAt": 1799999999000,
    "checkpointMessageId": "last-included-message"
  },
  "selection": {
    "transcript": { "mode": "recent", "maxMessages": 50 },
    "omittedEarlierMessages": false
  },
  "messages": [],
  "context": { "version": 0, "items": [] }
}
```

Only visible user and assistant text is portable in v0. Credentials, ACLs, ownership, filesystem paths, attachments, structured tool state, provider provenance, run state, and ACP session IDs are forbidden by omission from the type.

## HTTP flow

1. `POST /api/rnp/v0/conversations/:id/export` on the source node.
2. The client validates and displays the exact returned bundle for review.
3. `POST /api/rnp/v0/conversations/:id/resume` sends that same frozen bundle to the destination node.
4. After success, the client binds the chat tab to the destination and opens the returned conversation ID.

Each request uses only that node's configured credential. Core never calls a user-supplied node URL.

## Working-tree handoff

A separate, capability-probed contract carries a reviewed git working tree. Probe the destination with `GET /api/rnp/v0/capabilities` (a `404` means unsupported). `parseRnpWorkspaceInspection`, `parseRnpWorkspaceManifest`, `parseRnpWorkspaceResumeResult` and `parseRnpCapabilities` validate the replies; `isSafeRepoRelativePath` and `isCredentialFreeRemoteUrl` are the shared path and remote rules, and `RNP_WORKSPACE_LIMITS` holds the caps. Blobs move as content-addressed `application/octet-stream` bodies under `/api/rnp/v0/workspace-blobs/:sha256`. Unlike the transcript flow, a working-tree resume makes the destination contact the manifest's credential-free git remote after an SSRF check.

Export requires read access. Resume creates a private caller-owned row or requires write access to an existing row. Stable conversation, message, bundle, and context IDs make retries of the reviewed bundle idempotent and let later cloud sync converge. A reused message ID with different content fails with `409`.

## Handoff links

`ryu://handoff/<conversation-id>?source=<node-url>&v=0` carries routing metadata only. The source URL must be credential-free HTTPS, or HTTP loopback for a local Core, with no query or fragment. A receiver must reject every extra query field, match the URL to an already configured node, export a preview, and ask the user before resuming that exact bundle.

## Limits

- 2 MiB encoded bundle
- 200 messages
- 64 KiB per message
- 1.5 MiB total transcript text
- 16 context items
- 32 KiB per context item
- 256 KiB total context text

Implementations measure UTF-8 bytes and reject oversized data rather than silently truncating it.
