# @ryu/assistant-widget

Reusable Ryu assistant surfaces for React applications and hosted iframe embeds.
The package owns the quiet floating/docked chrome, compact composer layout, recent-chat
handoff, and the single-surface launcher morph. Your host still owns the chat transport,
authentication, and conversation policy.

## Core-backed surface

For the common case, point the ready-made surface at a running Core node:

```tsx
import { RyuAssistantCoreChat } from "@ryu/assistant-widget";

<RyuAssistantCoreChat
	agentId="ryu"
	target={{ token: nodeToken, url: "http://127.0.0.1:7980" }}
	placement="floating"
/>;
```

This owns the AI SDK chat loop and uses Core's `/api/chat/stream` endpoint. Keep the token in
memory or an explicitly protected application session; never put it in a public iframe URL.

## React primitive

```tsx
import { RyuAssistantChat } from "@ryu/assistant-widget";

<RyuAssistantChat
	messages={messages}
	onSend={({ content }) => sendMessage({ text: content })}
	onStop={stop}
	placement="floating"
	status={status}
/>;
```

Use `placement="docked"` for a full-height panel or `placement="inline"` inside an
existing layout. Floating surfaces default to the compact, minimal composer. Pass
`recentChats` and `onSelectRecentChat` to get the same four-row handoff used by Desktop.

For lower-level composition, use `RyuAssistantWidgetFrame`,
`RyuAssistantWidgetHeader`, `RyuAssistantRecentChats`, and
`RyuAssistantComposer` separately. `RyuAssistantChat` uses `RyuAssistantComposer` by default for
floating surfaces, so hosts can reuse the same composer without rebuilding its controls.

## Complete public-site assistant

`RyuAssistantWidget` is the reusable browser-local / local-node surface used by the public
sites. It includes the Island-style launcher morph, the shared chat surface, the Browser/Local
node switcher, browser-model preparation, and the direct non-persistent Core connection path:

```tsx
import { RyuAssistantWidget } from "@ryu/assistant-widget";

<RyuAssistantWidget docsBaseUrl="https://docs.ryuhq.com" />;
```

If the host page registers same-origin WebMCP tools, the widget also exposes a **Page tools**
action. It renders bounded arguments from the registered schemas, requires a second review click
for write tools, and marks returned page content as untrusted. The widget does not invent a tool
implementation or auto-execute a local model response.

Use `inline openOnMount showLauncher={false}` for an expanded page section. For a custom trigger
or a host-owned runtime, compose `RyuAssistantMorph` with `RyuAssistantChat` instead.

## Hosted iframe

```tsx
import { RyuAssistantWidgetIframe } from "@ryu/assistant-widget";

<RyuAssistantWidgetIframe
	height={620}
	src="https://your-domain.example/assistant/embed"
	title="Ryu assistant"
/>;
```

The iframe wrapper keeps the hosted surface sandboxed and uses a strict referrer policy.
Keep the hosted page responsible for its own authentication and transport; never put a
Ryu Core token in a public embed URL.

`RyuAssistantWidget` remains the complete browser-local / local-node documentation assistant
used by the public sites. It includes the Island-style launcher morph, the shared chat surface,
browser-local model preparation, and the explicit local-node connection path. Use
`inline openOnMount showLauncher={false}` for an expanded page section. `RyuAssistantCoreChat` is
the direct Core-backed path, while `RyuAssistantChat` is the lower-level state/transport-injected
path. The latter two reuse the same surface primitives without copying the Desktop layout.
