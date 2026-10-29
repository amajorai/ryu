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
Core keeps a saved reply running after its stream closes, so **Stop** also calls
`/api/chat/cancel` for the conversation (`cancelCoreChatTurn`). A host that drives
`RyuAssistantChat` with its own Core transport should do the same in `onStop`.

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

`RyuAssistantWidget` is the reusable browser-local / Ryu guest / local-node surface used by
the public sites. It includes the Island-style launcher morph, the shared chat surface, runtime
selection, browser-model preparation, and the direct non-persistent Core connection path:

```tsx
import { RyuAssistantWidget } from "@ryu/assistant-widget";

<RyuAssistantWidget docsBaseUrl="https://docs.ryuhq.com" />;
```

Only the launcher, the selection announcement and the WebMCP page-tool listing load with the
page. The chat surface, runtimes and settings are a separate chunk that loads on first open and
is warmed when the launcher is hovered or focused; once opened, the session stays mounted (hidden
and inert) so closing keeps its messages. The guest status check and the page-text capture run
when Ask Ryu opens, not on page load. `inline` and `openOnMount` render the panel during server
rendering behind a Suspense boundary that streams it in.

Ryu guest chat needs no visitor API key. The widget sends guest prompts through a same-origin
`/api/assistant/guest` route, which forwards them only to the hosted Ryu Gateway with an `rgw_`
key of a Ryu-internal organization, so the platform safety floor, audit and that org's budget
apply. Hosts that use the complete widget must mount the package's
`guest-route` handlers at that path and set:

- `RYU_GUEST_CHAT_GATEWAY_URL` (https or loopback http, no `/v1`) and `RYU_GUEST_CHAT_GATEWAY_KEY`
  (`rgw_` only). Unset, `GET` reports `{ available: false }`, the widget disables the mode, and
  `POST` answers 503. There is no free-tier or direct-provider fallback.
- `RYU_GUEST_CHAT_CLIENT_IP_HEADER`, the client address header the edge in front of the site
  overwrites (for example `cf-connecting-ip`). Required in production; without it guest chat is
  refused instead of pooling all visitors into one bucket. It is only trustworthy when the site is
  reachable solely through that edge, which this package cannot enforce.
- Optionally `RYU_GUEST_CHAT_MODEL` (default `openrouter/free`) and
  `RYU_GUEST_CHAT_ALLOWED_ORIGINS` (exact origins; the default compares Origin with the site's
  public host). The Origin check only stops other sites' browsers and is not an abuse control.

Each turn carries `x-ryu-end-user: gc1.<hex32>`, a keyed hash of the visitor bucket, never the raw
address. The Gateway treats that id as the subject only for a key flagged as serving end users, and
the control plane does not emit that flag yet, so for now every guest visitor shares the key's
subject and a Gateway block on it pauses the whole guest lane. Limits are per process (10 turns per visitor and 300 per process per 10 minutes); the
Gateway org budget and the floor are the cross-instance backstops. Gateway refusals map to fixed
messages, and the stream relay re-emits only text deltas, so no Gateway message, code or category
reaches the browser. Choose Browser when prompts should stay in the tab, or Local node to use a
Core node you control.

If the host page exposes WebMCP tools to the widget's document, it also shows a **Page tools**
action. It displays each source origin, renders bounded schema arguments, requires a second review
click for non-read-only or consequential tools, and marks returned page content as untrusted. The
widget does not invent a tool implementation or auto-execute a local model response.

Hosts that manage their own chat state can add the same Page tools affordance to `RyuAssistantChat`
with its `actions` prop, `useWebMcpPageTools`, and `PageToolsPopover`. The host owns how untrusted
tool results enter its transcript.

The widget is Desktop's floating Ask Ryu surface, not a variant of it: the same glass, title row,
transcript, and minimal composer. Runtime choice lives behind the header's settings button, setup
(model download or node connection) appears in the composer card until the runtime is ready, and
page or selection context is added with opt-in composer chips that open a read-only preview.
Popups the widget portals to `<body>` (context previews, settings, Page tools) carry the same
`data-ryu-assistant-widget` marker as its root (`ASSISTANT_WIDGET_SELECTOR`), so page capture skips
them and focusing or selecting inside them never replaces the stored page selection.
`readBrowserPageSelection` likewise never returns text selected inside marked DOM, such as the
composer or transcript. Hosts that call `captureBrowserPageContext` or `isAssistantSelectionChange`
around their own assistant popups should mark those popups the same way.

Use `inline openOnMount showLauncher={false}` for an expanded page section. For a custom trigger
or a host-owned runtime, compose `RyuAssistantMorph` with `RyuAssistantChat` instead, passing
`ASSISTANT_GLASS_FILL` and `ASSISTANT_GLASS_CHROME` from `@ryu/assistant-widget/skin` as its
`bgClassName` and `chromeClassName` to keep the same glass as Desktop.

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
