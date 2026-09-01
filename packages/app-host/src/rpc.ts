// The capability-gated RPC dispatch for the desktop extension host (#446).
//
// This is the PURE half of the host message router: given an RPC method, its
// args, the set of capabilities the host granted this plugin, and a small set of
// privileged service callbacks the trusted webview owns, it either dispatches the
// call or REJECTS it (ungranted method, unknown method). It deliberately holds no
// DOM/iframe/postMessage glue so it is unit-testable under `bun test` (which has
// no DOM, the same reason `registry.test.ts` tests pure logic).
//
// The security model (see `docs/desktop-extension-host-spec.md` §3):
//   - The plugin UI runs in a NULL-ORIGIN sandboxed iframe and reaches Core ONLY
//     by sending an RPC envelope over a MessageChannel port to the host.
//   - The host (this code, running in the TRUSTED webview) is the single place
//     that holds the Core node token and performs the privileged fetch. The
//     plugin never sees the token.
//   - Each method is gated by a declared CAPABILITY. A call to a method whose
//     capability is not in `granted` is rejected before any service runs. This is
//     the grant model enforced at the UI boundary.
//
// For the MVP the granted-capability set is HOST-PROVIDED CONFIG passed in at
// mount time. Reading it from the plugin's `manifest.json` grants is #443's job;
// here we prove the gate works given a grant set.

import type {
	Alert as MonitorAlert,
	CheckStatus as MonitorCheckStatus,
	CheckType as MonitorCheckType,
	MonitorInput as MonitorInputPayload,
	NotifyTarget as MonitorNotifyTarget,
	Monitor as MonitorRecord,
	Snapshot as MonitorSnapshot,
} from "@ryuhq/core-client/monitors";
import hostApiContract from "../../../crates/core/kernel-contracts/schemas/host-api.json" with {
	type: "json",
};
import type {
	RyuCatalogModels,
	RyuCatalogSnapshot,
	RyuNodeShareOrigin,
} from "./app-bridge.ts";

/** A request envelope a plugin sends over the bridge. `id` correlates the reply. */
export interface RpcRequest {
	args: unknown[];
	id: number;
	kind: "ryu-plugin-rpc";
	method: string;
}

/** A structured error the host relays to a widget (decisions doc D6). `code` is a
 *  closed enum so the widget can branch without string matching; `message` is a
 *  human-readable detail. The legacy plugin path still uses a plain string error,
 *  so {@link RpcResponse.error} is a union and every reader must accept both. */
export interface RpcErrorPayload {
	code: WidgetRpcErrorCode;
	message: string;
}

/** The reply envelope the host sends back. Exactly one of `result`/`error`.
 *  `error` is a plain string for the legacy plugin path and a structured
 *  {@link RpcErrorPayload} for widget round-trips (D6). */
export interface RpcResponse {
	error?: string | RpcErrorPayload;
	id: number;
	kind: "ryu-plugin-rpc-result";
	result?: unknown;
}

/** A streaming chunk the host pushes to the frame during a streaming method (e.g.
 *  `agent.run.stream`). Correlated to the originating request by `id`; the frame
 *  appends each `delta`. A terminal {@link RpcResponse} (`ryu-plugin-rpc-result`)
 *  with the same `id` ends the stream (resolve on `result`, reject on `error`). */
export interface RpcChunk {
	delta: string;
	id: number;
	kind: "ryu-plugin-rpc-chunk";
}

/** The closed set of widget RPC error codes (decisions doc D6). */
export type WidgetRpcErrorCode =
	| "denied"
	| "not_found"
	| "over_budget"
	| "server_error"
	| "invalid_args";

const WIDGET_RPC_ERROR_CODES = new Set<string>([
	"denied",
	"not_found",
	"over_budget",
	"server_error",
	"invalid_args",
] satisfies WidgetRpcErrorCode[]);

function isWidgetRpcErrorCode(value: unknown): value is WidgetRpcErrorCode {
	return typeof value === "string" && WIDGET_RPC_ERROR_CODES.has(value);
}

/** Host → widget push envelope (spec §1.2 `HostPush`). Merges the present keys of
 *  `globals` into the widget's live global store; each present key overwrites. The
 *  frame re-dispatches it as `ryu:set_globals` + `openai:set_globals`. */
export interface HostPush {
	globals: WidgetGlobalsPatch;
	kind: "ryu-widget-set-globals";
}

/** The partial global set a {@link HostPush} carries (spec §1.2/§1.3). Every key is
 *  optional; only present keys are applied. */
export interface WidgetGlobalsPatch {
	displayMode?: "inline" | "fullscreen" | "pip";
	/** The host's app-wide "Friendly names" preference (Settings → Appearance):
	 *  `true` when the shell is showing plain language ("Connected search") rather
	 *  than the technical term ("Graph"). Pushed exactly like `theme`, and for the
	 *  same reason — a widget renders inside the host's chrome, so it should not be
	 *  the one surface still speaking the developer vocabulary. A null-origin frame
	 *  cannot read the host's `localStorage`, so this push is the only way it can
	 *  know. Absent means "host did not say"; treat it as `true`, which is the
	 *  host's own default (`DEFAULT_FRIENDLY_MODE`). */
	friendly?: boolean;
	locale?: string;
	maxHeight?: number | null;
	safeArea?: { bottom: number; left: number; right: number; top: number };
	theme?: "light" | "dark";
	toolInput?: unknown;
	toolOutput?: unknown;
	toolResponseMetadata?: unknown;
	/** Apps-SDK parity globals (optional; host-pushable, applied by the bridge). */
	userAgent?: unknown;
	view?: unknown;
	widgetState?: unknown;
}

/** A capability id a method requires. Mirrors the manifest grant strings (#443).
 *
 *  The set is deliberately MINIMAL for the third-party-code slice: only what the
 *  benign example plugin needs (list agents + claim its own route). Everything
 *  else — `tool.*`, `fs.*`, `identity.*`, `gateway.*`, `spaces.*`, `commands.*` —
 *  is absent from {@link METHOD_CAPABILITY}, so it is an UNKNOWN method and is
 *  rejected by default-deny (proven by the `unknown_method_blocked` +
 *  `secret_reach_blocked` adversarial tests). */
export type Capability =
	| "host.capabilities"
	| "node.shareOrigins"
	| "native.haptics"
	| "native.notifications"
	| "native.liveActivities"
	| "core.listAgents"
	// Cross-chat broadcast (grant `chat.sendFollowUp`) — the companion receives
	// only redacted, caller-visible conversation summaries and can post an
	// explicitly confirmed message into selected existing chats.
	| "chat.broadcast"
	| "ui.render"
	| "app.http"
	| "app.realtime"
	// Widget host capabilities (Ryu Apps). `tool.call`/`ui.sendMessage` are
	// Gateway-sourced (they map from approved grants below); `widget.state` and
	// `ui.displayMode` are LOCAL host caps always granted to a mounted widget and
	// never derived from a manifest grant (decisions doc D5, spec R8).
	| "tool.call"
	| "ui.sendMessage"
	| "ui.toast"
	| "widget.state"
	| "ui.displayMode"
	// Assistant bridge (grant `assistant:context`) — the app describes ITS page to
	// the one global "Ask Ryu" surface: what the user is looking at, optionally its
	// own instructions + starter prompts while that page is open, and opening the
	// panel. Write-only in one direction: an app can steer the assistant about
	// itself, and can never read the conversation back.
	| "assistant.context"
	// App host-bridge capabilities (full-page Companion apps). Gateway-sourced from
	// the SAME grant strings the Core `PluginHookBridge` gates on (`hook:side-model`,
	// `hook:run-agent`, `storage:kv`). Each unlocks a family of `/api/plugins/:id/host`
	// methods; `storage.kv` gates all four storage methods (one grant, one cap).
	| "model.complete"
	| "agent.run"
	| "storage.kv"
	| "crypto.seal"
	// Spaces documents (grant `spaces:docs`) — an app owns Space documents of kind
	// `app:<plugin_id>`: persisted, search-embedded, backlinked, versioned,
	// Space-routed. This is the integration that lets a feature (e.g. whiteboard) be
	// ported to an app WITHOUT losing its Spaces membership.
	| "spaces.docs"
	// Media generation (grant `media:generate`) — image / video / speech synthesis.
	// Each runs a Core media data-path call (`/api/images/generate`,
	// `/api/video/generate`, `/api/voice/speak`) which routes through the Gateway.
	// The host performs the privileged fetch (holds the node token) and converts any
	// remote-URL result to a `data:` URL before returning, so the CSP-locked frame
	// (img/media-src data: blob: only) can render it. This is the integration that
	// lets a generation app (e.g. the canvas) reach media engines from the sandbox.
	| "media.generate"
	// Speech-to-text (grant `media:transcribe`) — the frame hands the host an audio
	// `data:` URL; the host posts it to `/api/voice/transcribe` and returns the text.
	// Split from `media.generate` so a transcribe-only app need not also unlock
	// generation (least privilege).
	| "media.transcribe"
	// Fine-tune runs (grant `finetune:runs`) — the `@ryu/finetune` app drives
	// training runs against Core's orchestration + durable job store. One capability
	// gates the whole `finetune.*` family (unary calls + the live progress stream).
	| "finetune.runs"
	// Website monitors (grant `monitors:crud`) — the `@ryu/monitors` app drives
	// Core's `/api/monitors/*` orchestration (list/create/update/delete/run +
	// snapshots/alerts). One capability gates the whole `monitors.*` family. Unlike
	// the bridge-backed families, the host services call the existing Core monitors
	// API directly (the media pattern) since `/api/monitors/*` is already gated on
	// the same `@ryu/monitors` enabled bit — no new Core bridge verb is needed.
	| "monitors.crud"
	// Workflows (grants `workflows:crud` / `workflows:runstate` / `workflows:catalogs`)
	// — the `@ryu/workflows` app drives Core's DAG workflow engine from its
	// sandboxed companion frame. Like monitors these are host-DIRECT families (the
	// host holds the node token and calls the existing `/workflows*` + `/api/workflows/
	// catalog*` API, already gated on the `@ryu/workflows` enabled bit — no new Core
	// bridge verb). Split into three least-privilege caps: `crud` (definition CRUD +
	// versions + templates + webhook URL), `runstate` (run + poll + resume), and
	// `catalogs` (the read-only node-config pickers: agents/apps/mcp/skills/schedules/
	// composio — under CSP `connect-src 'none'` the canvas is useless without them).
	| "workflows.crud"
	| "workflows.runstate"
	| "workflows.catalogs"
	// Ghost record→replay (grant `ghost:record`) — the RecordToWorkflow flow records a
	// native-desktop action sequence into a recipe (start/status/stop) and lists the
	// saved recipes (the recipe-node picker reads the same list). Host-direct over
	// Core's `/api/recipes/*`. Split from `workflows.*` so a workflow app that does not
	// use ghost capture need not hold it (least privilege).
	| "ghost.record"
	// Inbound webhook registry and protected secret management (grant
	// `webhooks:crud`) — the `@ryu/webhooks` app renders Core's registry and
	// explicit secret routes from its sandboxed companion frame. The host holds the
	// node token; secret values cross this bridge only through explicit get/set calls,
	// never through the metadata registry response. One capability gates the whole
	// `webhooks.*` family.
	| "webhooks.crud"
	// Quests (grant `quests:crud`) — the `@ryu/quests` app drives Core's
	// `/api/quests/*` auto-detecting-todo orchestration (list/create/update/delete +
	// complete/dismiss + suggestion accept/dismiss + judge) from its sandboxed companion
	// frame. Host-direct (the monitors pattern): the host holds the node token and calls
	// the existing `/api/quests/*` API. One capability gates the whole `quests.*` family,
	// including the `quests.openDetectionSettings` shell-navigation verb that opens the
	// Settings dialog at the Quests (detection) tab.
	| "quests.crud"
	// Keeping a selection from another app (grant `quests:capture`). Split from
	// `quests.crud` because it is a wider reach than editing the board: an app
	// that only renders quests holds `quests:crud` and cannot capture.
	| "quests.capture"
	// Activity feed (grant `activity:read`) — the `@ryu/activity` app renders Core's
	// read-only unified feed (`GET /api/activity`) from its sandboxed companion frame.
	// Host-direct (the monitors pattern): the host holds the node token and calls the
	// existing `/api/activity` read. One capability gates the whole (read-only)
	// `activity.*` family, including the `activity.openSession` shell-navigation verb
	// that opens the chat tab for an item's session id.
	| "activity.read"
	| "background.control"
	| "warmup.crud"
	// Timeline (grant `timeline:read`) — the `@ryu/timeline` app renders the
	// CapCut-style activity replay scrubber (Shadow's captured lanes + keyframe
	// preview + Dayflow work journal) from its sandboxed companion frame. Host-direct
	// (the monitors pattern), but device-LOCAL: Shadow (:3030) is pinned to the
	// physical machine, so the host calls it WITHOUT a node token (the `shadow.ts`
	// INVARIANT — the same host-direct-to-Shadow shape as `suggestions.*` above). One
	// capability gates the whole (read-only) `timeline.*` family, including the
	// `timeline.frame` keyframe→data-URL verb (CSP `img-src data: blob:`) and the
	// `timeline.openReview`/`openSettings` shell-navigation verbs.
	| "timeline.read"
	// Agent Inboxes (grant `mail:crud`) — the `@ryu/mail` app drives Core's
	// `/api/mail/*` orchestration (inbox CRUD, message list/send, inbound-secret
	// rotation) from its sandboxed companion frame. Host-direct (the monitors
	// pattern): the host holds the node token and calls the existing `/api/mail/*`
	// client (served by the out-of-process `ryu-mail` sidecar, already gated on the
	// `@ryu/mail` enabled bit). One capability gates the whole `mail.*` family,
	// including the `mail.inboundUrl` verb the host resolves from the node URL (the
	// frame has none) — the `workflows.webhook` precedent.
	| "mail.crud"
	// Calendar (grant `calendar:crud`) — the `@ryu/calendar` app renders the
	// scheduled-runs calendar (every agent/workflow scheduled job projected onto
	// Month/Week/Day/Agenda) from its sandboxed companion frame, and schedules an
	// agent via the New-automation dialog. Host-direct (the monitors pattern): the
	// host holds the node token and calls the existing `/heartbeat/jobs` (jobs),
	// `/workflows` (names), and `/api/agents` (picker) reads, plus the idempotent
	// `createScheduledAgentWorkflow` routine composite. One capability gates the whole
	// `calendar.*` family.
	| "calendar.crud"
	// Learning (grant `learning:crud`) — the `@ryu/learning` app renders the
	// read-only continual-learning surface (the two opt-in levels + the models in
	// use, the experience buffer's captured/scored/trainable counts, and the
	// read-only self-healing attempt history) from its sandboxed companion frame.
	// Host-direct (the monitors pattern): the host holds the node token and calls the
	// existing `/api/learn/config` (config), `/api/experience/list` (buffer), and
	// `/api/healing/status` (heal history) reads. READ-ONLY — the actions (skill
	// approvals + the heal inbox) stay in the Inbox, the opt-ins in Privacy settings.
	// One capability gates the whole `learning.*` family.
	| "learning.crud"
	// Inbox / Approvals (grant `approvals:crud`) — the `@ryu/approvals` app renders
	// the unified inbox from its sandboxed companion frame: pending HITL approvals
	// (approve/reject), the per-user notification feed (read + the workflow-resume ack
	// gate), and Shadow's proactive suggestions (list + feedback + open-in-chat). Host-
	// direct (the monitors pattern): the host holds the node token and calls the existing
	// `/api/approvals/*`, `/api/notifications/*` (host-resolved user id), and Shadow's
	// `/proactive` + `/api/feedback` — plus the `suggestions.openInChat` shell-navigation
	// verb. One capability gates that whole family; the inbox's quest task check-off reuses
	// the separate `quests.crud` capability (the app declares BOTH grants).
	| "approvals.crud"
	// Targeted Inbox notifications (grant `notifications:send-to-user`). Core
	// re-checks the recipient against the node's organization/team roster.
	| "notifications.send"
	// Meetings (grant `meetings:crud`) — the `@ryu/meetings` app renders the
	// record → live-transcript → AI-notes surface from its sandboxed companion frame.
	// Host-direct (the monitors pattern): the host holds the node token and calls the
	// existing `/api/meetings/*` orchestration (list/transcript + start/finalize/delete/
	// rename). One capability gates the whole `meetings.*` family, including the
	// host-owned `meetings.import` audio-upload verb (the frame carries no file picker +
	// cannot POST multipart under the CSP) and the `meetings.open`/`openNotes`/`openList`
	// shell-navigation verbs (mirroring the desktop page's `openTab`).
	| "meetings.crud"
	// Outpost (grant `social:crud`) — the `@ryu/social` app renders the compose →
	// calendar → queue → inbox surface from its sandboxed companion frame. Host-direct
	// (the monitors pattern), but with ONE generic forwarder rather than a verb per
	// endpoint: `social.request` carries `{ method, path, body }` that the host
	// re-issues against Core's `/api/social<path>` public mount. That mount already
	// answers any client holding the node token — which is exactly what the host holds
	// — so the forwarder widens nothing; the gates are this capability and Core's
	// ext-proxy route allowlist (an undeclared sub-path is a hard 404). The same
	// capability covers the two `social.open`/`openList` shell-navigation verbs, which
	// cannot be forwarded because opening a tab is the one thing the frame cannot do.
	| "social.crud"
	// Subtitles (grant `subtitles:crud`) — the `@ryu/subtitles` app picks a video,
	// queues a local transcription + translation, and reads the resulting cue list from
	// its sandboxed companion frame. Host-direct (the monitors pattern) with ONE generic
	// forwarder (the Outpost pattern): `subtitles.request` carries `{ method, path, body }`
	// that the host re-issues against Core's `/api/subtitles<path>` public mount. That
	// mount already answers any client holding the node token — which is what the host
	// holds — so the forwarder widens nothing; the gates are this capability and Core's
	// ext-proxy route allowlist. There is no navigation verb: the companion is the whole
	// surface. Note that the frame never carries the VIDEO — a job names a path and the
	// sidecar opens it, so a 4 GB film never crosses this boundary.
	| "subtitles.crud"
	// Skill authoring (grant `skills:crud`) — the `@ryu/skill-editor` app authors a
	// user-owned Agent Skill (`SKILL.md`): front-matter form fields + a markdown body +
	// server-backed version history. Host-direct (the monitors pattern): the host holds
	// the node token and calls the existing `/api/skills` authoring endpoints (reusing the
	// desktop `skills.ts` client, which normalizes Core's snake_case to camelCase). One
	// capability gates the whole `skills.*` family, including the `skills.setTitle`
	// shell-navigation verb that renames the owning tab (the desktop page's
	// `updateTabTitle`).
	| "skills.crud"
	// Automated Reasoning (grant `reasoning:check`) — the `@ryu/reasoning` app authors
	// formal policies and runs the solver playground from its sandboxed companion
	// frame. Host-direct (the monitors pattern) with ONE generic forwarder (the Outpost
	// pattern): `reasoning.request` carries `{ method, path, body }` that the host
	// re-issues against Core's `/api/reasoning<path>` public mount. That mount already
	// answers any client holding the node token — which is what the host holds — so the
	// forwarder widens nothing; the gates are this capability and Core's ext-proxy route
	// allowlist, where an undeclared sub-path is a hard 404. No navigation verb: the
	// companion is the whole surface and never opens a shell tab.
	| "reasoning.check"
	| "safe-actions.manage"
	// Deep Read (grant `rlm:query`) — the `@ryu/rlm` app loads a corpus, browses its
	// outline, asks questions of it and reads run traces from its sandboxed companion
	// frame. Host-direct with ONE generic forwarder, the same shape as
	// `reasoning.request` directly above: `rlm.request` carries `{ method, path, body }`
	// the host re-issues against Core's `/api/rlm<path>` public mount, which already
	// answers any client holding the node token — so the forwarder widens nothing. The
	// gates are this capability and Core's ext-proxy route allowlist, where an
	// undeclared sub-path is a hard 404. No navigation verb: the companion is the whole
	// surface.
	| "rlm.query"
	// Tuition (grant `tuition:crud`) and Wire (grant `news:crud`) — the `@ryu/tuition`
	// and `@ryu/news` companions. Host-direct with ONE generic forwarder each, the same
	// shape as `reasoning.request` directly above: `<app>.request` carries
	// `{ method, path, body }` the host re-issues against that app's public mount.
	// Forty-three sidecar routes between them would otherwise be forty-three verbs.
	// Neither widens anything — the mount already answers any client holding the node
	// token, which is what the host holds — and the gates stay the capability plus
	// Core's ext-proxy route allowlist, where an undeclared sub-path is a hard 404.
	| "tuition.crud"
	| "news.crud"
	// Visual plan review (grant `blueprint:review`) — the `@ryu/blueprint` app renders a
	// plan an agent published (markdown blocks, the dependency graph derived from the
	// steps, the annotation rail) and records the human's verdict. Host-direct with ONE
	// generic forwarder, the same shape as `reasoning.request` directly above:
	// `blueprint.request` carries `{ method, path, body }` the host re-issues against
	// Core's `/api/blueprint<path>` public mount, which already answers any client
	// holding the node token — so the forwarder widens nothing. The gates are this
	// capability and Core's ext-proxy route allowlist, where an undeclared sub-path is a
	// hard 404. No navigation verb: the review surface IS the companion.
	| "blueprint.review"
	// Shell primitives (grant `shell:integrate`) — the generic `window.ryu.shell.*`
	// lane giving a DECOUPLED companion the shell-integration privileges a compiled-in
	// first-party panel has: `shell.openTab` (unary, route-allowlisted navigation with
	// `openTab` options), plus three STREAMING subscribe/register verbs —
	// `shell.themeSubscribe` (live theme tokens), `shell.registerCommand` (Cmd+K palette
	// contribution, invocations streamed back), `shell.eventsSubscribe` (the node event
	// stream, channel-filtered). ONE capability gates the whole family; the host owns the
	// tabs/theme/palette/event seams, so the verbs resolve entirely in the trusted webview
	// (no Core bridge fetch — like the existing per-app nav verbs). See
	// `docs/renderer-host-slice-1.md`.
	| "shell.integrate";

/** A route a plugin claims for its own surface. Sent by the plugin over
 *  `ui.registerRoute`; the host validates it with {@link validatePluginRoute}
 *  before accepting. Kept minimal (path + title) — the anti-phishing enforcement
 *  point (#6). */
export interface RouteClaim {
	path: string;
	title: string;
}

// --- Monitor payload shapes (grant `monitors:crud`). These aliases point at the
// canonical Core Client wire model so the RPC boundary, Desktop, and Companion all
// carry the same required fields and notification variants. ---
/** Stable host vocabulary for ephemeral notifications. This is intentionally
 * independent of the renderer's toast library. */
export type ToastVariant =
	| "default"
	| "success"
	| "info"
	| "warning"
	| "error"
	| "loading";

export interface ToastShowInput {
	description?: string;
	duration?: number;
	title: string;
	variant?: ToastVariant;
}

export interface ToastUpdateInput {
	description?: string;
	duration?: number;
	id: string;
	title?: string;
	variant?: ToastVariant;
}

export interface ToastDismissInput {
	id: string;
}

/** Bounds are part of the host contract, not renderer-library defaults. */
export const TOAST_LIMITS = Object.freeze({
	descriptionChars: 500,
	durationMaxMs: 60_000,
	durationMinMs: 1000,
	idChars: 128,
	titleChars: 120,
});

// --- Quest payload shapes (grant `quests:crud`). Minimal INLINE aliases so rpc.ts
// stays dependency-free; they mirror Core's `/api/quests/*` serde JSON (snake_case)
// verbatim. The host forwards these through unchanged; the app owns the richer typed
// copies in `@ryu/quests-app/types`. ---

/** A quest as Core returns it (opaque status/suggestion fields kept loose so rpc.ts
 *  carries no schema — Core validates server-side). */
export interface QuestRecord {
	id: string;
	title: string;
	[key: string]: unknown;
}

/** The create/update payload for a quest (forwarded verbatim to Core). */
export interface QuestInputPayload {
	completion_condition: string;
	title: string;
	[key: string]: unknown;
}

/** A judge result (loose — Core owns the shape: `{ met?, confidence?, reason?, skipped? }`). */
export type QuestJudgeResult = Record<string, unknown>;

/** One activity-feed record as Core returns it (grant `activity:read`). Loose beyond
 *  the id — rpc.ts carries no schema; the app owns the richer typed copy in
 *  `@ryu/activity-app/types`. Forwarded verbatim (snake_case) by the host. */
export interface ActivityRecord {
	id: string;
	[key: string]: unknown;
}

/** A redacted conversation summary for the Chat Broadcast companion. The host
 * never forwards message bodies through this list; the send service loads the
 * transcript privately and returns only an accepted/failed result. */
export interface ChatConversationSummary {
	agent_id: string | null;
	archived?: boolean;
	created_at: number;
	id: string;
	last_message?: string;
	last_message_at?: number;
	last_message_role?: string;
	message_count: number;
	run_status: string | null;
	title: string | null;
	updated_at: number;
	[key: string]: unknown;
}

/** Result returned after the host has detached an accepted chat stream. */
export interface ChatSendResult {
	conversation_id: string;
	status: "accepted";
}

/** A Core-visible background process. The process owner handles the stop request;
 * the host never receives or signals an operating-system PID directly. */
export interface BackgroundProcess {
	command: string;
	cwd: string;
	description?: string | null;
	elapsed_ms: number;
	exit_code?: number | null;
	exit_signal?: string | null;
	kind: string;
	label?: string | null;
	pid?: number | null;
	process_id: string;
	producer: string;
	running: boolean;
	shell_id?: string | null;
	started_at: number;
}

/** One Shadow timeline event as the device-local `/timeline` returns it (grant
 *  `timeline:read`). Opaque — rpc.ts carries no schema; the app owns the richer typed
 *  copy in `@ryu/timeline-app/types`. Forwarded verbatim (snake_case) by the host.
 *  `null` when Shadow (:3030) is unreachable (recording off). */
export type TimelineEventRecord = Record<string, unknown>;

/** Shadow's derived work-journal snapshot as `/journal` returns it (grant
 *  `timeline:read`). Opaque — the app owns the typed copy. `null` when unreachable. */
export type TimelineJournalRecord = Record<string, unknown>;

// --- Mail payload shapes (grant `mail:crud`). Minimal INLINE aliases so rpc.ts
// stays dependency-free; they mirror Core's `/api/mail/*` serde JSON verbatim. The
// host forwards these through unchanged; the app owns the richer typed copies in
// `@ryu/mail-app/types`. ---

/** An inbox as Core returns it (opaque beyond the id — Core owns the shape). */
export interface MailInbox {
	id: string;
	[key: string]: unknown;
}

/** A stored email message as Core returns it (opaque beyond the id). */
export interface MailMessage {
	id: string;
	[key: string]: unknown;
}

/** The create-inbox payload (forwarded verbatim to Core). */
export interface MailCreatePayload {
	address: string;
	name: string;
	provider?: string;
}

/** The send payload (forwarded verbatim to Core). */
export interface MailSendPayload {
	inboxId: string;
	subject: string;
	text?: string;
	to: string[];
}

// --- Calendar payload shapes (grant `calendar:crud`). Minimal INLINE aliases so
// rpc.ts stays dependency-free; the host forwards Core's shapes verbatim. The app
// owns the richer typed copies in `@ryu/calendar-app/types`. ---

/** A scheduled job as the host forwards it (the camelCase `fetchJobs` shape; opaque
 *  beyond the id — the app owns the full type). */
export interface CalendarJobRecord {
	id: string;
	[key: string]: unknown;
}

/** A workflow as the host forwards it (the calendar reads only id+name; opaque
 *  beyond the id). */
export interface CalendarWorkflowRecord {
	id: string;
	[key: string]: unknown;
}

/** An agent summary as the host forwards it (the picker reads id+name; opaque
 *  beyond the id). */
export interface CalendarAgentRecord {
	id: string;
	[key: string]: unknown;
}

// --- Warmup (grant `warmup:crud`). The `@ryu/warmup` app schedules a keep-alive
// ping to each subscription agent so its rolling usage window is already open. As
// with calendar, rpc.ts stays dependency-free and the host forwards Core's shapes
// verbatim; the app owns the richer typed copies in `@ryu/warmup-app/types`. ---

/** One agent the host detected, with its usage windows + advertised models. */
export interface WarmupAgentRecord {
	id: string;
	[key: string]: unknown;
}

/** What `warmup.detect` reports: the agents plus the node's IANA zone. */
export interface WarmupDetectionRecord {
	agents: WarmupAgentRecord[];
	tz: string;
}

/** One job to schedule. Deliberately narrower than Core's `CreateJobBody`: this
 *  capability schedules agent pings, so a workflow/monitor target is not
 *  expressible and the owning app is pinned host-side rather than claimed by the
 *  frame (see {@link asWarmupJobsArg}). */
export interface WarmupJobInput {
	name: string;
	schedule:
		| { kind: "cron"; expr: string; tz?: string }
		| { kind: "every"; interval: string };
	target: {
		type: "agent";
		agentId: string;
		prompt: string;
		model?: string | null;
	};
}

/** The one-off ping payload for `warmup.runNow`: a job the app already owns. */
export interface WarmupRunNowPayload {
	jobId: string;
}

/** The New-automation payload: schedule an agent on a cron/interval schedule. The
 *  host runs the same idempotent `createScheduledAgentWorkflow` composite the
 *  desktop dialog ran. */
export interface CalendarCreateAutomationPayload {
	agentId: string;
	agentName: string;
	conversationId?: string | null;
	requireApproval?: boolean;
	schedule:
		| { kind: "cron"; expr: string }
		| { kind: "every"; interval: string };
}

// --- Learning payload shapes (grant `learning:crud`). Minimal INLINE aliases so
// rpc.ts stays dependency-free; the host forwards Core's snake_case shapes verbatim.
// The app owns the richer typed copies in `@ryu/learning-app/types`. All READ-ONLY. ---

/** The resolved learning config as the host forwards it (`GET /api/learn/config`,
 *  the `getLearningConfig` shape; opaque here — the app owns the full type). */
export interface LearningConfigRecord {
	[key: string]: unknown;
}

/** The experience buffer + counts as the host forwards it (`GET /api/experience/list`,
 *  the `listExperience` shape; opaque here — the app owns the full type). */
export interface LearningExperienceRecord {
	[key: string]: unknown;
}

/** The per-source heal-attempt map as the host forwards it (`GET /api/healing/status`,
 *  the `getHealingStatus` shape; opaque here — the app owns the full type). */
export interface LearningHealingRecord {
	[key: string]: unknown;
}

// --- Inbox / Approvals payload shapes (grant `approvals:crud`). Minimal INLINE
// aliases so rpc.ts stays dependency-free; the host forwards Core's / Shadow's
// snake_case shapes verbatim. The app owns the richer typed copies in
// `@ryu/approvals-app/types`. ---

/** An approval request as the host forwards it (`GET /api/approvals`, the
 *  `listApprovals`/decide shape; opaque here — the app owns the full type). */
export interface ApprovalRecord {
	id: string;
	[key: string]: unknown;
}

/** A stored inbox notification row as the host forwards it (`GET /api/notifications`,
 *  the `listNotifications` shape; opaque here — the app owns the full type). */
export interface NotificationRecord {
	id: string;
	[key: string]: unknown;
}

/** An app's resolved notification icon tile, inlined by the host for the CSP-
 *  locked frame: `glyph` is a `data:` URL (empty when the app has no art), and
 *  `background` is a flat CSS color (null → the frame's neutral plate). */
export interface AppIconTile {
	background: string | null;
	glyph: string;
	name: string;
}

/** A Shadow proactive suggestion as the host forwards it (`GET /proactive`, the
 *  `getProactiveInbox` shape; opaque here — the app owns the full type). */
export interface ProactiveSuggestionRecord {
	id: string;
	[key: string]: unknown;
}

/** The approve/reject decision payload (`{ id, note? }`, forwarded to Core). */
export interface ApprovalDecidePayload {
	id: string;
	note?: string;
}

/** The Shadow feedback payload (`{ kind, suggestion_type }`, forwarded to Shadow). */
export interface SuggestionFeedbackPayload {
	kind: "thumbs_up" | "thumbs_down" | "dismiss";
	suggestion_type: string;
}

// --- Meetings payload shapes (grant `meetings:crud`). Minimal INLINE aliases so
// rpc.ts stays dependency-free; the host forwards Core's `/api/meetings/*` snake_case
// shapes verbatim. The app owns the richer typed copies in `@ryu/meetings-app/types`. ---

/** A meeting as the host forwards it (`GET /api/meetings`, the `listMeetings`/
 *  `startMeeting`/… shape; opaque here — the app owns the full type). */
export interface MeetingRecord {
	id: string;
	[key: string]: unknown;
}

/** A meeting's transcript as the host forwards it (`GET /api/meetings/:id/transcript`,
 *  the `getTranscript` shape; opaque here — the app owns the full type). */
export interface MeetingTranscriptRecord {
	[key: string]: unknown;
}

/** The start-meeting input the frame supplies (`POST /api/meetings`). */
export interface MeetingStartPayload {
	app?: string;
	source?: string;
	title?: string;
}

// --- Outpost payload shapes (grant `social:crud`). Minimal INLINE aliases so rpc.ts
// stays dependency-free; the host forwards the `ryu-social` sidecar's snake_case
// shapes verbatim. The app owns the richer typed copies in
// `@ryu/social-app/types`. ---

/** One forwarded call onto the sidecar's `/api/social` public mount.
 *
 *  `path` is RELATIVE to that mount, leading slash included, query string and all
 *  (`"/posts?status=scheduled,due"`). The host prepends the mount and REFUSES an
 *  absolute URL, a path not starting with `/`, and any `..` segment — so the frame
 *  chooses the sub-path and nothing else. It can never name a host, and it can never
 *  climb out of the mount onto another Core API. */
export interface SocialRequestPayload {
	body?: unknown;
	method?: "DELETE" | "GET" | "PATCH" | "POST";
	path: string;
}

/** One forwarded call onto the calling companion's OWN manifest sidecar. The host
 * derives the plugin id; the frame controls only a normalized relative path. */
export interface AppRequestPayload {
	body?: unknown;
	method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
	path: string;
}

/** Wire payload for opening an owning application's generic realtime room. */
export interface RealtimeConnectPayload {
	room_id: string;
}

/** The host-safe join result; it contains no node token or websocket URL. */
export interface RealtimeConnectionInfo {
	access: "read" | "write";
	/** Opaque handle for publish, presence, subscribe, and close calls. */
	connection_id: string;
	member_id: string;
	presence: unknown[];
	room_id: string;
}

/** Reference to a connection held by the trusted host. */
export interface RealtimeConnectionPayload {
	connection_id: string;
}

/** Named event sent through an application-room connection. */
export interface RealtimePublishPayload extends RealtimeConnectionPayload {
	data: unknown;
	event: string;
}

/** Presence sent through an application-room connection. */
export interface RealtimePresencePayload extends RealtimeConnectionPayload {
	data: unknown;
}

/** One forwarded call onto the `ryu-reasoning` sidecar's `/api/reasoning` public
 *  mount. Same contract as {@link SocialRequestPayload} — `path` is relative to the
 *  mount and validated by the same resolver — with `PUT` in place of `PATCH`, because
 *  that is the verb the sidecar's policy route actually serves. */
export interface ReasoningRequestPayload {
	body?: unknown;
	method?: "DELETE" | "GET" | "POST" | "PUT";
	path: string;
}

/** One forwarded call onto Core's `/api/tools/plans` protected mount. */
export interface SafeActionsRequestPayload {
	body?: unknown;
	method?: "DELETE" | "GET" | "POST" | "PUT";
	path: string;
}

/** One forwarded call onto the `ryu-rlm` sidecar's `/api/rlm` public mount. Same
 *  contract and the same method union as {@link ReasoningRequestPayload} — `path` is
 *  relative to the mount and validated by the same resolver. */
export interface RlmRequestPayload {
	body?: unknown;
	method?: "DELETE" | "GET" | "POST" | "PUT";
	path: string;
}

/** One forwarded call onto the `ryu-tuition` sidecar's `/api/tuition` public mount.
 *  Same contract as {@link SocialRequestPayload} — `path` is relative to the mount and
 *  validated by the same resolver. The method union carries PATCH as well as PUT: the
 *  subject, skill and item routes patch in place, while settings are replaced whole. */
export interface TuitionRequestPayload {
	body?: unknown;
	method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
	path: string;
}

/** One forwarded call onto the `ryu-news` sidecar's `/api/news` public mount. Same
 *  contract and the same method union as {@link TuitionRequestPayload}. */
export interface NewsRequestPayload {
	body?: unknown;
	method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
	path: string;
}

/** One forwarded call onto the `ryu-subtitles` sidecar's `/api/subtitles` public
 *  mount. Same contract as {@link SocialRequestPayload} — `path` is relative to the
 *  mount and validated by the same resolver. The method union carries PUT (settings
 *  are replaced whole) but no PATCH: nothing in this app edits a field in place, and
 *  advertising a verb the sidecar answers with 405 helps nobody. */
export interface SubtitlesRequestPayload {
	body?: unknown;
	method?: "DELETE" | "GET" | "POST" | "PUT";
	path: string;
}

/** One forwarded call onto the `ryu-blueprint` sidecar's `/api/blueprint` public
 *  mount. Same contract as {@link SocialRequestPayload} — `path` is relative to the
 *  mount and validated by the same resolver.
 *
 *  The method union is deliberately NARROWER than its two siblings: the plan-review
 *  surface is append-only by design, so its eleven routes are GET, POST and DELETE
 *  and nothing else. A revision is never edited in place — revising means POSTing a
 *  new revision, which is what makes an annotation's `(revision, block_id)` anchor
 *  mean something. Widening this union to match a sibling's would advertise verbs the
 *  sidecar answers with 405, so leave it at three unless a route really appears. */
export interface BlueprintRequestPayload {
	body?: unknown;
	method?: "DELETE" | "GET" | "POST";
	path: string;
}

// --- Skill authoring payload shapes (grant `skills:crud`). Minimal INLINE aliases so
// rpc.ts stays dependency-free; the host forwards the desktop `skills.ts` client's
// camelCase shapes verbatim (that client normalizes Core's `/api/skills` snake_case
// wire). The app owns the richer typed copies in `@ryu/skill-editor-app/types`. ---

/** The editable fields the editor sends on create/update (camelCase, matching the
 *  desktop `SkillDraft`). Forwarded verbatim to the host's `skills.ts` client. */
export interface SkillDraftPayload {
	allowedTools?: string[];
	alwaysOn?: boolean;
	body: string;
	description?: string | null;
	name: string;
}

/** A skill's editable source as the host forwards it (`GET /api/skills/:id/source`,
 *  the `SkillSource` shape; opaque here — the app owns the full type). */
export type SkillSourceRecord = Record<string, unknown>;

/** The `{ id, source }` a create/update returns (the `SkillWriteResult` shape). */
export type SkillWriteRecord = Record<string, unknown>;

/** One saved skill-version's metadata as the host forwards it (`SkillVersionMeta`;
 *  opaque here — the app owns the full type). */
export type SkillVersionRecord = Record<string, unknown>;

/** One file returned by {@link HostServices.uploadFile} — persisted in Uploads. */
export interface UploadFileResult {
	/** `data:` URL so CSP-locked frames (`img-src data:`) can render the bytes. */
	data_url: string;
	id: string;
	mime_type: string;
	name: string;
	size: number;
	space_id: string;
	/** Absolute Core URL (`…/api/uploads/<id>`) for host-side fetches. */
	url: string;
}

/** Sanitized, read-only feature inventory exposed to sandboxed plugins. Values
 * are deliberately booleans or small public metadata; tokens, permission
 * objects, native module instances, and device identifiers never cross this
 * boundary. */
export interface HostCapabilityDescriptor {
	androidOngoingNotifications: boolean;
	browserNotifications: boolean;
	dynamicIsland: boolean;
	haptics: boolean;
	hardwareBleRelay: boolean;
	liveActivities: boolean;
	localNotifications: boolean;
	platform: "android" | "browser" | "ios" | "unknown";
	pushRegistration: boolean;
	quickActions: boolean;
	sounds: boolean;
}

export type NativeHapticStyle = "light" | "success" | "warning" | "error";

export interface NativeHapticsInput {
	style: NativeHapticStyle;
}

export interface NativeNotificationInput {
	body: string;
	title: string;
}

export interface NativeLiveActivityUpdateInput {
	conversationId: string;
	detail: string;
	status: "running" | "waiting" | "review" | "done" | "error";
	title: string;
}

export interface NativeHapticsResult {
	signaled: true;
}

export interface NativeNotificationResult {
	id: string;
	scheduled: true;
}

export interface NativeLiveActivityResult {
	updated: true;
}

/** Limits applied before any native implementation sees plugin input. */
export const NATIVE_ACTION_LIMITS = {
	conversationIdChars: 200,
	detailChars: 500,
	notificationBodyChars: 2000,
	notificationTitleChars: 120,
	titleChars: 120,
} as const;

function boundedNativeText(raw: unknown, maxChars: number): string | undefined {
	if (typeof raw !== "string") {
		return undefined;
	}
	const value = raw.trim();
	return value.length > 0 && value.length <= maxChars ? value : undefined;
}

export function asNativeHapticsInput(
	raw: unknown
): NativeHapticsInput | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}
	const style = (raw as Record<string, unknown>).style;
	return style === "light" ||
		style === "success" ||
		style === "warning" ||
		style === "error"
		? { style }
		: undefined;
}

export function asNativeNotificationInput(
	raw: unknown
): NativeNotificationInput | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}
	const input = raw as Record<string, unknown>;
	const title = boundedNativeText(
		input.title,
		NATIVE_ACTION_LIMITS.notificationTitleChars
	);
	const body = boundedNativeText(
		input.body,
		NATIVE_ACTION_LIMITS.notificationBodyChars
	);
	return title && body ? { body, title } : undefined;
}

export function asNativeLiveActivityUpdateInput(
	raw: unknown
): NativeLiveActivityUpdateInput | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}
	const input = raw as Record<string, unknown>;
	const conversationId = boundedNativeText(
		input.conversationId,
		NATIVE_ACTION_LIMITS.conversationIdChars
	);
	const title = boundedNativeText(input.title, NATIVE_ACTION_LIMITS.titleChars);
	const detail = boundedNativeText(
		input.detail,
		NATIVE_ACTION_LIMITS.detailChars
	);
	const status = input.status;
	if (
		!(conversationId && title && detail) ||
		(status !== "running" &&
			status !== "waiting" &&
			status !== "review" &&
			status !== "done" &&
			status !== "error")
	) {
		return undefined;
	}
	return { conversationId, detail, status, title };
}

function browserPlatform(): HostCapabilityDescriptor["platform"] {
	return typeof navigator === "undefined" ? "unknown" : "browser";
}

/** Detect browser-only host features without requesting permission or returning
 * browser objects. Native hosts replace this with their platform detector. */
export function detectBrowserHostCapabilities(): HostCapabilityDescriptor {
	const browser = browserPlatform() === "browser";
	const notification = browser && typeof Notification !== "undefined";
	const audio =
		browser &&
		(typeof AudioContext !== "undefined" || typeof Audio !== "undefined");
	return {
		androidOngoingNotifications: false,
		browserNotifications: notification,
		dynamicIsland: false,
		hardwareBleRelay:
			browser && typeof navigator !== "undefined" && "bluetooth" in navigator,
		haptics:
			browser &&
			typeof navigator !== "undefined" &&
			typeof navigator.vibrate === "function",
		localNotifications: notification,
		liveActivities: false,
		platform: browserPlatform(),
		pushRegistration:
			browser &&
			typeof PushManager !== "undefined" &&
			typeof ServiceWorkerContainer !== "undefined",
		quickActions: false,
		sounds: audio,
	};
}

/** Browser-compatible implementation for the two native actions that have a
 *  standards-based fallback. It deliberately requires permission already to be
 *  granted: a sandboxed plugin must never trigger an OS/browser permission
 *  prompt on its own. Mobile hosts inject their platform implementations.
 */
function browserNativeHaptics(input: NativeHapticsInput): NativeHapticsResult {
	const vibrate = globalThis.navigator?.vibrate;
	if (typeof vibrate !== "function") {
		throw new CodedRpcError(
			"server_error",
			"native.haptics is unavailable on this host"
		);
	}
	const duration =
		input.style === "light"
			? 12
			: input.style === "success"
				? [12, 32, 12]
				: input.style === "warning"
					? [24, 32, 24]
					: [36, 40, 36];
	if (!vibrate(duration)) {
		throw new CodedRpcError(
			"server_error",
			"native.haptics was rejected by this host"
		);
	}
	return { signaled: true };
}

async function browserNativeNotification(
	input: NativeNotificationInput
): Promise<NativeNotificationResult> {
	const NotificationConstructor = globalThis.Notification;
	if (
		typeof NotificationConstructor !== "function" ||
		NotificationConstructor.permission !== "granted"
	) {
		throw new CodedRpcError(
			"server_error",
			"native.notifications.create requires notification permission granted by the host"
		);
	}
	const notification = new NotificationConstructor(input.title, {
		body: input.body,
	});
	const id =
		typeof globalThis.crypto?.randomUUID === "function"
			? globalThis.crypto.randomUUID()
			: `browser-notification-${Date.now()}`;
	notification.onclick = () => notification.close();
	return { id, scheduled: true };
}

/** The privileged service callbacks the trusted host injects. The plugin can only
 *  reach these indirectly, through {@link dispatchRpc}, and only for methods whose
 *  capability it was granted.
 *
 *  INVARIANT #5: no method here returns a token/secret or performs ungoverned
 *  network egress. `listAgents` returns only a `{id,name}` projection; a future
 *  capability MUST keep that rule (every reply is readable by the sandboxed
 *  frame by construction). */
// HostServices stays grouped by surface so its comments mirror the contribution
// docs; it is intentionally not alphabetized across those semantic sections.
// biome-ignore assist/source/useSortedInterfaceMembers: preserve host-surface grouping
export interface HostServices {
	/** Return secret-free active-node and mesh origins for share links. */
	nodeShareOrigins?(): Promise<RyuNodeShareOrigin[]>;
	/** Mobile-only native actions. Desktop, web, and extension hosts deliberately
	 * leave these callbacks undefined, so a granted call fails closed as
	 * unavailable instead of falling back to browser or raw native APIs. */
	nativeHaptics?(
		input: NativeHapticsInput
	): Promise<NativeHapticsResult> | NativeHapticsResult;
	nativeLiveActivitiesUpdate?(
		input: NativeLiveActivityUpdateInput
	): Promise<NativeLiveActivityResult>;
	nativeNotificationsCreate?(
		input: NativeNotificationInput
	): Promise<NativeNotificationResult>;

	// --- Activity feed (grant `activity:read`). The `@ryu/activity` app renders
	// Core's read-only unified feed. Host-direct (the monitors pattern): the host holds
	// the node token and calls the existing `GET /api/activity` read, forwarding Core's
	// snake_case items verbatim over the bridge. All optional so a non-activity host is
	// unaffected. ---

	/** List the unified activity feed (`GET /api/activity`), capped, newest-first. */
	activityList?(input: { limit?: number }): Promise<ActivityRecord[]>;
	/** Open the chat tab for an item's session id. A pure shell-navigation verb (no
	 *  Core call); fire-and-forget from the frame's view (mirrors the desktop page's
	 *  clickable row). */
	activityOpenSession?(input: { session_id: string }): void;
	// --- Chat Broadcast (grant `chat.sendFollowUp`). The companion can list only
	// conversations visible to the current verified caller. `chatSend` loads the
	// transcript in the trusted host, posts one real user turn, and returns after
	// Core accepts the detached stream; the sandbox never receives a node token or
	// transcript contents. --
	/** List visible conversation summaries, including idle chats. */
	chatListConversations?(): Promise<ChatConversationSummary[]>;
	/** Post one message into an existing conversation. */
	chatSend?(input: {
		conversationId: string;
		text: string;
	}): Promise<ChatSendResult>;
	/** List Core-visible background processes, running by default. */
	backgroundList?(input: {
		producer?: string;
		running_only?: boolean;
	}): Promise<BackgroundProcess[]>;
	/** Request a process owner to stop one of its live processes. */
	backgroundStop?(input: {
		process_id: string;
	}): Promise<{ ok: boolean; requested: boolean; process_id: string }>;
	/** Forward a call to `/api/ext/<owning-plugin-id><path>`. */
	appRequest?(input: AppRequestPayload): Promise<unknown>;
	/** Open a host-owned application-room realtime connection. */
	realtimeConnect?(
		input: RealtimeConnectPayload
	): Promise<RealtimeConnectionInfo>;
	/** Publish a named event through a host-owned application-room connection. */
	realtimePublish?(input: RealtimePublishPayload): Promise<void>;
	/** Publish presence through a host-owned application-room connection. */
	realtimePresence?(input: RealtimePresencePayload): Promise<void>;
	/** Subscribe to events from a host-owned application-room connection. */
	realtimeSubscribe?(
		input: RealtimeConnectionPayload,
		emit: (delta: string) => void,
		signal: AbortSignal
	): Promise<void>;
	/** Close a host-owned application-room connection. */
	realtimeClose?(input: RealtimeConnectionPayload): Promise<void>;
	/** Approve a pending request (`POST /api/approvals/:id/approve`). */
	approvalsApprove?(input: ApprovalDecidePayload): Promise<ApprovalRecord>;

	// --- Inbox / Approvals (grant `approvals:crud`). The `@ryu/approvals` app
	// renders the unified inbox. Host-direct (the monitors pattern): the host holds the
	// node token and calls the existing `/api/approvals/*`, `/api/notifications/*`
	// (host-resolved user id — the sandboxed frame has no session), and Shadow's
	// `/proactive` + `/api/feedback`, plus the `suggestionsOpenInChat` shell-navigation
	// verb. All optional so a non-inbox host is unaffected. ---

	/** List the pending + decided approval queue (`GET /api/approvals`). */
	approvalsList?(): Promise<ApprovalRecord[]>;
	/** Reject a pending request (`POST /api/approvals/:id/reject`). */
	approvalsReject?(input: ApprovalDecidePayload): Promise<ApprovalRecord>;
	/** Drop this app's whole context slice from the assistant (page closed/blurred). */
	assistantClearContext?(): Promise<void>;
	/** Hand the assistant back to the generic "Ask Ryu" chat. */
	assistantClearSurface?(): Promise<void>;
	/** Open the assistant panel, optionally asking `prompt` straight away. */
	assistantOpen?(input: {
		mode?: "floating" | "sidebar";
		prompt?: string;
	}): Promise<void>;
	/** Replace this app's context slice — "here is what the user is looking at".
	 *  Other publishers (the page itself, other apps) keep their own slices. */
	assistantPublishContext?(input: {
		items: { id: string; text: string; title: string }[];
	}): Promise<void>;
	/** Take the assistant over while this app's surface is open: its own title,
	 *  instructions, starter prompts and the tools it wants reached for. */
	assistantRegisterSurface?(input: {
		description?: string;
		label: string;
		preamble?: string;
		prompts?: string[];
		tools?: string[];
	}): Promise<void>;
	/** Show an ephemeral host-rendered notification. The returned id is opaque and
	 * caller-local: implementations must not reveal the renderer's global id and
	 * must namespace it to the owning plugin before rendering. */
	uiToastShow?(input: ToastShowInput): Promise<string> | string;
	/** Update one toast previously returned to this caller. Unknown ids are a no-op
	 * at the renderer boundary; they must never reach another plugin's toast. */
	uiToastUpdate?(input: ToastUpdateInput): Promise<void> | void;
	/** Dismiss one toast previously returned to this caller. There is deliberately
	 * no global clear operation. */
	uiToastDismiss?(input: ToastDismissInput): Promise<void> | void;
	/** List agents (`GET /api/agents`) for the New-automation picker (id+name). */
	calendarAgents?(): Promise<CalendarAgentRecord[]>;
	/** Create (or update) the scheduled workflow that runs an agent on a schedule,
	 *  then drain any legacy agent-target job — the exact composite the desktop dialog
	 *  ran. Rejects with Core's validation message on a bad cron/interval. */
	calendarCreateAutomation?(
		input: CalendarCreateAutomationPayload
	): Promise<void>;

	// --- Calendar (grant `calendar:crud`). The `@ryu/calendar` app renders the
	// scheduled-runs calendar + schedules an agent. Host-direct (the monitors
	// pattern): the host holds the node token and calls the existing `/heartbeat/jobs`,
	// `/workflows`, `/api/agents` reads + the `createScheduledAgentWorkflow` composite,
	// forwarding results verbatim over the bridge. All optional so a non-calendar host
	// is unaffected. ---

	/** List scheduled jobs (`GET /heartbeat/jobs`), camelCase (the `fetchJobs` shape). */
	calendarJobs?(): Promise<CalendarJobRecord[]>;
	/** List workflow definitions (`GET /workflows`) — the calendar reads id+name. */
	calendarWorkflows?(): Promise<CalendarWorkflowRecord[]>;
	// --- Widget host services (Ryu Apps). The widget iframe reaches these ONLY via
	// the capability-gated bridge; the host performs the privileged, Gateway-governed
	// fetch (the frame never holds the Core token). All optional so the plugin host
	// need not implement them (decisions doc D5). ---

	/** Governed tool call: `POST /api/widgets/tools/call` (Gateway chain). The host
	 *  pins `serverId`/`instanceId`/`toolCallId`; the frame supplies only name+args. */
	callTool?(name: string, args: unknown): Promise<unknown>;
	/** The installed trained adapters with provenance (`host.finetune_adapters`). */
	finetuneAdapters?(): Promise<unknown>;
	/** Cooperatively cancel a running job (`host.finetune_cancel`). */
	finetuneCancel?(input: { id: string }): Promise<unknown>;

	// --- Fine-tune runs (grant `finetune:runs`). The `@ryu/finetune` app drives
	// training runs; Core owns the orchestration + durable job store + adapter→GGUF
	// merge, reached through the governed bridge (`/api/plugins/:id/host`). Each is
	// ONE privileged fetch; live progress streams over `finetuneStream`. All optional
	// so a host that does not implement them is unaffected. ---

	/** Probe what this node can train (`host.finetune_capability`): GPU, VRAM,
	 *  local-train gate + reason, and the sidecar's health. Takes no input. */
	finetuneCapability?(): Promise<unknown>;
	/** One job's live snapshot — step/loss/state (`host.finetune_get`). */
	finetuneGet?(input: { id: string }): Promise<unknown>;
	/** The durable job list, live-synced from the sidecar (`host.finetune_list`). */
	finetuneList?(): Promise<unknown>;
	/** Merge a trained adapter into a servable GGUF + register it as an installed
	 *  model (`host.finetune_merge`). `input` forwarded verbatim to Core. */
	finetuneMerge?(input: Record<string, unknown>): Promise<unknown>;
	/** Start a fine-tune job (`host.finetune_start`). `input` is the job spec
	 *  forwarded verbatim to Core (base model, dataset, hyperparams, target). */
	finetuneStart?(input: Record<string, unknown>): Promise<unknown>;
	/** Subscribe to a run's live SSE progress (`finetune.stream`). Each raw SSE
	 *  frame is delivered to `emit`; resolves when the stream ends; `signal` aborts. */
	finetuneStream?(
		input: { id: string },
		emit: (delta: string) => void,
		signal: AbortSignal
	): Promise<void>;

	// --- Media generation (grant `media:generate`) + speech-to-text
	// (`media:transcribe`). Each is ONE privileged, Gateway-governed fetch to a Core
	// media data-path endpoint (the host holds the node token; the frame never does).
	// The host returns `data:` URLs (never remote http URLs) so the CSP-locked frame
	// can render the result inline. All optional so a non-media host is unaffected. ---

	/** Generate image(s) from a prompt (`/api/images/generate`). Returns renderable
	 *  `data:` URLs — the host fetches any remote provider URL and inlines it. */
	generateImage?(input: {
		prompt: string;
		count?: number;
		size?: string;
		provider?: string;
		model?: string;
		input_images?: string[];
	}): Promise<string[]>;
	/** Generate video clip(s) from a prompt (`/api/video/generate`, polling cloud
	 *  jobs internally). Returns `{ url, mediaType }[]` with `url` a `data:` URL. */
	generateVideo?(input: {
		prompt: string;
		provider?: string;
		model?: string;
	}): Promise<{ url: string; mediaType: string }[]>;
	/** Return the host's current global snapshot for this widget so the frame can
	 *  refresh after the bridge connects (spec §1.3 `widget.getGlobals`). */
	getGlobals?(): Promise<unknown>;

	// --- Workflows (grants `workflows:crud`/`runstate`/`catalogs`) + ghost record
	// (`ghost:record`). Host-direct families (the monitors pattern): the host holds the
	// node token and calls the existing `/workflows*` + `/api/workflows/catalog*` +
	// `/api/recipes/*` API, already gated on the `@ryu/workflows` enabled bit. All
	// return the plain JSON the existing desktop client returns (kept `unknown` so
	// rpc.ts carries no workflow schema — the app owns the richer typed copies). All
	// optional so a non-workflows host is unaffected. ---

	/** Ghost recipe list (`GET /api/recipes`) — the recipe-node picker + record flow. */
	ghostRecipes?(): Promise<unknown>;
	/** Begin a native-desktop recording (`POST /api/recipes/record/start`). */
	ghostRecordStart?(input: { task: string }): Promise<unknown>;
	/** Poll the live recording status (`GET /api/recipes/record/status`). */
	ghostRecordStatus?(): Promise<unknown>;
	/** Stop recording; returns the captured AX action sequence + recipe draft
	 *  (`POST /api/recipes/record/stop`). */
	ghostRecordStop?(): Promise<unknown>;
	/** Return a sanitized host feature inventory. This is a local capability and
	 * does not require a plugin grant. */
	hostCapabilities?():
		| Promise<HostCapabilityDescriptor>
		| HostCapabilityDescriptor;

	// --- Learning (grant `learning:crud`). The `@ryu/learning` app renders the
	// read-only continual-learning surface. Host-direct (the monitors pattern): the
	// host holds the node token and calls the existing `/api/learn/config`,
	// `/api/experience/list`, `/api/healing/status` reads, forwarding Core's shapes
	// verbatim over the bridge. All READ-ONLY + optional so a non-learning host is
	// unaffected. ---

	/** Read the resolved learning config (`GET /api/learn/config`) — both opt-ins,
	 *  models, skill generation. */
	learningConfig?(): Promise<LearningConfigRecord>;
	/** Read the experience buffer + scored/trainable counts (`GET /api/experience/list`). */
	learningExperience?(): Promise<LearningExperienceRecord>;
	/** Read the per-source heal-attempt map (`GET /api/healing/status`) — read-only
	 *  observability; the approve/reject heal inbox stays in Approvals. */
	learningHealing?(): Promise<LearningHealingRecord>;
	/** List the agents on the active node, PROJECTED to `{id,name}` only.
	 *  Privileged: the host holds the token; the projection never leaks it. */
	listAgents(): Promise<unknown>;
	/** Read the shared, secret-free provider/model/agent/app/hook catalog. */
	catalogSnapshot?(): Promise<RyuCatalogSnapshot>;
	/** Discover models for one provider; Core resolves credentials server-side. */
	catalogModels?(input: { providerId: string }): Promise<RyuCatalogModels>;
	/** List agents with the fields a per-agent model picker needs (id/name/engine/
	 *  model/recommended) — a richer, still-secret-free projection than listAgents. */
	listAgentsFull?(): Promise<
		{
			id: string;
			name: string;
			engine: string | null;
			model: string | null;
			recommended: boolean;
		}[]
	>;
	/** List per-engine chat models (`/api/engines/models`), keyed by engine id.
	 *  Read-only catalog (no secrets), served under `core.listAgents`. */
	listEngineModels?(): Promise<Record<string, { id: string; name: string }[]>>;
	/** List TTS engines + their voices (`/api/voice/tts-engines`). Read-only. */
	listTtsEngines?(): Promise<unknown[]>;

	// --- Agent Inboxes (grant `mail:crud`). The `@ryu/mail` app drives Core's
	// `/api/mail/*` orchestration. Host-direct (the monitors pattern): the host holds
	// the node token and calls the existing `/api/mail/*` client (served by the
	// out-of-process `ryu-mail` sidecar). All optional so a non-mail host is
	// unaffected. ---

	/** Create an inbox (`POST /api/mail/inboxes`). Returns the created record. */
	mailCreate?(input: MailCreatePayload): Promise<MailInbox>;
	/** Delete an inbox + its history (`DELETE /api/mail/inboxes/:id`). */
	mailDelete?(input: { id: string }): Promise<void>;
	/** The inbox's inbound forwarder URL, built host-side from the node URL the
	 *  sandboxed frame cannot see (`${node.url}/api/mail/inbound/:id`). */
	mailInboundUrl?(input: { inboxId: string }): Promise<{ url: string }>;
	/** List all inboxes (`GET /api/mail/inboxes`). */
	mailList?(): Promise<MailInbox[]>;
	/** List the selected inbox's messages (`GET /api/mail/inboxes/:id/messages`). */
	mailMessages?(input: { inboxId: string }): Promise<MailMessage[]>;
	/** Rotate the inbound HMAC secret (`POST /api/mail/inboxes/:id/rotate-secret`).
	 *  Returns the new secret string. */
	mailRotateSecret?(input: { id: string }): Promise<string>;
	/** Send a message (`POST /api/mail/inboxes/:id/send`). Returns the stored record. */
	mailSend?(input: MailSendPayload): Promise<MailMessage>;
	/** Delete a meeting + its history (`DELETE /api/meetings/:id`). */
	meetingsDelete?(input: { id: string }): Promise<void>;
	/** Stop + summarize (`POST /api/meetings/:id/finalize`). Returns the updated record. */
	meetingsFinalize?(input: { id: string }): Promise<MeetingRecord>;
	/** Host-owned audio import: open the OS file dialog (WAV) + POST
	 *  `/api/meetings/import`. Resolves to the created meeting, or `null` if the user
	 *  cancelled the picker. */
	meetingsImport?(): Promise<MeetingRecord | null>;

	// --- Meetings (grant `meetings:crud`). The `@ryu/meetings` app renders the
	// record → live-transcript → AI-notes surface. Host-direct (the monitors pattern):
	// the host holds the node token and calls the existing `/api/meetings/*` client
	// (already gated on the `@ryu/meetings` enabled bit). `meetingsImport` is
	// host-owned (the host opens the OS file dialog + POSTs the multipart upload the
	// CSP-locked frame cannot); `meetingsOpen`/`meetingsOpenNotes`/`meetingsOpenList`
	// are shell-navigation verbs. All optional so a non-meetings host is unaffected. ---

	/** List all meetings (`GET /api/meetings`). */
	meetingsList?(): Promise<MeetingRecord[]>;
	/** Open a meeting's detail tab (`/meetings/:id`) — shell-navigation. */
	meetingsOpen?(input: { id: string; title?: string }): void;
	/** Open the Meetings record-start tab (`/meetings`) — shell-navigation. */
	meetingsOpenList?(): void;
	/** Open the finalized notes document in the Spaces editor
	 *  (`/spaces/:spaceId/doc/:docId`) — shell-navigation. */
	meetingsOpenNotes?(input: {
		spaceId: string;
		docId: string;
		title?: string;
	}): void;
	/** Rename a meeting (`POST /api/meetings/:id/title`). Returns the updated record. */
	meetingsRename?(input: { id: string; title: string }): Promise<MeetingRecord>;
	/** Set or clear a meeting glyph (`POST /api/meetings/:id/icon`). */
	meetingsSetIcon?(input: {
		id: string;
		icon: unknown | null;
	}): Promise<MeetingRecord>;
	/** Start a recording (`POST /api/meetings`). Returns the created meeting. */
	meetingsStart?(input: MeetingStartPayload): Promise<MeetingRecord>;
	/** Read a meeting's transcript (`GET /api/meetings/:id/transcript`). */
	meetingsTranscript?(input: { id: string }): Promise<MeetingTranscriptRecord>;

	// --- App host-bridge services (full-page Companion apps). Each is ONE governed
	// fetch to `POST /api/plugins/:id/host` (the host holds the node token). They map
	// 1:1 to the Core `PluginHookBridge` methods and share its grant vocabulary. All
	// optional so an inline widget host (which does not implement them) is unaffected. ---

	/** Tool-less one-shot completion (`host.sideModel`). Gateway-routed. */
	modelComplete?(input: {
		prompt: string;
		system?: string;
		model?: string;
		provider?: string;
		model_pref_key?: string;
		effort?: string;
	}): Promise<string>;

	// --- Website monitors (grant `monitors:crud`). The `@ryu/monitors` app drives
	// Core's `/api/monitors/*` orchestration. Unlike the bridge families, the host
	// calls the existing Core monitors API DIRECTLY (the media pattern: it holds the
	// node token; `/api/monitors/*` is already gated on the `@ryu/monitors` bit).
	// All optional so a non-monitors host is unaffected. ---

	/** List the selected monitor's recent alerts (`GET /api/monitors/:id/alerts`). */
	monitorsAlerts?(input: {
		id: string;
		limit?: number;
	}): Promise<MonitorAlert[]>;
	/** Create a monitor (`POST /api/monitors`). Returns the created record. */
	monitorsCreate?(input: MonitorInputPayload): Promise<MonitorRecord>;
	/** Delete a monitor + its history (`DELETE /api/monitors/:id`). */
	monitorsDelete?(input: { id: string }): Promise<void>;
	/** Read one monitor (`GET /api/monitors/:id`). */
	monitorsGet?(input: { id: string }): Promise<MonitorRecord>;
	/** List all monitors (`GET /api/monitors`). */
	monitorsList?(): Promise<MonitorRecord[]>;
	/** Run one check now (`POST /api/monitors/:id/run`). Returns the check status. */
	monitorsRun?(input: { id: string }): Promise<MonitorCheckStatus>;
	/** List the selected monitor's check snapshots (`GET /api/monitors/:id/snapshots`). */
	monitorsSnapshots?(input: {
		id: string;
		limit?: number;
	}): Promise<MonitorSnapshot[]>;
	/** Update a monitor (`PUT /api/monitors/:id`). Returns the updated record. */
	monitorsUpdate?(input: {
		id: string;
		input: MonitorInputPayload;
	}): Promise<MonitorRecord>;
	/** Acknowledge a HITL notify gate (`POST /api/notifications/:id/ack`); resolves to
	 *  whether the ack resumed the suspended workflow run. */
	notificationsAck?(input: { id: string }): Promise<boolean>;
	/** Resolve per-app icon tiles for the notification feed: `appId` → `{ name,
	 *  glyph (a CSP-safe `data:` URL), background }`, inlined by the host so the
	 *  sandboxed frame can render the SENDING app's icon on each row. */
	notificationsAppIcons?(input: {
		appIds: string[];
	}): Promise<Record<string, AppIconTile>>;
	/** Archive a notification (`POST /api/notifications/:id/archive`); also marks
	 *  it read. Idempotent. */
	notificationsArchive?(input: { id: string }): Promise<void>;
	/** List the signed-in user's inbox rows (`GET /api/notifications`; the host
	 *  resolves the user id). `archived: true` returns the archive instead of the
	 *  live inbox. */
	notificationsList?(input?: {
		archived?: boolean;
	}): Promise<NotificationRecord[]>;
	/** Mark a notification read (`POST /api/notifications/:id/read`). */
	notificationsMarkRead?(input: { id: string }): Promise<void>;
	/** Deliver a notification to one verified member in the node's org/team scope. */
	notificationsSend?(input: {
		body?: string;
		target_user_id: string;
		title: string;
	}): Promise<{ notification_id: string; target_user_id: string }>;
	/** Restore an archived notification (`POST /api/notifications/:id/unarchive`). */
	notificationsUnarchive?(input: { id: string }): Promise<void>;
	/** Report the widget's intrinsic content height so the host can size the frame
	 *  (capped by `maxHeight`). Fire-and-forget. */
	notifyHeight?(px: number): void;
	/** Open a URL OUTSIDE the widget (the user's real browser / desktop shell), never
	 *  in the sandboxed frame. The host MUST vet the href (http/https only) before
	 *  opening. Governed `window.openai.openExternal` impl. */
	openExternal?(input: { href: string }): Promise<void>;

	// --- Quests (grant `quests:crud`). The `@ryu/quests` app drives Core's
	// `/api/quests/*` auto-detecting-todo orchestration. Host-direct (the monitors
	// pattern): the host holds the node token and calls the existing `/api/quests/*`
	// API. All optional so a non-quests host is unaffected. ---

	/** Accept a detection suggestion (`POST /api/quests/:id/suggestion/accept`). */
	questsAcceptSuggestion?(input: { id: string }): Promise<QuestRecord>;
	/** Keep a captured selection / link / prompt / note (`POST /api/quests/capture`).
	 *  `body` is the only required field; the kind and the title are inferred from it
	 *  when absent. */
	questsCapture?(input: {
		body: string;
		kind?: string;
		title?: string;
		source?: { app?: string; title?: string; url?: string };
	}): Promise<QuestRecord>;
	/** Mark a quest done (`POST /api/quests/:id/complete`). */
	questsComplete?(input: { id: string }): Promise<QuestRecord>;
	/** Create a quest (`POST /api/quests`). Returns the created record. */
	questsCreate?(input: QuestInputPayload): Promise<QuestRecord>;
	/** Delete a quest + its history (`DELETE /api/quests/:id`). */
	questsDelete?(input: { id: string }): Promise<void>;
	/** Dismiss a quest without completing it (`POST /api/quests/:id/dismiss`). */
	questsDismiss?(input: { id: string }): Promise<QuestRecord>;
	/** Reject a detection suggestion (`POST /api/quests/:id/suggestion/dismiss`). */
	questsDismissSuggestion?(input: { id: string }): Promise<QuestRecord>;
	/** Ask Ryu to check a quest now (`POST /api/quests/:id/judge`). */
	questsJudge?(input: { id: string }): Promise<QuestJudgeResult>;
	/** List quests, optionally one kind (`GET /api/quests?kind=`). */
	questsList?(input?: { kind?: string }): Promise<QuestRecord[]>;
	/** Open the shell Settings dialog at the Quests (detection) tab. A pure shell-
	 *  navigation verb (no Core call); fire-and-forget from the frame's view. */
	questsOpenDetectionSettings?(): void;
	/** Pin or unpin an item (`POST /api/quests/:id/pin`). */
	questsPin?(input: { id: string; pinned?: boolean }): Promise<QuestRecord>;
	/** Read the freeform brain-dump buffer (`GET /api/quests/scratchpad`). */
	questsScratchpad?(): Promise<string>;
	/** Overwrite the brain-dump buffer (`PUT /api/quests/scratchpad`). */
	questsSetScratchpad?(input: { text: string }): Promise<void>;
	/** Update a quest (`PUT /api/quests/:id`). Returns the updated record. */
	questsUpdate?(input: {
		id: string;
		input: QuestInputPayload;
	}): Promise<QuestRecord>;
	/** Record that an item was copied back out, optionally checking it off
	 *  (`POST /api/quests/:id/use`). */
	questsUse?(input: { id: string; complete?: boolean }): Promise<QuestRecord>;
	/** Accept (or reject) the plugin's claim to render its own route. The concrete
	 *  implementation is pluginId-scoped (see {@link validatePluginRoute}); it must
	 *  reject any path that is not this plugin's own `/plugin/<id>` surface. */
	registerRoute(claim: RouteClaim): Promise<unknown>;
	/** Dismiss/close this widget instance (host unmounts or hides the frame). Governed
	 *  `window.openai.requestClose` impl. */
	requestClose?(): Promise<void>;
	/** Request a display mode change; the host decides and returns the applied mode
	 *  (spec §1.3, R6 — `"inline"|"fullscreen"|"pip"`). */
	requestDisplayMode?(input: { mode: string }): Promise<{ mode: string }>;
	/** Open the widget as a modal. Ryu has no modal-template surface, so the host
	 *  maps this to fullscreen — but the requested `template` IS threaded through
	 *  here (not dropped at arg-narrowing) so the host can record/act on it. */
	requestModal?(input: { template?: unknown }): Promise<{ mode: string }>;
	/** Spawn ONE full tool-using sub-agent with a clean context and return its final
	 *  text (`host.runAgent`, via the delegation engine). Non-streaming in v1. */
	runAgent?(input: {
		task: string;
		agent_id?: string;
		preset?: string;
		wall_time_secs?: number;
		max_tokens?: number;
	}): Promise<string>;
	/** Streaming variant of {@link runAgent}: run the sub-agent and deliver its reply
	 *  token-by-token via `emit`. Resolves when the turn ends; rejects on error.
	 *  `signal` aborts the underlying request when the frame cancels. */
	runAgentStream?(
		input: {
			task: string;
			agent_id?: string;
			preset?: string;
			wall_time_secs?: number;
			max_tokens?: number;
		},
		emit: (delta: string) => void,
		signal: AbortSignal
	): Promise<void>;
	/** Search GIFs (Core `/api/gifs/search`). Host inlines preview + full clip to
	 *  `data:` URLs so the frame can render/insert them under the CSP. */
	searchGifs?(input: { query: string }): Promise<{
		configured: boolean;
		results: {
			id: string;
			title: string;
			preview: string;
			url: string;
			width: number;
			height: number;
		}[];
	}>;
	/** Governed follow-up: `POST /api/widgets/follow-up`. Injects a
	 *  widget-attributed user turn on the owning conversation (R4/D5). */
	sendFollowUpMessage?(input: { prompt: string }): Promise<void>;
	/** Persist widget state (client Zustand + best-effort `POST /api/widgets/state`,
	 *  D4). Keyed by `toolCallId` inside the host. */
	setWidgetState?(state: unknown): Promise<void>;
	/** Subscribe to the node event stream, filtered to `input.channels` (a subset of the
	 *  host's known channels). Each event emits a JSON `{ channel, data }`; resolves when
	 *  `signal` aborts. */
	shellEventsSubscribe?(
		input: Record<string, unknown>,
		emit: (delta: string) => void,
		signal: AbortSignal
	): Promise<void>;

	// --- Shell primitives (grant `shell:integrate`). The generic `window.ryu.shell.*`
	// lane a DECOUPLED companion uses for shell integration. The host owns the tabs /
	// theme / palette / tab-icon / event-stream seams (no Core fetch). `shellOpenTab` is unary and
	// MUST validate `path` against the host's safe-route allowlist before navigating
	// (a granted plugin can still only open a first-party destination — the anti-phishing
	// gate). The subscribe/register verbs are STREAMING (dispatched by
	// `ExtensionHost`'s streaming path, torn down on frame unmount): each attaches its
	// listener and releases it when `signal` aborts. All optional so a non-shell host is
	// unaffected. ---

	/** Open a shell tab at an ALLOWLISTED route, forwarding `openTab` options
	 *  (`title`/`conversationId`/`forceNew`/`initialPrompt`/`icon`). Rejects (`denied`) any
	 *  path not on the host's safe-route allowlist or the caller's own `/plugin/<id>`. */
	shellOpenTab?(input: {
		path: string;
		title?: string;
		conversationId?: string;
		forceNew?: boolean;
		initialPrompt?: string;
		/** Entity glyph (same GlyphValue shape the sidebar uses). */
		icon?: unknown;
	}): Promise<void>;
	/** Subscribe to the host's LIVE display preferences. Emits the current set now and
	 *  again on every change (each `emit` is a JSON object; today `{ friendly: boolean }`
	 *  — the app-wide "Friendly names" toggle); resolves when `signal` aborts (frame
	 *  unmount / dispose).
	 *
	 *  Deliberately an OBJECT rather than a bare boolean, and named for the category
	 *  rather than the field: a future display preference is one more key that an
	 *  older plugin ignores, instead of another verb through the contract, the
	 *  capability table, the dispatch switch and the frame bridge. */
	shellPrefsSubscribe?(
		input: Record<string, unknown>,
		emit: (delta: string) => void,
		signal: AbortSignal
	): Promise<void>;
	/** Contribute Cmd+K palette commands. `input.commands` is `{ id, title, group?,
	 *  keywords? }[]`; each invocation emits the invoked command id (a JSON string) back
	 *  to the frame. The commands are removed from the palette when `signal` aborts. */
	shellRegisterCommand?(
		input: Record<string, unknown>,
		emit: (delta: string) => void,
		signal: AbortSignal
	): Promise<void>;
	/** Register default title-bar tab icons for path prefixes. `input.icons` is
	 *  `{ pathPrefix, pathIncludes?, icon }[]` — `icon` is an Iconify/Hugeicons id
	 *  (same vocabulary as companion / sidebar contribution icons). Rules are removed
	 *  when `signal` aborts (frame unmount). */
	shellRegisterTabIcon?(
		input: Record<string, unknown>,
		emit: (delta: string) => void,
		signal: AbortSignal
	): Promise<void>;
	/** Subscribe to the host's LIVE resolved theme tokens. Emits the current token map
	 *  now and again on every theme change (each `emit` is a JSON `Record<string,string>`);
	 *  resolves when `signal` aborts (frame unmount / dispose). */
	shellThemeSubscribe?(
		input: Record<string, unknown>,
		emit: (delta: string) => void,
		signal: AbortSignal
	): Promise<void>;
	/** Create a user-authored skill (`POST /api/skills`). Rejects (409) on a name
	 *  collision. Returns `{ id, source }`. */
	skillsCreate?(input: SkillDraftPayload): Promise<SkillWriteRecord>;

	// --- Skill authoring (grant `skills:crud`). The `@ryu/skill-editor` app authors a
	// user-owned Agent Skill (`SKILL.md`). Host-direct (the monitors pattern): the host
	// holds the node token and calls the existing `/api/skills` authoring endpoints via the
	// desktop `skills.ts` client (which normalizes Core's snake_case to camelCase), so the
	// returned records are camelCase. `skillsSetTitle` is a shell-navigation verb (renames
	// the owning tab). All optional so a non-skills host is unaffected. ---

	/** Fetch a skill's editable source (`GET /api/skills/:id/source`). */
	skillsGetSource?(input: { id: string }): Promise<SkillSourceRecord>;
	/** List a skill's saved versions (`GET /api/skills/:id/versions`), newest first. */
	skillsListVersions?(input: { id: string }): Promise<SkillVersionRecord[]>;
	/** Restore a version as the current SKILL.md (`POST …/versions/:vid/restore`). */
	skillsRestore?(input: { id: string; versionId: string }): Promise<void>;
	/** Open the shared agent-target distribution flow for an installed skill. */
	skillsDistribute?(input: { id: string }): Promise<void>;
	/** Rename the owning tab (the desktop page's `updateTabTitle`) — shell-navigation. */
	skillsSetTitle?(input: { title: string }): void;
	/** Snapshot the current SKILL.md as a new version (`POST /api/skills/:id/versions`). */
	skillsSnapshot?(input: { id: string; label?: string }): Promise<void>;
	/** Update a skill's SKILL.md (`PUT /api/skills/:id`, autosave). Returns `{ id, source }`. */
	skillsUpdate?(
		input: { id: string } & SkillDraftPayload
	): Promise<SkillWriteRecord>;
	/** Fetch one version's captured raw SKILL.md source (`GET …/versions/:vid`). */
	skillsVersionSource?(input: {
		id: string;
		versionId: string;
	}): Promise<string>;

	// --- Outpost (grant `social:crud`). The `@ryu/social` app renders the compose →
	// calendar → queue → inbox surface. Host-direct (the monitors pattern) through ONE
	// forwarder: the host holds the node token and re-issues `socialRequest` against
	// Core's `/api/social<path>` public mount, so the sidecar's 33 routes need no
	// per-route service. `socialOpen`/`socialOpenList` are shell-navigation verbs. All
	// optional so a non-Outpost host is unaffected. ---

	/** Open a scheduled post's detail tab (`/social/:postId`), or the Outpost tab when
	 *  no id is given — shell-navigation. */
	socialOpen?(input: { postId?: string; title?: string }): void;
	/** Open the Outpost tab (`/social`) — shell-navigation. */
	socialOpenList?(): void;
	/** Forward one call to `/api/social<path>`. Resolves with the parsed JSON body and
	 *  REJECTS on any non-2xx, so the frame uses try/catch rather than a status check.
	 *  The host validates `path` (see {@link SocialRequestPayload}) before building the
	 *  URL; it never accepts a host or an absolute URL from the frame. */
	socialRequest?(input: SocialRequestPayload): Promise<unknown>;

	// --- Subtitles (grant `subtitles:crud`). The `@ryu/subtitles` app picks a video and
	// watches a local transcription + translation job. Host-direct through ONE
	// forwarder, the Outpost shape, with no navigation verb — the companion is the whole
	// surface. Optional so a host without the app is unaffected. ---

	/** Forward one call to `/api/subtitles<path>`. Resolves with the parsed JSON body —
	 *  or, for `/jobs/:id/download`, the subtitle file's TEXT, since that response is not
	 *  JSON — and REJECTS on any non-2xx, so the frame uses try/catch rather than a
	 *  status check. The host validates `path` (see {@link SubtitlesRequestPayload})
	 *  before building the URL; it never accepts a host or an absolute URL from the
	 *  frame. */
	subtitlesRequest?(input: SubtitlesRequestPayload): Promise<unknown>;

	// --- Automated Reasoning (grant `reasoning:check`). The `@ryu/reasoning` app
	// authors formal policies and runs the solver playground. Host-direct through ONE
	// forwarder, the Outpost shape: the sidecar's seven routes need no per-route
	// service, and a route added to the manifest later needs no host change at all.
	// Optional, so a host without the app is unaffected. ---

	/** Forward one call to `/api/reasoning<path>`. Resolves with the parsed JSON body
	 *  and REJECTS on any non-2xx, so the frame uses try/catch rather than a status
	 *  check. The host validates `path` (see {@link ReasoningRequestPayload}) before
	 *  building the URL; it never accepts a host or an absolute URL from the frame. */
	reasoningRequest?(input: ReasoningRequestPayload): Promise<unknown>;
	/** Forward one capability-gated call to Core's fixed Safe Actions mount. */
	safeActionsRequest?(input: SafeActionsRequestPayload): Promise<unknown>;

	// --- Deep Read (grant `rlm:query`). The `@ryu/rlm` app loads a corpus, browses
	// its outline and asks questions of it. Host-direct through ONE forwarder, the
	// same shape as Reasoning above: the sidecar's ten routes need no per-route
	// service, and a route added to the manifest later needs no host change at all.
	// Optional, so a host without the app is unaffected. ---

	/** Forward one call to `/api/rlm<path>`. Resolves with the parsed JSON body and
	 *  REJECTS on any non-2xx, so the frame uses try/catch rather than a status check.
	 *  The host validates `path` (see {@link RlmRequestPayload}) before building the
	 *  URL; it never accepts a host or an absolute URL from the frame. */
	rlmRequest?(input: RlmRequestPayload): Promise<unknown>;

	// --- Tuition (grant `tuition:crud`) and Wire (grant `news:crud`). Both are
	// host-direct through ONE forwarder, the same shape as Reasoning above: the
	// sidecars' twenty-four and nineteen routes need no per-route service, and a route
	// added to either manifest later needs no host change at all. Optional, so a host
	// without the app is unaffected. ---

	/** Forward one call to `/api/tuition<path>`. Resolves with the parsed JSON body and
	 *  REJECTS on any non-2xx, so the frame uses try/catch rather than a status check.
	 *  The host validates `path` (see {@link TuitionRequestPayload}) before building the
	 *  URL; it never accepts a host or an absolute URL from the frame. */
	tuitionRequest?(input: TuitionRequestPayload): Promise<unknown>;

	/** Forward one call to `/api/news<path>`. Same contract as {@link tuitionRequest}. */
	newsRequest?(input: NewsRequestPayload): Promise<unknown>;

	// --- Visual plan review (grant `blueprint:review`). The `@ryu/blueprint` app
	// renders a published plan and records the reviewer's annotations and verdict.
	// Host-direct through ONE forwarder, the same shape as Reasoning above: eleven
	// sidecar routes need no per-route service, and the round-two routes (revision
	// diff view, artifact review) will need no host change at all. Optional, so a host
	// without the app is unaffected. ---

	/** Forward one call to `/api/blueprint<path>`. Resolves with the parsed JSON body
	 *  and REJECTS on any non-2xx, so the frame uses try/catch rather than a status
	 *  check. The host validates `path` (see {@link BlueprintRequestPayload}) before
	 *  building the URL; it never accepts a host or an absolute URL from the frame. */
	blueprintRequest?(input: BlueprintRequestPayload): Promise<unknown>;

	// --- Spaces documents (grant `spaces:docs`). An app owns documents of kind
	// `app:<plugin_id>` — persisted in the Space, search-embedded, backlinked. `source`
	// is a string (JSON.stringify structured content yourself, e.g. a scene). ---

	/** Resolve or create a user-owned Space by name. */
	spacesEnsureSpace?(input: {
		name: string;
		description?: string | null;
	}): Promise<string>;
	/** Search a Space through Core's semantic retrieval endpoint. */
	spacesSearch?(input: {
		space_id: string;
		query: string;
		limit?: number;
	}): Promise<
		{
			chunk_id: string;
			content: string;
			distance: number;
			document_id: string;
		}[]
	>;

	/** Create an empty app-owned document in `space_id`; returns its doc id. */
	spacesCreateDoc?(input: { space_id: string; title: string }): Promise<string>;
	/** Delete an app-owned document (and its links/versions). */
	spacesDeleteDoc?(input: { doc_id: string }): Promise<void>;
	/** Read an app-owned document (null if missing / not this app's). */
	spacesGetDoc?(input: { doc_id: string }): Promise<{
		id: string;
		title: string;
		source: string;
		kind: string;
	} | null>;
	/** List this app's documents in a space (newest first). */
	spacesListDocs?(input: {
		space_id: string;
	}): Promise<{ id: string; title: string; updated_at: number }[]>;
	/** Persist an app-owned document's `source` (+ optional `title`); triggers
	 *  search re-embedding and backlink re-resolution. */
	spacesUpdateDoc?(input: {
		doc_id: string;
		title?: string;
		source: string;
	}): Promise<void>;
	/** Seal a string under this app's own key (`host.crypto_seal`, grant
	 *  `crypto:seal`). Returns an opaque envelope to hand to `storageSet` or any
	 *  other sink. The key is derived by Core per app and never reaches the frame,
	 *  so this is the ONLY way an app gets encryption — there is no key accessor. */
	cryptoSeal?(input: { value: string }): Promise<string>;
	/** Open a value this app sealed (`host.crypto_open`). Rejects another app's
	 *  ciphertext (different key, AEAD tag failure) and passes through values that
	 *  were never sealed, so a store can be migrated in place. */
	cryptoOpen?(input: { value: string }): Promise<string>;
	/** Which key custody is live (`host.crypto_status`) — keychain vs a key file
	 *  next to the data. Carries no key material; let an app tell the user what
	 *  its sealed data is actually worth before storing anything sensitive. */
	cryptoStatus?(): Promise<CryptoStatus>;
	/** Delete a durable KV value (`host.storage_delete`). */
	storageDelete?(input: { namespace?: string; key: string }): Promise<void>;
	/** Read the app's own durable KV value (`host.storage_get`). `null` when unset. */
	storageGet?(input: {
		namespace?: string;
		key: string;
	}): Promise<string | null>;
	/** List the keys the app has set in a namespace, newest first (`host.storage_keys`). */
	storageKeys?(input: { namespace?: string }): Promise<string[]>;
	/** Atomically replace or delete a value when it still equals `expected`. */
	storageCompareAndSet?(input: {
		namespace?: string;
		key: string;
		expected?: string | null;
		value?: string | null;
	}): Promise<boolean>;
	/** Upsert a durable KV value (`host.storage_set`). `value` MUST be a string. */
	storageSet?(input: {
		namespace?: string;
		key: string;
		value: string;
	}): Promise<void>;
	/** Post thumbs/dismiss feedback for a suggestion type (`POST /api/feedback`). */
	suggestionsFeedback?(input: SuggestionFeedbackPayload): Promise<boolean>;
	/** List Shadow's proactive suggestion inbox (`GET /proactive`; drops filtered). */
	suggestionsList?(): Promise<ProactiveSuggestionRecord[]>;
	/** Open the shell chat tab prefilled with a suggestion body (host navigation). */
	suggestionsOpenInChat?(input: { prompt: string }): void;
	/** The nearest keyframe at `tsMicros` as a `data:` URL (host-fetched from Shadow's
	 *  `/frame`, base64-encoded so the CSP-locked frame can render it under `img-src
	 *  data: blob:`), or `null` when no frame exists near that moment. */
	timelineFrame?(input: { tsMicros: number }): Promise<string | null>;
	/** Shadow `GET /journal` (the derived Dayflow work journal) for the same range;
	 *  `narrate` runs the LLM title/summary polish pass. `null` when unreachable. */
	timelineJournal?(input: {
		rangeMinutes: number;
		narrate?: boolean;
	}): Promise<TimelineJournalRecord | null>;

	// --- Timeline (grant `timeline:read`). The `@ryu/timeline` app renders the
	// activity replay scrubber. Host-direct but device-LOCAL: the host calls Shadow
	// (127.0.0.1:3030) WITHOUT a node token — the `shadow.ts` INVARIANT (captured
	// screen/input only has meaning on the physical machine). All optional so a
	// non-timeline host is unaffected. ---

	/** Shadow `GET /timeline` for the last `rangeMinutes`, ascending by ts; `null`
	 *  when Shadow (:3030) is unreachable (recording off). */
	timelineList?(input: {
		rangeMinutes: number;
	}): Promise<TimelineEventRecord[] | null>;
	/** Open the Weekly Review tab — a shell-navigation verb (the desktop page's
	 *  `navigate("/review")`); fire-and-forget from the frame's view. */
	timelineOpenReview?(): void;
	/** Open Settings — a shell-navigation verb (the recording-off empty state's
	 *  `navigate("/settings")`); fire-and-forget from the frame's view. */
	timelineOpenSettings?(): void;
	/** Transcribe an audio `data:` URL (`/api/voice/transcribe`). Returns the text. */
	transcribeAudio?(input: {
		audio: string;
		filename?: string;
	}): Promise<string>;
	/** Synthesize speech (`/api/voice/speak`). Returns a `data:` audio URL. */
	ttsSpeak?(input: {
		text: string;
		engine?: string;
		voice?: string;
		speed?: number;
		language?: string;
	}): Promise<string>;
	/**
	 * Open a native file picker, upload selected file(s) into the Uploads system
	 * space, and return metadata + a `data:` URL (CSP-safe for sandboxed frames).
	 * Returns `null` when the user cancels. With `multiple: true`, returns an array.
	 */
	uploadFile?(input?: {
		accept?: string;
		multiple?: boolean;
	}): Promise<UploadFileResult | UploadFileResult[] | null>;

	// --- Warmup (grant `warmup:crud`). The `@ryu/warmup` app keeps subscription
	// usage windows open. Host-direct (the monitors pattern): the host holds the node
	// token and calls `/api/agents`, `/api/agents/:id/usage`,
	// `/api/agents/:id/acp-config` and `/heartbeat/jobs`. All optional so a host
	// without Warmup is unaffected. ---

	/** Replace this app's scheduled jobs with exactly `jobs` (delete-then-create,
	 *  since Core has no update route). Rejects with Core's validation message. */
	warmupApply?(jobs: WarmupJobInput[]): Promise<void>;
	/** Subscription agents with their usage windows + advertised models, and the
	 *  node's IANA zone. */
	warmupDetect?(): Promise<WarmupDetectionRecord>;
	/** List scheduled jobs (`GET /heartbeat/jobs`) so the app can find its own. */
	warmupList?(): Promise<CalendarJobRecord[]>;
	/** Run one of this app's scheduled pings now. Resolves when the turn completes;
	 *  rejects with Core's message when the job itself failed. */
	warmupRunNow?(input: WarmupRunNowPayload): Promise<void>;

	// --- Inbound webhook registry + protected secret management
	// (grant `webhooks:crud`). The `@ryu/webhooks` app renders Core's registry from
	// its sandboxed companion. Host-direct (the monitors pattern): the host holds
	// the node token; secret values use explicit get/set calls and never ride the
	// metadata registry response. All optional so a non-webhooks host is unaffected. ---

	/** The resolved ingress backend + public URL (`GET /api/webhook-ingress/status`). */
	webhooksIngressStatus?(): Promise<unknown>;
	/** The unified webhook endpoint registry (`GET /api/webhooks`). */
	webhooksList?(): Promise<unknown>;
	/** Read one secret through the explicit protected route (`GET /api/webhooks/:id/secret`). */
	webhooksSecretGet?(input: { id: string }): Promise<unknown>;
	/** Set or generate one secret (`POST /api/webhooks/:id/secret`). */
	webhooksSecretSet?(input: { id: string; secret?: string }): Promise<unknown>;
	/** Node-config picker: agents on the node (`GET /api/agents`). */
	workflowsAgents?(): Promise<unknown>;
	/** Node-config picker: installed apps + their runnables (`GET /api/plugins`). */
	workflowsApps?(): Promise<unknown>;
	/** Composio catalog for the trigger picker (`GET /api/composio/*`). One method,
	 *  keyed by `kind`, so one bridge verb covers status/toolkits/triggers/connections. */
	workflowsComposio?(input: {
		kind: "status" | "toolkits" | "triggers" | "connections";
		toolkit?: string;
	}): Promise<unknown>;
	/** Delete a workflow (`DELETE /workflows/:id`). */
	workflowsDelete?(input: { id: string }): Promise<void>;
	/** Read one workflow definition (`GET /workflows/:id`). */
	workflowsGet?(input: { id: string }): Promise<unknown>;
	/** Node-config picker: every app event an enabled app declares in its manifest
	 *  `contributes.hook_events` (`GET /api/plugins/contributions` → `hook_events`).
	 *  Backs the `event` trigger's picker, so a user chooses a real event instead of
	 *  typing a fully-qualified id from memory. */
	workflowsHookEvents?(): Promise<unknown>;
	/** List all workflows (`GET /workflows`). */
	workflowsList?(): Promise<unknown>;
	/** Node-config picker: MCP servers + their tools (`GET /api/mcp/*`). */
	workflowsMcp?(): Promise<unknown>;
	/** Resume a run suspended at an Awakeable gate (`POST /workflows/runs/:runId/resume`). */
	workflowsResume?(input: { runId: string; payload: string }): Promise<unknown>;
	/** Run or dry-run a workflow (`POST /workflows/:id/run`). Returns the run
	 * record; dry runs are transient and read-only. */
	workflowsRun?(input: {
		dryRun?: boolean;
		id: string;
		input?: Record<string, string>;
	}): Promise<unknown>;
	/** Poll a run's current state (`GET /workflows/runs/:runId`). */
	workflowsRunGet?(input: { runId: string }): Promise<unknown>;
	/** Upsert a workflow definition (`POST /workflows`). Core validates the DAG. */
	workflowsSave?(input: Record<string, unknown>): Promise<unknown>;
	/** Node-config picker: schedules/jobs (`GET /api/schedules/jobs`). */
	workflowsSchedules?(): Promise<unknown>;
	/** Node-config picker: verified organization members for NotifyUser steps
	 *  (`GET /api/notifications/mention-targets`). */
	workflowsNotifyTargets?(): Promise<unknown>;
	/** Node-config picker: installed skills (`GET /api/skills`). */
	workflowsSkills?(): Promise<unknown>;
	/** Fetch one workflow template's detail (`GET /api/workflows/catalog/:id`). */
	workflowsTemplateGet?(input: { id: string }): Promise<unknown>;
	/** Install a workflow template (`POST /api/workflows/catalog/install`). Returns
	 *  the minted primary workflow id. */
	workflowsTemplateInstall?(input: { templateId: string }): Promise<string>;
	/** Browse the workflow-template catalog (`GET /api/workflows/catalog`). */
	workflowsTemplatesList?(): Promise<unknown>;
	/** Snapshot the workflow as a new version (`POST /workflows/:id/versions`). */
	workflowsVersionCreate?(input: { id: string; label?: string }): Promise<void>;
	/** Read one version's captured definition (`GET /workflows/:id/versions/:vid`). */
	workflowsVersionGet?(input: {
		id: string;
		versionId: string;
	}): Promise<unknown>;
	/** Restore a version as the current definition (`POST …/versions/:vid/restore`). */
	workflowsVersionRestore?(input: {
		id: string;
		versionId: string;
	}): Promise<unknown>;
	/** List a workflow's saved versions (`GET /workflows/:id/versions`). */
	workflowsVersionsList?(input: { id: string }): Promise<unknown>;
	/** The workflow's inbound webhook URL for display (`GET /api/workflows/:id/webhook`). */
	workflowsWebhook?(input: { id: string }): Promise<unknown>;
}

/**
 * The single source of truth for the host↔plugin method vocabulary: the
 * `ryu-kernel-contracts` host-API table, blessed to
 * `crates/ryu-kernel-contracts/schemas/host-api.json` and imported above. The
 * three maps below (`METHOD_CAPABILITY`, `GRANT_CAPABILITY`, `STREAMING_METHODS`)
 * are DERIVED from it so this host and Core's Rust bridge (`plugin_bridge_api.rs`
 * `required_grant_for`) can never drift. Regenerate the JSON with
 * `RYU_REGEN_SCHEMAS=1 cargo test -p ryu-kernel-contracts`; `rpc-tables.test.ts`
 * pins the derived shapes to the historical hand-written tables. Rows with
 * `tsHost === false` (e.g. `view.action`, a Rust-bridge-only relay) are NOT
 * dispatched by this host, so they are skipped.
 */
interface HostApiMethodEntry {
	readonly capability: string;
	readonly grant: string | null;
	readonly method: string;
	readonly streaming: boolean;
	readonly tsHost: boolean;
}

/** The host-API contract version, echoed in the `ryu-plugin-ready` handshake as
 *  `hostApiVersion` (see {@link ExtensionHost}). */
export const HOST_API_VERSION: string = hostApiContract.version;

/** How long a frame keeps re-announcing `ryu-plugin-ready`, and how often. */
const HANDSHAKE_RETRY_MS = 200;
const HANDSHAKE_RETRY_WINDOW_MS = 20_000;

/**
 * The ES5 snippet every sandboxed frame ends with: announce `ryu-plugin-ready`,
 * then KEEP announcing until the host's port arrives.
 *
 * The single-shot announce this replaces was a silent, unrecoverable failure. The
 * frame posts during head parse, and the host attaches its `message` listener from
 * a React passive effect — which React flushes in a *scheduler task*, not
 * synchronously at commit. The iframe's own load task can win that race (more
 * easily the busier the shell is at mount). When it does, the one announce is
 * dispatched to a window with no listener yet, is dropped, and nothing ever
 * re-sends it: the host sits on "starting…" forever and the frame stays blank,
 * because Path A only evaluates the plugin bundle *after* the port lands.
 *
 * Re-announcing costs one postMessage per tick and is safe by construction: the
 * frame stops as soon as it holds a port, and the host refuses every announce
 * after the first anyway (`alreadyConnected` in `shouldTransferPort`), so a
 * duplicate can never mint a second channel. The window is bounded so a frame the
 * host has genuinely abandoned does not tick forever.
 *
 * Expects a `port` variable in scope (the frame's channel port, null until the
 * handshake completes) — both builders declare one.
 */
export function handshakeAnnounceScript(): string {
	return `
    function ryuAnnounceReady() {
      window.parent.postMessage({ kind: "ryu-plugin-ready", nonce: NONCE, hostApiVersion: ${JSON.stringify(HOST_API_VERSION)} }, "*");
    }
    ryuAnnounceReady();
    var ryuReadyTimer = setInterval(function () {
      if (port) { clearInterval(ryuReadyTimer); return; }
      ryuAnnounceReady();
    }, ${HANDSHAKE_RETRY_MS});
    setTimeout(function () { clearInterval(ryuReadyTimer); }, ${HANDSHAKE_RETRY_WINDOW_MS});`;
}

const HOST_API_METHODS =
	hostApiContract.methods as readonly HostApiMethodEntry[];

const methodCapability: Record<string, Capability> = {};
const grantCapability: Record<string, Capability> = {};
const streamingMethods = new Set<string>();
for (const entry of HOST_API_METHODS) {
	// A Rust-bridge-only method (`tsHost === false`) is not part of this host's
	// dispatch surface; skipping it keeps its capability out of the TS tables.
	if (!entry.tsHost) {
		continue;
	}
	const capability = entry.capability as Capability;
	methodCapability[entry.method] = capability;
	if (entry.streaming) {
		streamingMethods.add(entry.method);
	}
	// A grant of `null` marks a LOCAL host cap (`widget.state` / `ui.displayMode`)
	// granted on mount, never Gateway-sourced — no GRANT_CAPABILITY entry.
	if (entry.grant) {
		grantCapability[entry.grant] = capability;
	}
}

/** The capability each callable method requires. A method absent from this map is
 *  UNKNOWN and always rejected (never default-allow). Derived from the blessed
 *  host-API table (see above). */
export const METHOD_CAPABILITY: Record<string, Capability> = methodCapability;

/** Methods handled by the streaming dispatch path (emit many chunks, then one
 *  terminal result) rather than the unary {@link dispatchRpc}. Derived from the
 *  `streaming` flag on the host-API table. */
export const STREAMING_METHODS: ReadonlySet<string> = streamingMethods;

/** Fixed map from a manifest grant STRING (the plugin's declared claim, but only
 *  ever read here from the GATEWAY-APPROVED subset — never the raw manifest
 *  claim) to the host {@link Capability} it unlocks. A grant string absent from
 *  this table maps to nothing and is dropped (default-deny). Derived from the
 *  blessed host-API table — the EXACT grant strings the Core `PluginHookBridge`
 *  gates on, one vocabulary across the desktop gate and the server gate. */
export const GRANT_CAPABILITY: Record<string, Capability> = grantCapability;

/** Local host capabilities are intentionally available only through their
 * explicit contract rows; they are never inferred from plugin grants. */
const LOCAL_HOST_CAPABILITIES: ReadonlySet<Capability> = new Set([
	"host.capabilities",
	"node.shareOrigins",
]);

/** Capabilities whose ungranted call throws a STRUCTURED {@link CodedRpcError}
 *  (`denied`) instead of the legacy plain-string {@link CapabilityError}. Only the
 *  greenfield app host-bridge methods opt in; the legacy paths keep string errors so
 *  their existing readers are unaffected. */
const CODED_ERROR_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
	"ui.toast",
	"app.http",
	"app.realtime",
	"model.complete",
	"agent.run",
	"storage.kv",
	"spaces.docs",
	"media.generate",
	"media.transcribe",
	"finetune.runs",
	"monitors.crud",
	"workflows.crud",
	"workflows.runstate",
	"workflows.catalogs",
	"ghost.record",
	"webhooks.crud",
	"quests.crud",
	// Capture is a SEPARATE capability from board CRUD: it carries text the user
	// selected in another app, which is a wider reach than editing a todo.
	"quests.capture",
	"activity.read",
	"chat.broadcast",
	"background.control",
	"mail.crud",
	"calendar.crud",
	"learning.crud",
	"approvals.crud",
	"notifications.send",
	"meetings.crud",
	"social.crud",
	"subtitles.crud",
	"skills.crud",
	"reasoning.check",
	"safe-actions.manage",
	"rlm.query",
	"blueprint.review",
	"tuition.crud",
	"news.crud",
]);

/**
 * Map a set of GATEWAY-APPROVED grant strings to the host capabilities they
 * unlock, dropping any grant that is not in {@link GRANT_CAPABILITY}.
 *
 * CRITICAL (invariant #3): the caller MUST pass the plugin's `approved_grants`
 * (the Gateway-validated subset persisted by `enable_app`), NOT the manifest's
 * `permission_grants` (an unvalidated CLAIM). Passing an empty/failed list here
 * yields an EMPTY capability set — deny-all — so a failed grants fetch can never
 * become a grant-escalation path.
 */
export function capabilitiesFromGrants(
	approvedGrants: readonly string[]
): Set<Capability> {
	const caps = new Set<Capability>();
	for (const grant of approvedGrants) {
		const cap = GRANT_CAPABILITY[grant];
		if (cap) {
			caps.add(cap);
		}
	}
	return caps;
}

/**
 * The anti-phishing gate (invariant #6). A plugin may claim ONLY its own,
 * namespaced surface: the exact path `/plugin/<pluginId>`. Every other path —
 * a system route (`/agents`, `/settings`), another plugin's route
 * (`/plugin/other`), or a nested/relative variant — is rejected. The `title` may
 * not impersonate system chrome (contain "ryu" or "system"), so a plugin cannot
 * pose as first-party UI in the tab label.
 *
 * Pure so the `system_route_impersonation_rejected` adversarial test can assert
 * it directly, and so the host `registerRoute` service is a one-line call.
 */
export function validatePluginRoute(
	pluginId: string,
	claim: RouteClaim
): boolean {
	if (typeof claim.path !== "string" || typeof claim.title !== "string") {
		return false;
	}
	// The one legal surface: this plugin's own exact route. `encodeURIComponent`
	// mirrors `pluginCompanionPath` so a claim matches the route the shell mints.
	const ownPath = `/plugin/${encodeURIComponent(pluginId)}`;
	if (claim.path !== ownPath) {
		return false;
	}
	const lowerTitle = claim.title.toLowerCase();
	if (lowerTitle.includes("ryu") || lowerTitle.includes("system")) {
		return false;
	}
	return true;
}

/** The safe first-party route PREFIXES a `shell.openTab` call (grant
 *  `shell:integrate`) may target. Even a GRANTED companion can only open a known
 *  shell destination — the anti-phishing gate layered ON TOP of the grant, the
 *  sibling of {@link validatePluginRoute} (a raw `openTab(anyPath)` would break the
 *  `/plugin/<id>`-only frame containment). See `docs/renderer-host-slice-1.md`. */
export const SHELL_SAFE_ROUTE_PREFIXES = [
	"/chat",
	"/library",
	"/review",
	"/settings",
	"/meetings",
	"/spaces",
] as const;

/**
 * Whether `path` is a shell destination a granted companion may open via
 * `shell.openTab`: an exact or CHILD match of an allowlisted prefix
 * ({@link SHELL_SAFE_ROUTE_PREFIXES}), or the companion's own `/plugin/<id>` surface
 * (`ownPluginPath`, which the host service supplies from `companion.pluginId`).
 *
 * Pure — extracted here (the `validatePluginRoute` precedent) so the anti-phishing
 * allowlist is unit-testable DOM-free. The `${prefix}/` child guard rejects a
 * prefix-collision like `/chatfoo`; another plugin's `/plugin/<other>` is rejected
 * because only THIS plugin's `ownPluginPath` is passed.
 */
export function isShellSafeRoute(path: string, ownPluginPath: string): boolean {
	if (typeof path !== "string" || !path.startsWith("/")) {
		return false;
	}
	if (path === ownPluginPath || path.startsWith(`${ownPluginPath}/`)) {
		return true;
	}
	return SHELL_SAFE_ROUTE_PREFIXES.some(
		(prefix) => path === prefix || path.startsWith(`${prefix}/`)
	);
}

/** Thrown (and caught into an RpcResponse.error) when a call is not permitted.
 *  Serialized to a plain STRING error (the legacy plugin path shape). */
export class CapabilityError extends Error {}

/** A widget round-trip failure carrying a closed {@link WidgetRpcErrorCode}
 *  (decisions doc D6). Serialized by the host into a structured
 *  `{ code, message }` error, distinct from {@link CapabilityError}'s string. */
export class CodedRpcError extends Error {
	code: WidgetRpcErrorCode;
	constructor(code: WidgetRpcErrorCode, message: string) {
		super(message);
		this.code = code;
		this.name = "CodedRpcError";
	}
}

/**
 * Serialize a thrown error into the `error` field of an {@link RpcResponse}. A
 * {@link CodedRpcError} (or anything carrying a PUBLIC widget `code`) becomes the
 * structured `{ code, message }` a widget expects (D6). An unknown string code is
 * normalized to `server_error` instead of escaping the closed wire vocabulary.
 * Everything else — notably the legacy {@link CapabilityError} — stays a plain
 * string so the existing plugin bridge (which checks `typeof error === "string"`)
 * is unaffected.
 */
export function toRpcError(err: unknown): string | RpcErrorPayload {
	if (
		err &&
		typeof err === "object" &&
		"code" in err &&
		typeof err.code === "string"
	) {
		const message =
			"message" in err && typeof err.message === "string"
				? err.message
				: String(err);
		return {
			code: isWidgetRpcErrorCode(err.code) ? err.code : "server_error",
			message,
		};
	}
	return err instanceof Error ? err.message : String(err);
}

/**
 * Dispatch one RPC call against the host services, enforcing the capability gate.
 *
 * Resolves to the method result, or REJECTS (throws) when:
 *   - the method is unknown (not in {@link METHOD_CAPABILITY}), or
 *   - the method's capability is not in `granted` (ungranted call).
 *
 * Pure w.r.t. the DOM: the caller wraps the resolve/reject into an
 * {@link RpcResponse} and posts it back over the port. This separation is what
 * makes the gate unit-testable.
 */
/**
 * Assert that `method`'s capability is granted — the SAME gate {@link dispatchRpc}
 * applies, extracted so the streaming host path (which pushes many chunks and cannot
 * use `dispatchRpc`'s single-reply shape) enforces the identical grant check. Throws
 * a coded `denied` for the app host-bridge family, a legacy `CapabilityError` else.
 */
export function assertGranted(
	method: string,
	granted: ReadonlySet<Capability>
): void {
	const capability = METHOD_CAPABILITY[method];
	if (!capability) {
		throw new CapabilityError(`Unknown method: ${method}`);
	}
	if (!(granted.has(capability) || LOCAL_HOST_CAPABILITIES.has(capability))) {
		if (CODED_ERROR_CAPABILITIES.has(capability)) {
			throw new CodedRpcError(
				"denied",
				`Capability not granted: ${capability} (required by ${method})`
			);
		}
		throw new CapabilityError(
			`Capability not granted: ${capability} (required by ${method})`
		);
	}
}

export async function dispatchRpc(
	method: string,
	args: unknown[],
	granted: ReadonlySet<Capability>,
	services: HostServices
): Promise<unknown> {
	assertGranted(method, granted);
	switch (method) {
		case "host.capabilities":
			if (args.length !== 0) {
				throw new CapabilityError("host.capabilities takes no arguments");
			}
			return await (services.hostCapabilities?.() ??
				detectBrowserHostCapabilities());
		case "node.shareOrigins":
			if (args.length !== 0) {
				throw new CapabilityError("node.shareOrigins takes no arguments");
			}
			if (!services.nodeShareOrigins) {
				throw new CapabilityError("node.shareOrigins is not available");
			}
			return await services.nodeShareOrigins();
		case "native.haptics": {
			const input = asNativeHapticsInput(args[0]);
			if (!input || args.length !== 1) {
				throw new CodedRpcError(
					"invalid_args",
					"native.haptics requires { style: 'light'|'success'|'warning'|'error' }"
				);
			}
			return services.nativeHaptics
				? await services.nativeHaptics(input)
				: browserNativeHaptics(input);
		}
		case "native.notifications.create": {
			const input = asNativeNotificationInput(args[0]);
			if (!input || args.length !== 1) {
				throw new CodedRpcError(
					"invalid_args",
					`native.notifications.create requires bounded title (${NATIVE_ACTION_LIMITS.notificationTitleChars} chars max) and body (${NATIVE_ACTION_LIMITS.notificationBodyChars} chars max)`
				);
			}
			return services.nativeNotificationsCreate
				? await services.nativeNotificationsCreate(input)
				: await browserNativeNotification(input);
		}
		case "native.liveActivities.update": {
			const input = asNativeLiveActivityUpdateInput(args[0]);
			if (!input || args.length !== 1) {
				throw new CodedRpcError(
					"invalid_args",
					`native.liveActivities.update requires bounded conversationId, title (${NATIVE_ACTION_LIMITS.titleChars} chars max), detail (${NATIVE_ACTION_LIMITS.detailChars} chars max), and a known status`
				);
			}
			if (!services.nativeLiveActivitiesUpdate) {
				throw new CodedRpcError(
					"server_error",
					"native.liveActivities.update is unavailable on this host"
				);
			}
			return await services.nativeLiveActivitiesUpdate(input);
		}
		case "core.listAgents":
			// `args` is part of the envelope for methods that need it; listAgents
			// takes none. Asserting it lets the gate stay arity-agnostic per method.
			if (args.length !== 0) {
				throw new CapabilityError("core.listAgents takes no arguments");
			}
			if (!services.listAgents) {
				throw new CapabilityError("core.listAgents is not available");
			}
			return await services.listAgents();
		case "catalog.snapshot":
			if (args.length !== 0) {
				throw new CapabilityError("catalog.snapshot takes no arguments");
			}
			if (!services.catalogSnapshot) {
				throw new CapabilityError("catalog.snapshot is not available");
			}
			return await services.catalogSnapshot();
		case "catalog.models": {
			const input = asCatalogModelsArg(args[0]);
			if (!input || args.length !== 1) {
				throw new CodedRpcError(
					"invalid_args",
					"catalog.models requires a { providerId: string }"
				);
			}
			if (!services.catalogModels) {
				throw new CodedRpcError(
					"server_error",
					"catalog.models is not available"
				);
			}
			return await services.catalogModels(input);
		}
		case "chat.list":
			if (args.length !== 0) {
				throw new CodedRpcError("invalid_args", "chat.list takes no arguments");
			}
			if (!services.chatListConversations) {
				throw new CodedRpcError("server_error", "chat.list is not available");
			}
			return await services.chatListConversations();
		case "chat.send": {
			const input = asChatSendArg(args[0]);
			if (!input || args.length !== 1) {
				throw new CodedRpcError(
					"invalid_args",
					"chat.send requires { conversationId: string, text: string }"
				);
			}
			if (!services.chatSend) {
				throw new CodedRpcError("server_error", "chat.send is not available");
			}
			return await services.chatSend(input);
		}
		case "ui.registerRoute": {
			// `args[0]` is the route claim `{path,title}`. The host service is
			// pluginId-scoped and rejects any non-own path (the anti-phishing gate).
			const claim = asRouteClaim(args[0]);
			if (!claim) {
				throw new CapabilityError(
					"ui.registerRoute requires a { path, title }"
				);
			}
			if (!services.registerRoute) {
				throw new CapabilityError("ui.registerRoute is not available");
			}
			return await services.registerRoute(claim);
		}
		case "tool.call": {
			// args = [toolName, toolArgs]. The host pins the origin server; the frame
			// supplies only the name + arguments. Bad shape → invalid_args (D6).
			const [name, toolArgs] = args;
			if (typeof name !== "string" || name.length === 0) {
				throw new CodedRpcError(
					"invalid_args",
					"tool.call requires a tool name string"
				);
			}
			if (!services.callTool) {
				throw new CodedRpcError("server_error", "tool.call is not available");
			}
			return await services.callTool(name, toolArgs);
		}
		case "ui.sendMessage": {
			const input = asPromptArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"ui.sendMessage requires a { prompt: string }"
				);
			}
			if (!services.sendFollowUpMessage) {
				throw new CodedRpcError(
					"server_error",
					"ui.sendMessage is not available"
				);
			}
			return await services.sendFollowUpMessage(input);
		}
		case "ui.toast.show": {
			const input = asToastShowArg(args[0]);
			if (!input || args.length !== 1) {
				throw new CodedRpcError(
					"invalid_args",
					`ui.toast.show requires a bounded { title, description?, variant?, duration? }; title max ${TOAST_LIMITS.titleChars} chars`
				);
			}
			if (!services.uiToastShow) {
				throw new CodedRpcError(
					"server_error",
					"ui.toast.show is not available"
				);
			}
			const id = await services.uiToastShow(input);
			if (!asToastId(id)) {
				throw new CodedRpcError(
					"server_error",
					"ui.toast.show returned an invalid opaque id"
				);
			}
			return id;
		}
		case "ui.toast.update": {
			const input = asToastUpdateArg(args[0]);
			if (!input || args.length !== 1) {
				throw new CodedRpcError(
					"invalid_args",
					"ui.toast.update requires { id } and at least one bounded toast field"
				);
			}
			if (!services.uiToastUpdate) {
				throw new CodedRpcError(
					"server_error",
					"ui.toast.update is not available"
				);
			}
			await services.uiToastUpdate(input);
			return null;
		}
		case "ui.toast.dismiss": {
			const input = asToastDismissArg(args[0]);
			if (!input || args.length !== 1) {
				throw new CodedRpcError(
					"invalid_args",
					"ui.toast.dismiss requires a bounded { id: string }"
				);
			}
			if (!services.uiToastDismiss) {
				throw new CodedRpcError(
					"server_error",
					"ui.toast.dismiss is not available"
				);
			}
			await services.uiToastDismiss(input);
			return null;
		}
		case "assistant.publishContext": {
			const input = asAssistantContextArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"assistant.publishContext requires { items: [{ id, title, text }] }"
				);
			}
			if (!services.assistantPublishContext) {
				throw new CodedRpcError(
					"server_error",
					"assistant.publishContext is not available"
				);
			}
			await services.assistantPublishContext(input);
			return null;
		}
		case "assistant.clearContext": {
			if (!services.assistantClearContext) {
				throw new CodedRpcError(
					"server_error",
					"assistant.clearContext is not available"
				);
			}
			await services.assistantClearContext();
			return null;
		}
		case "assistant.registerSurface": {
			const input = asAssistantSurfaceArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"assistant.registerSurface requires { label: string, … }"
				);
			}
			if (!services.assistantRegisterSurface) {
				throw new CodedRpcError(
					"server_error",
					"assistant.registerSurface is not available"
				);
			}
			await services.assistantRegisterSurface(input);
			return null;
		}
		case "assistant.clearSurface": {
			if (!services.assistantClearSurface) {
				throw new CodedRpcError(
					"server_error",
					"assistant.clearSurface is not available"
				);
			}
			await services.assistantClearSurface();
			return null;
		}
		case "assistant.open": {
			const input = asAssistantOpenArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"assistant.open requires no argument or { prompt?, mode? }"
				);
			}
			if (!services.assistantOpen) {
				throw new CodedRpcError(
					"server_error",
					"assistant.open is not available"
				);
			}
			await services.assistantOpen(input);
			return null;
		}
		case "widget.setState": {
			if (args.length !== 1) {
				throw new CodedRpcError(
					"invalid_args",
					"widget.setState requires exactly one state argument"
				);
			}
			if (!services.setWidgetState) {
				throw new CodedRpcError(
					"server_error",
					"widget.setState is not available"
				);
			}
			return await services.setWidgetState(args[0]);
		}
		case "widget.getGlobals":
			if (!services.getGlobals) {
				throw new CodedRpcError(
					"server_error",
					"widget.getGlobals is not available"
				);
			}
			return await services.getGlobals();
		case "ui.requestDisplayMode": {
			const mode = asDisplayModeArg(args[0]);
			if (!mode) {
				throw new CodedRpcError(
					"invalid_args",
					"ui.requestDisplayMode requires a { mode: 'inline'|'fullscreen'|'pip' }"
				);
			}
			if (!services.requestDisplayMode) {
				throw new CodedRpcError(
					"server_error",
					"ui.requestDisplayMode is not available"
				);
			}
			return await services.requestDisplayMode({ mode });
		}
		case "ui.requestModal": {
			if (!services.requestModal) {
				throw new CodedRpcError(
					"server_error",
					"ui.requestModal is not available"
				);
			}
			// Thread the requested {template} through to the host (it is honored/
			// recorded there); unlike requestDisplayMode this does NOT collapse to a
			// bare mode string, so the template is not dropped.
			const raw = args[0];
			const template =
				raw && typeof raw === "object"
					? (raw as Record<string, unknown>).template
					: undefined;
			return await services.requestModal({ template });
		}
		case "ui.notifyHeight": {
			const px = args[0];
			if (typeof px !== "number" || !Number.isFinite(px) || px < 0) {
				throw new CodedRpcError(
					"invalid_args",
					"ui.notifyHeight requires a non-negative number"
				);
			}
			services.notifyHeight?.(px);
			return null;
		}
		case "ui.requestClose": {
			if (!services.requestClose) {
				throw new CodedRpcError(
					"server_error",
					"ui.requestClose is not available"
				);
			}
			await services.requestClose();
			return null;
		}
		case "ui.openExternal": {
			const input = asOpenExternalArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"ui.openExternal requires an http(s) URL"
				);
			}
			if (!services.openExternal) {
				throw new CodedRpcError(
					"server_error",
					"ui.openExternal is not available"
				);
			}
			await services.openExternal(input);
			return null;
		}
		case "ui.uploadFile": {
			const input = asUploadFileArg(args[0]);
			if (!services.uploadFile) {
				throw new CodedRpcError(
					"server_error",
					"ui.uploadFile is not available"
				);
			}
			return await services.uploadFile(input);
		}
		// Remaining file methods: KNOWN so they reject with a clean structured error,
		// never the unknown-method deny (which reads like a bug). Wire later.
		case "ui.selectFiles":
		case "ui.getFileDownloadUrl":
		case "ui.setOpenInAppUrl":
			throw new CodedRpcError(
				"server_error",
				`${method} is not supported in this Ryu version`
			);
		case "model.complete": {
			const input = asModelCompleteArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"model.complete requires a { prompt: string }"
				);
			}
			if (!services.modelComplete) {
				throw new CodedRpcError(
					"server_error",
					"model.complete is not available"
				);
			}
			return await services.modelComplete(input);
		}
		case "agent.run": {
			const input = asAgentRunArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"agent.run requires a { task: string }"
				);
			}
			if (!services.runAgent) {
				throw new CodedRpcError("server_error", "agent.run is not available");
			}
			return await services.runAgent(input);
		}
		case "storage.get": {
			const input = asStorageKeyArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"storage.get requires a { key: string }"
				);
			}
			if (!services.storageGet) {
				throw new CodedRpcError("server_error", "storage.get is not available");
			}
			return await services.storageGet(input);
		}
		case "storage.set": {
			const input = asStorageSetArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"storage.set requires a { key: string, value: string }"
				);
			}
			if (!services.storageSet) {
				throw new CodedRpcError("server_error", "storage.set is not available");
			}
			return await services.storageSet(input);
		}
		case "storage.delete": {
			const input = asStorageKeyArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"storage.delete requires a { key: string }"
				);
			}
			if (!services.storageDelete) {
				throw new CodedRpcError(
					"server_error",
					"storage.delete is not available"
				);
			}
			return await services.storageDelete(input);
		}
		case "storage.keys": {
			const input = asStorageKeysArg(args[0]);
			if (!services.storageKeys) {
				throw new CodedRpcError(
					"server_error",
					"storage.keys is not available"
				);
			}
			return await services.storageKeys(input);
		}
		case "storage.compareAndSet": {
			const input = asStorageCompareAndSetArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"storage.compareAndSet requires a { key: string }"
				);
			}
			if (!services.storageCompareAndSet) {
				throw new CodedRpcError(
					"server_error",
					"storage.compareAndSet is not available"
				);
			}
			return await services.storageCompareAndSet(input);
		}
		case "crypto.seal": {
			const input = asCryptoValueArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"crypto.seal requires a { value: string }"
				);
			}
			if (!services.cryptoSeal) {
				throw new CodedRpcError("server_error", "crypto.seal is not available");
			}
			return await services.cryptoSeal(input);
		}
		case "crypto.open": {
			const input = asCryptoValueArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"crypto.open requires a { value: string }"
				);
			}
			if (!services.cryptoOpen) {
				throw new CodedRpcError("server_error", "crypto.open is not available");
			}
			return await services.cryptoOpen(input);
		}
		case "crypto.status": {
			if (!services.cryptoStatus) {
				throw new CodedRpcError(
					"server_error",
					"crypto.status is not available"
				);
			}
			return await services.cryptoStatus();
		}
		case "spaces.ensureSpace": {
			const input = asSpacesEnsureArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"spaces.ensureSpace requires { name: string, description?: string }"
				);
			}
			if (!services.spacesEnsureSpace) {
				throw new CodedRpcError(
					"server_error",
					"spaces.ensureSpace is not available"
				);
			}
			return await services.spacesEnsureSpace(input);
		}
		case "spaces.search": {
			const input = asSpacesSearchArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"spaces.search requires { space_id: string, query: string, limit?: number }"
				);
			}
			if (!services.spacesSearch) {
				throw new CodedRpcError(
					"server_error",
					"spaces.search is not available"
				);
			}
			return await services.spacesSearch(input);
		}
		case "spaces.createDoc": {
			const input = asSpacesCreateArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"spaces.createDoc requires { space_id: string, title: string }"
				);
			}
			if (!services.spacesCreateDoc) {
				throw new CodedRpcError(
					"server_error",
					"spaces.createDoc is not available"
				);
			}
			return await services.spacesCreateDoc(input);
		}
		case "spaces.getDoc": {
			const input = asSpacesDocIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"spaces.getDoc requires { doc_id: string }"
				);
			}
			if (!services.spacesGetDoc) {
				throw new CodedRpcError(
					"server_error",
					"spaces.getDoc is not available"
				);
			}
			return await services.spacesGetDoc(input);
		}
		case "spaces.updateDoc": {
			const input = asSpacesUpdateArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"spaces.updateDoc requires { doc_id: string, source: string }"
				);
			}
			if (!services.spacesUpdateDoc) {
				throw new CodedRpcError(
					"server_error",
					"spaces.updateDoc is not available"
				);
			}
			return await services.spacesUpdateDoc(input);
		}
		case "spaces.listDocs": {
			const input = asSpacesListArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"spaces.listDocs requires { space_id: string }"
				);
			}
			if (!services.spacesListDocs) {
				throw new CodedRpcError(
					"server_error",
					"spaces.listDocs is not available"
				);
			}
			return await services.spacesListDocs(input);
		}
		case "spaces.deleteDoc": {
			const input = asSpacesDocIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"spaces.deleteDoc requires { doc_id: string }"
				);
			}
			if (!services.spacesDeleteDoc) {
				throw new CodedRpcError(
					"server_error",
					"spaces.deleteDoc is not available"
				);
			}
			return await services.spacesDeleteDoc(input);
		}
		case "media.image": {
			const input = asMediaImageArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"media.image requires { prompt: string }"
				);
			}
			if (!services.generateImage) {
				throw new CodedRpcError("server_error", "media.image is not available");
			}
			return await services.generateImage(input);
		}
		case "media.video": {
			const input = asMediaVideoArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"media.video requires { prompt: string }"
				);
			}
			if (!services.generateVideo) {
				throw new CodedRpcError("server_error", "media.video is not available");
			}
			return await services.generateVideo(input);
		}
		case "media.tts": {
			const input = asMediaTtsArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"media.tts requires { text: string }"
				);
			}
			if (!services.ttsSpeak) {
				throw new CodedRpcError("server_error", "media.tts is not available");
			}
			return await services.ttsSpeak(input);
		}
		case "media.transcribe": {
			const input = asMediaTranscribeArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"media.transcribe requires { audio: string }"
				);
			}
			if (!services.transcribeAudio) {
				throw new CodedRpcError(
					"server_error",
					"media.transcribe is not available"
				);
			}
			return await services.transcribeAudio(input);
		}
		case "finetune.capability":
			if (!services.finetuneCapability) {
				throw new CodedRpcError(
					"server_error",
					"finetune.capability is not available"
				);
			}
			return await services.finetuneCapability();
		case "finetune.list":
			if (!services.finetuneList) {
				throw new CodedRpcError(
					"server_error",
					"finetune.list is not available"
				);
			}
			return await services.finetuneList();
		case "finetune.adapters":
			if (!services.finetuneAdapters) {
				throw new CodedRpcError(
					"server_error",
					"finetune.adapters is not available"
				);
			}
			return await services.finetuneAdapters();
		case "finetune.start": {
			const input = asRecordArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"finetune.start requires a job spec object"
				);
			}
			if (!services.finetuneStart) {
				throw new CodedRpcError(
					"server_error",
					"finetune.start is not available"
				);
			}
			return await services.finetuneStart(input);
		}
		case "finetune.merge": {
			const input = asRecordArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"finetune.merge requires an object with adapter_name or adapter_path"
				);
			}
			if (!services.finetuneMerge) {
				throw new CodedRpcError(
					"server_error",
					"finetune.merge is not available"
				);
			}
			return await services.finetuneMerge(input);
		}
		case "finetune.get": {
			const input = asFinetuneIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"finetune.get requires a { id: string }"
				);
			}
			if (!services.finetuneGet) {
				throw new CodedRpcError(
					"server_error",
					"finetune.get is not available"
				);
			}
			return await services.finetuneGet(input);
		}
		case "finetune.cancel": {
			const input = asFinetuneIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"finetune.cancel requires a { id: string }"
				);
			}
			if (!services.finetuneCancel) {
				throw new CodedRpcError(
					"server_error",
					"finetune.cancel is not available"
				);
			}
			return await services.finetuneCancel(input);
		}
		case "registry.engineModels":
			if (!services.listEngineModels) {
				throw new CapabilityError("registry.engineModels is not available");
			}
			return await services.listEngineModels();
		case "registry.ttsEngines":
			if (!services.listTtsEngines) {
				throw new CapabilityError("registry.ttsEngines is not available");
			}
			return await services.listTtsEngines();
		case "registry.agents":
			if (!services.listAgentsFull) {
				throw new CapabilityError("registry.agents is not available");
			}
			return await services.listAgentsFull();
		case "assets.searchGifs": {
			const input = asAssetQueryArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"assets.searchGifs requires { query: string }"
				);
			}
			if (!services.searchGifs) {
				throw new CapabilityError("assets.searchGifs is not available");
			}
			return await services.searchGifs(input);
		}
		case "monitors.list":
			if (!services.monitorsList) {
				throw new CodedRpcError(
					"server_error",
					"monitors.list is not available"
				);
			}
			return await services.monitorsList();
		case "monitors.get": {
			const input = asMonitorIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"monitors.get requires a { id: string }"
				);
			}
			if (!services.monitorsGet) {
				throw new CodedRpcError(
					"server_error",
					"monitors.get is not available"
				);
			}
			return await services.monitorsGet(input);
		}
		case "monitors.create": {
			const input = asMonitorInputArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"monitors.create requires a { name, url, … } object"
				);
			}
			if (!services.monitorsCreate) {
				throw new CodedRpcError(
					"server_error",
					"monitors.create is not available"
				);
			}
			return await services.monitorsCreate(input);
		}
		case "monitors.update": {
			const input = asMonitorUpdateArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"monitors.update requires a { id: string, input: { … } }"
				);
			}
			if (!services.monitorsUpdate) {
				throw new CodedRpcError(
					"server_error",
					"monitors.update is not available"
				);
			}
			return await services.monitorsUpdate(input);
		}
		case "monitors.delete": {
			const input = asMonitorIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"monitors.delete requires a { id: string }"
				);
			}
			if (!services.monitorsDelete) {
				throw new CodedRpcError(
					"server_error",
					"monitors.delete is not available"
				);
			}
			return await services.monitorsDelete(input);
		}
		case "monitors.run": {
			const input = asMonitorIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"monitors.run requires a { id: string }"
				);
			}
			if (!services.monitorsRun) {
				throw new CodedRpcError(
					"server_error",
					"monitors.run is not available"
				);
			}
			return await services.monitorsRun(input);
		}
		case "monitors.snapshots": {
			const input = asMonitorListLimitArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"monitors.snapshots requires a { id: string, limit?: number }"
				);
			}
			if (!services.monitorsSnapshots) {
				throw new CodedRpcError(
					"server_error",
					"monitors.snapshots is not available"
				);
			}
			return await services.monitorsSnapshots(input);
		}
		case "monitors.alerts": {
			const input = asMonitorListLimitArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"monitors.alerts requires a { id: string, limit?: number }"
				);
			}
			if (!services.monitorsAlerts) {
				throw new CodedRpcError(
					"server_error",
					"monitors.alerts is not available"
				);
			}
			return await services.monitorsAlerts(input);
		}
		case "workflows.list":
			if (!services.workflowsList) {
				throw new CodedRpcError(
					"server_error",
					"workflows.list is not available"
				);
			}
			return await services.workflowsList();
		case "workflows.get": {
			const input = asWorkflowIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"workflows.get requires a { id: string }"
				);
			}
			if (!services.workflowsGet) {
				throw new CodedRpcError(
					"server_error",
					"workflows.get is not available"
				);
			}
			return await services.workflowsGet(input);
		}
		case "workflows.save": {
			const input = asRecordArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"workflows.save requires a workflow definition object"
				);
			}
			if (!services.workflowsSave) {
				throw new CodedRpcError(
					"server_error",
					"workflows.save is not available"
				);
			}
			return await services.workflowsSave(input);
		}
		case "workflows.delete": {
			const input = asWorkflowIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"workflows.delete requires a { id: string }"
				);
			}
			if (!services.workflowsDelete) {
				throw new CodedRpcError(
					"server_error",
					"workflows.delete is not available"
				);
			}
			return await services.workflowsDelete(input);
		}
		case "workflows.versionsList": {
			const input = asWorkflowIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"workflows.versionsList requires a { id: string }"
				);
			}
			if (!services.workflowsVersionsList) {
				throw new CodedRpcError(
					"server_error",
					"workflows.versionsList is not available"
				);
			}
			return await services.workflowsVersionsList(input);
		}
		case "workflows.versionGet": {
			const input = asWorkflowVersionGetArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"workflows.versionGet requires a { id: string, versionId: string }"
				);
			}
			if (!services.workflowsVersionGet) {
				throw new CodedRpcError(
					"server_error",
					"workflows.versionGet is not available"
				);
			}
			return await services.workflowsVersionGet(input);
		}
		case "workflows.versionCreate": {
			const input = asWorkflowVersionCreateArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"workflows.versionCreate requires a { id: string, label?: string }"
				);
			}
			if (!services.workflowsVersionCreate) {
				throw new CodedRpcError(
					"server_error",
					"workflows.versionCreate is not available"
				);
			}
			return await services.workflowsVersionCreate(input);
		}
		case "workflows.versionRestore": {
			const input = asWorkflowVersionGetArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"workflows.versionRestore requires a { id: string, versionId: string }"
				);
			}
			if (!services.workflowsVersionRestore) {
				throw new CodedRpcError(
					"server_error",
					"workflows.versionRestore is not available"
				);
			}
			return await services.workflowsVersionRestore(input);
		}
		case "workflows.templatesList":
			if (!services.workflowsTemplatesList) {
				throw new CodedRpcError(
					"server_error",
					"workflows.templatesList is not available"
				);
			}
			return await services.workflowsTemplatesList();
		case "workflows.templateGet": {
			const input = asWorkflowIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"workflows.templateGet requires a { id: string }"
				);
			}
			if (!services.workflowsTemplateGet) {
				throw new CodedRpcError(
					"server_error",
					"workflows.templateGet is not available"
				);
			}
			return await services.workflowsTemplateGet(input);
		}
		case "workflows.templateInstall": {
			const input = asTemplateInstallArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"workflows.templateInstall requires a { templateId: string }"
				);
			}
			if (!services.workflowsTemplateInstall) {
				throw new CodedRpcError(
					"server_error",
					"workflows.templateInstall is not available"
				);
			}
			return await services.workflowsTemplateInstall(input);
		}
		case "workflows.webhook": {
			const input = asWorkflowIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"workflows.webhook requires a { id: string }"
				);
			}
			if (!services.workflowsWebhook) {
				throw new CodedRpcError(
					"server_error",
					"workflows.webhook is not available"
				);
			}
			return await services.workflowsWebhook(input);
		}
		case "workflows.run": {
			const input = asWorkflowRunArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"workflows.run requires a { id: string, input?: Record<string,string>, dryRun?: boolean }"
				);
			}
			if (!services.workflowsRun) {
				throw new CodedRpcError(
					"server_error",
					"workflows.run is not available"
				);
			}
			return await services.workflowsRun(input);
		}
		case "workflows.runGet": {
			const input = asWorkflowRunIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"workflows.runGet requires a { runId: string }"
				);
			}
			if (!services.workflowsRunGet) {
				throw new CodedRpcError(
					"server_error",
					"workflows.runGet is not available"
				);
			}
			return await services.workflowsRunGet(input);
		}
		case "workflows.resume": {
			const input = asWorkflowResumeArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"workflows.resume requires a { runId: string, payload: string }"
				);
			}
			if (!services.workflowsResume) {
				throw new CodedRpcError(
					"server_error",
					"workflows.resume is not available"
				);
			}
			return await services.workflowsResume(input);
		}
		case "workflows.agents":
			if (!services.workflowsAgents) {
				throw new CodedRpcError(
					"server_error",
					"workflows.agents is not available"
				);
			}
			return await services.workflowsAgents();
		case "workflows.apps":
			if (!services.workflowsApps) {
				throw new CodedRpcError(
					"server_error",
					"workflows.apps is not available"
				);
			}
			return await services.workflowsApps();
		case "workflows.mcp":
			if (!services.workflowsMcp) {
				throw new CodedRpcError(
					"server_error",
					"workflows.mcp is not available"
				);
			}
			return await services.workflowsMcp();
		case "workflows.skills":
			if (!services.workflowsSkills) {
				throw new CodedRpcError(
					"server_error",
					"workflows.skills is not available"
				);
			}
			return await services.workflowsSkills();
		case "workflows.schedules":
			if (!services.workflowsSchedules) {
				throw new CodedRpcError(
					"server_error",
					"workflows.schedules is not available"
				);
			}
			return await services.workflowsSchedules();
		case "workflows.notifyTargets":
			if (!services.workflowsNotifyTargets) {
				throw new CodedRpcError(
					"server_error",
					"workflows.notifyTargets is not available"
				);
			}
			return await services.workflowsNotifyTargets();
		case "workflows.hookEvents":
			if (!services.workflowsHookEvents) {
				throw new CodedRpcError(
					"server_error",
					"workflows.hookEvents is not available"
				);
			}
			return await services.workflowsHookEvents();
		case "workflows.composio": {
			const input = asComposioArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"workflows.composio requires a { kind: 'status'|'toolkits'|'triggers'|'connections', toolkit?: string }"
				);
			}
			if (!services.workflowsComposio) {
				throw new CodedRpcError(
					"server_error",
					"workflows.composio is not available"
				);
			}
			return await services.workflowsComposio(input);
		}
		case "ghost.recipes":
			if (!services.ghostRecipes) {
				throw new CodedRpcError(
					"server_error",
					"ghost.recipes is not available"
				);
			}
			return await services.ghostRecipes();
		case "ghost.recordStart": {
			const input = asRecordStartArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"ghost.recordStart requires a { task: string }"
				);
			}
			if (!services.ghostRecordStart) {
				throw new CodedRpcError(
					"server_error",
					"ghost.recordStart is not available"
				);
			}
			return await services.ghostRecordStart(input);
		}
		case "ghost.recordStatus":
			if (!services.ghostRecordStatus) {
				throw new CodedRpcError(
					"server_error",
					"ghost.recordStatus is not available"
				);
			}
			return await services.ghostRecordStatus();
		case "ghost.recordStop":
			if (!services.ghostRecordStop) {
				throw new CodedRpcError(
					"server_error",
					"ghost.recordStop is not available"
				);
			}
			return await services.ghostRecordStop();
		case "webhooks.list":
			if (!services.webhooksList) {
				throw new CodedRpcError(
					"server_error",
					"webhooks.list is not available"
				);
			}
			return await services.webhooksList();
		case "webhooks.ingressStatus":
			if (!services.webhooksIngressStatus) {
				throw new CodedRpcError(
					"server_error",
					"webhooks.ingressStatus is not available"
				);
			}
			return await services.webhooksIngressStatus();
		case "webhooks.secretGet": {
			const input = asWebhookSecretIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"webhooks.secretGet requires a { id: string }"
				);
			}
			if (!services.webhooksSecretGet) {
				throw new CodedRpcError(
					"server_error",
					"webhooks.secretGet is not available"
				);
			}
			return await services.webhooksSecretGet(input);
		}
		case "webhooks.secretSet": {
			const input = asWebhookSecretSetArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"webhooks.secretSet requires a { id: string, secret?: string }"
				);
			}
			if (!services.webhooksSecretSet) {
				throw new CodedRpcError(
					"server_error",
					"webhooks.secretSet is not available"
				);
			}
			return await services.webhooksSecretSet(input);
		}
		case "quests.list":
			if (!services.questsList) {
				throw new CodedRpcError("server_error", "quests.list is not available");
			}
			return await services.questsList(asQuestListArg(args[0]));
		case "quests.capture": {
			const input = asQuestCaptureArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"quests.capture requires a { body: string } object"
				);
			}
			if (!services.questsCapture) {
				throw new CodedRpcError(
					"server_error",
					"quests.capture is not available"
				);
			}
			return await services.questsCapture(input);
		}
		case "quests.use": {
			const input = asQuestIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"quests.use requires a { id: string }"
				);
			}
			if (!services.questsUse) {
				throw new CodedRpcError("server_error", "quests.use is not available");
			}
			return await services.questsUse({
				...input,
				complete: asOptionalBoolean(args[0], "complete"),
			});
		}
		case "quests.pin": {
			const input = asQuestIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"quests.pin requires a { id: string }"
				);
			}
			if (!services.questsPin) {
				throw new CodedRpcError("server_error", "quests.pin is not available");
			}
			return await services.questsPin({
				...input,
				pinned: asOptionalBoolean(args[0], "pinned"),
			});
		}
		case "quests.scratchpad":
			if (!services.questsScratchpad) {
				throw new CodedRpcError(
					"server_error",
					"quests.scratchpad is not available"
				);
			}
			return await services.questsScratchpad();
		case "quests.setScratchpad": {
			const text = asQuestScratchpadArg(args[0]);
			if (text === null) {
				throw new CodedRpcError(
					"invalid_args",
					"quests.setScratchpad requires a { text: string } object"
				);
			}
			if (!services.questsSetScratchpad) {
				throw new CodedRpcError(
					"server_error",
					"quests.setScratchpad is not available"
				);
			}
			await services.questsSetScratchpad({ text });
			return null;
		}
		case "quests.create": {
			const input = asQuestInputArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"quests.create requires a { title, completion_condition } object"
				);
			}
			if (!services.questsCreate) {
				throw new CodedRpcError(
					"server_error",
					"quests.create is not available"
				);
			}
			return await services.questsCreate(input);
		}
		case "quests.update": {
			const input = asQuestUpdateArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"quests.update requires a { id: string, input: { title, completion_condition } }"
				);
			}
			if (!services.questsUpdate) {
				throw new CodedRpcError(
					"server_error",
					"quests.update is not available"
				);
			}
			return await services.questsUpdate(input);
		}
		case "quests.delete": {
			const input = asQuestIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"quests.delete requires a { id: string }"
				);
			}
			if (!services.questsDelete) {
				throw new CodedRpcError(
					"server_error",
					"quests.delete is not available"
				);
			}
			return await services.questsDelete(input);
		}
		case "quests.complete": {
			const input = asQuestIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"quests.complete requires a { id: string }"
				);
			}
			if (!services.questsComplete) {
				throw new CodedRpcError(
					"server_error",
					"quests.complete is not available"
				);
			}
			return await services.questsComplete(input);
		}
		case "quests.dismiss": {
			const input = asQuestIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"quests.dismiss requires a { id: string }"
				);
			}
			if (!services.questsDismiss) {
				throw new CodedRpcError(
					"server_error",
					"quests.dismiss is not available"
				);
			}
			return await services.questsDismiss(input);
		}
		case "quests.acceptSuggestion": {
			const input = asQuestIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"quests.acceptSuggestion requires a { id: string }"
				);
			}
			if (!services.questsAcceptSuggestion) {
				throw new CodedRpcError(
					"server_error",
					"quests.acceptSuggestion is not available"
				);
			}
			return await services.questsAcceptSuggestion(input);
		}
		case "quests.dismissSuggestion": {
			const input = asQuestIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"quests.dismissSuggestion requires a { id: string }"
				);
			}
			if (!services.questsDismissSuggestion) {
				throw new CodedRpcError(
					"server_error",
					"quests.dismissSuggestion is not available"
				);
			}
			return await services.questsDismissSuggestion(input);
		}
		case "quests.judge": {
			const input = asQuestIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"quests.judge requires a { id: string }"
				);
			}
			if (!services.questsJudge) {
				throw new CodedRpcError(
					"server_error",
					"quests.judge is not available"
				);
			}
			return await services.questsJudge(input);
		}
		case "quests.openDetectionSettings":
			if (!services.questsOpenDetectionSettings) {
				throw new CodedRpcError(
					"server_error",
					"quests.openDetectionSettings is not available"
				);
			}
			services.questsOpenDetectionSettings();
			return null;
		case "activity.list": {
			const input = asActivityListArg(args[0]);
			if (!services.activityList) {
				throw new CodedRpcError(
					"server_error",
					"activity.list is not available"
				);
			}
			return await services.activityList(input);
		}
		case "background.list": {
			const input = asBackgroundListArg(args[0]);
			if (!services.backgroundList) {
				throw new CodedRpcError(
					"server_error",
					"background.list is not available"
				);
			}
			return await services.backgroundList(input);
		}
		case "background.stop": {
			const input = asBackgroundStopArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"background.stop requires a { process_id: string }"
				);
			}
			if (!services.backgroundStop) {
				throw new CodedRpcError(
					"server_error",
					"background.stop is not available"
				);
			}
			return await services.backgroundStop(input);
		}
		case "activity.openSession": {
			const input = asActivitySessionArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"activity.openSession requires a { session_id: string }"
				);
			}
			if (!services.activityOpenSession) {
				throw new CodedRpcError(
					"server_error",
					"activity.openSession is not available"
				);
			}
			services.activityOpenSession(input);
			return null;
		}
		case "timeline.list": {
			const input = asTimelineRangeArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"timeline.list requires a { rangeMinutes: number }"
				);
			}
			if (!services.timelineList) {
				throw new CodedRpcError(
					"server_error",
					"timeline.list is not available"
				);
			}
			return await services.timelineList(input);
		}
		case "timeline.journal": {
			const input = asTimelineJournalArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"timeline.journal requires a { rangeMinutes: number, narrate?: boolean }"
				);
			}
			if (!services.timelineJournal) {
				throw new CodedRpcError(
					"server_error",
					"timeline.journal is not available"
				);
			}
			return await services.timelineJournal(input);
		}
		case "timeline.frame": {
			const input = asTimelineFrameArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"timeline.frame requires a { tsMicros: number }"
				);
			}
			if (!services.timelineFrame) {
				throw new CodedRpcError(
					"server_error",
					"timeline.frame is not available"
				);
			}
			return await services.timelineFrame(input);
		}
		case "timeline.openReview":
			if (!services.timelineOpenReview) {
				throw new CodedRpcError(
					"server_error",
					"timeline.openReview is not available"
				);
			}
			services.timelineOpenReview();
			return null;
		case "timeline.openSettings":
			if (!services.timelineOpenSettings) {
				throw new CodedRpcError(
					"server_error",
					"timeline.openSettings is not available"
				);
			}
			services.timelineOpenSettings();
			return null;
		case "mail.list":
			if (!services.mailList) {
				throw new CodedRpcError("server_error", "mail.list is not available");
			}
			return await services.mailList();
		case "mail.messages": {
			const input = asMailInboxRefArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"mail.messages requires a { inboxId: string }"
				);
			}
			if (!services.mailMessages) {
				throw new CodedRpcError(
					"server_error",
					"mail.messages is not available"
				);
			}
			return await services.mailMessages(input);
		}
		case "mail.create": {
			const input = asMailCreateArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"mail.create requires a { name: string, address: string } object"
				);
			}
			if (!services.mailCreate) {
				throw new CodedRpcError("server_error", "mail.create is not available");
			}
			return await services.mailCreate(input);
		}
		case "mail.delete": {
			const input = asMailIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"mail.delete requires a { id: string }"
				);
			}
			if (!services.mailDelete) {
				throw new CodedRpcError("server_error", "mail.delete is not available");
			}
			return await services.mailDelete(input);
		}
		case "mail.rotateSecret": {
			const input = asMailIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"mail.rotateSecret requires a { id: string }"
				);
			}
			if (!services.mailRotateSecret) {
				throw new CodedRpcError(
					"server_error",
					"mail.rotateSecret is not available"
				);
			}
			return await services.mailRotateSecret(input);
		}
		case "mail.send": {
			const input = asMailSendArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"mail.send requires a { inboxId: string, to: string[], subject: string, text?: string }"
				);
			}
			if (!services.mailSend) {
				throw new CodedRpcError("server_error", "mail.send is not available");
			}
			return await services.mailSend(input);
		}
		case "mail.inboundUrl": {
			const input = asMailInboxRefArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"mail.inboundUrl requires a { inboxId: string }"
				);
			}
			if (!services.mailInboundUrl) {
				throw new CodedRpcError(
					"server_error",
					"mail.inboundUrl is not available"
				);
			}
			return await services.mailInboundUrl(input);
		}
		case "calendar.jobs":
			if (!services.calendarJobs) {
				throw new CodedRpcError(
					"server_error",
					"calendar.jobs is not available"
				);
			}
			return await services.calendarJobs();
		case "calendar.workflows":
			if (!services.calendarWorkflows) {
				throw new CodedRpcError(
					"server_error",
					"calendar.workflows is not available"
				);
			}
			return await services.calendarWorkflows();
		case "calendar.agents":
			if (!services.calendarAgents) {
				throw new CodedRpcError(
					"server_error",
					"calendar.agents is not available"
				);
			}
			return await services.calendarAgents();
		case "warmup.detect":
			if (!services.warmupDetect) {
				throw new CodedRpcError(
					"server_error",
					"warmup.detect is not available"
				);
			}
			return await services.warmupDetect();
		case "warmup.list":
			if (!services.warmupList) {
				throw new CodedRpcError("server_error", "warmup.list is not available");
			}
			return await services.warmupList();
		case "warmup.apply": {
			const jobs = asWarmupJobsArg(args[0]);
			if (!jobs) {
				throw new CodedRpcError(
					"invalid_args",
					"warmup.apply expects an array of { name, schedule, target:{type:'agent',…} }"
				);
			}
			if (!services.warmupApply) {
				throw new CodedRpcError(
					"server_error",
					"warmup.apply is not available"
				);
			}
			await services.warmupApply(jobs);
			return { ok: true };
		}
		case "warmup.runNow": {
			const ping = asWarmupRunNowArg(args[0]);
			if (!ping) {
				throw new CodedRpcError(
					"invalid_args",
					"warmup.runNow expects { jobId }"
				);
			}
			if (!services.warmupRunNow) {
				throw new CodedRpcError(
					"server_error",
					"warmup.runNow is not available"
				);
			}
			await services.warmupRunNow(ping);
			return { ok: true };
		}
		case "calendar.createAutomation": {
			const input = asCalendarCreateAutomationArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"calendar.createAutomation requires a { agentId: string, agentName: string, conversationId?: string | null, schedule: { kind: 'cron', expr } | { kind: 'every', interval }, requireApproval?: boolean }"
				);
			}
			if (!services.calendarCreateAutomation) {
				throw new CodedRpcError(
					"server_error",
					"calendar.createAutomation is not available"
				);
			}
			await services.calendarCreateAutomation(input);
			return null;
		}
		case "learning.config":
			if (!services.learningConfig) {
				throw new CodedRpcError(
					"server_error",
					"learning.config is not available"
				);
			}
			return await services.learningConfig();
		case "learning.experience":
			if (!services.learningExperience) {
				throw new CodedRpcError(
					"server_error",
					"learning.experience is not available"
				);
			}
			return await services.learningExperience();
		case "learning.healing":
			if (!services.learningHealing) {
				throw new CodedRpcError(
					"server_error",
					"learning.healing is not available"
				);
			}
			return await services.learningHealing();
		case "approvals.list":
			if (!services.approvalsList) {
				throw new CodedRpcError(
					"server_error",
					"approvals.list is not available"
				);
			}
			return await services.approvalsList();
		case "approvals.approve": {
			const input = asApprovalDecideArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"approvals.approve requires a { id: string } object"
				);
			}
			if (!services.approvalsApprove) {
				throw new CodedRpcError(
					"server_error",
					"approvals.approve is not available"
				);
			}
			return await services.approvalsApprove(input);
		}
		case "approvals.reject": {
			const input = asApprovalDecideArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"approvals.reject requires a { id: string } object"
				);
			}
			if (!services.approvalsReject) {
				throw new CodedRpcError(
					"server_error",
					"approvals.reject is not available"
				);
			}
			return await services.approvalsReject(input);
		}
		case "notifications.list":
			if (!services.notificationsList) {
				throw new CodedRpcError(
					"server_error",
					"notifications.list is not available"
				);
			}
			return await services.notificationsList(
				args[0] as { archived?: boolean }
			);
		case "notifications.send": {
			const input = asNotificationSendArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"notifications.send requires { target_user_id: string, title: string, body?: string }"
				);
			}
			if (!services.notificationsSend) {
				throw new CodedRpcError(
					"server_error",
					"notifications.send is not available"
				);
			}
			return await services.notificationsSend(input);
		}
		case "notifications.markRead": {
			const input = asQuestIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"notifications.markRead requires a { id: string }"
				);
			}
			if (!services.notificationsMarkRead) {
				throw new CodedRpcError(
					"server_error",
					"notifications.markRead is not available"
				);
			}
			await services.notificationsMarkRead(input);
			return null;
		}
		case "notifications.appIcons": {
			const input = args[0] as { appIds?: unknown };
			const appIds = Array.isArray(input?.appIds)
				? input.appIds.filter(
						(id): id is string => typeof id === "string" && id.length > 0
					)
				: [];
			if (!services.notificationsAppIcons) {
				throw new CodedRpcError(
					"server_error",
					"notifications.appIcons is not available"
				);
			}
			return await services.notificationsAppIcons({ appIds });
		}
		case "notifications.archive": {
			const input = asQuestIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"notifications.archive requires a { id: string }"
				);
			}
			if (!services.notificationsArchive) {
				throw new CodedRpcError(
					"server_error",
					"notifications.archive is not available"
				);
			}
			await services.notificationsArchive(input);
			return null;
		}
		case "notifications.unarchive": {
			const input = asQuestIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"notifications.unarchive requires a { id: string }"
				);
			}
			if (!services.notificationsUnarchive) {
				throw new CodedRpcError(
					"server_error",
					"notifications.unarchive is not available"
				);
			}
			await services.notificationsUnarchive(input);
			return null;
		}
		case "notifications.ack": {
			const input = asQuestIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"notifications.ack requires a { id: string }"
				);
			}
			if (!services.notificationsAck) {
				throw new CodedRpcError(
					"server_error",
					"notifications.ack is not available"
				);
			}
			return await services.notificationsAck(input);
		}
		case "suggestions.list":
			if (!services.suggestionsList) {
				throw new CodedRpcError(
					"server_error",
					"suggestions.list is not available"
				);
			}
			return await services.suggestionsList();
		case "suggestions.feedback": {
			const input = asSuggestionFeedbackArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"suggestions.feedback requires a { kind, suggestion_type } object"
				);
			}
			if (!services.suggestionsFeedback) {
				throw new CodedRpcError(
					"server_error",
					"suggestions.feedback is not available"
				);
			}
			return await services.suggestionsFeedback(input);
		}
		case "suggestions.openInChat": {
			const input = asOpenInChatArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"suggestions.openInChat requires a { prompt: string }"
				);
			}
			if (!services.suggestionsOpenInChat) {
				throw new CodedRpcError(
					"server_error",
					"suggestions.openInChat is not available"
				);
			}
			services.suggestionsOpenInChat(input);
			return null;
		}
		case "meetings.list":
			if (!services.meetingsList) {
				throw new CodedRpcError(
					"server_error",
					"meetings.list is not available"
				);
			}
			return await services.meetingsList();
		case "meetings.transcript": {
			const input = asMeetingIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"meetings.transcript requires a { id: string }"
				);
			}
			if (!services.meetingsTranscript) {
				throw new CodedRpcError(
					"server_error",
					"meetings.transcript is not available"
				);
			}
			return await services.meetingsTranscript(input);
		}
		case "meetings.start": {
			const input = asMeetingStartArg(args[0]);
			if (!services.meetingsStart) {
				throw new CodedRpcError(
					"server_error",
					"meetings.start is not available"
				);
			}
			return await services.meetingsStart(input);
		}
		case "meetings.finalize": {
			const input = asMeetingIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"meetings.finalize requires a { id: string }"
				);
			}
			if (!services.meetingsFinalize) {
				throw new CodedRpcError(
					"server_error",
					"meetings.finalize is not available"
				);
			}
			return await services.meetingsFinalize(input);
		}
		case "meetings.delete": {
			const input = asMeetingIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"meetings.delete requires a { id: string }"
				);
			}
			if (!services.meetingsDelete) {
				throw new CodedRpcError(
					"server_error",
					"meetings.delete is not available"
				);
			}
			await services.meetingsDelete(input);
			return null;
		}
		case "meetings.rename": {
			const input = asMeetingRenameArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"meetings.rename requires a { id: string, title: string }"
				);
			}
			if (!services.meetingsRename) {
				throw new CodedRpcError(
					"server_error",
					"meetings.rename is not available"
				);
			}
			return await services.meetingsRename(input);
		}
		case "meetings.setIcon": {
			const input = asMeetingSetIconArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"meetings.setIcon requires a { id: string, icon: unknown | null }"
				);
			}
			if (!services.meetingsSetIcon) {
				throw new CodedRpcError(
					"server_error",
					"meetings.setIcon is not available"
				);
			}
			return await services.meetingsSetIcon(input);
		}
		case "meetings.import":
			if (!services.meetingsImport) {
				throw new CodedRpcError(
					"server_error",
					"meetings.import is not available"
				);
			}
			return await services.meetingsImport();
		case "meetings.open": {
			const input = asMeetingOpenArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"meetings.open requires a { id: string }"
				);
			}
			if (!services.meetingsOpen) {
				throw new CodedRpcError(
					"server_error",
					"meetings.open is not available"
				);
			}
			services.meetingsOpen(input);
			return null;
		}
		case "meetings.openNotes": {
			const input = asMeetingOpenNotesArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"meetings.openNotes requires a { spaceId: string, docId: string }"
				);
			}
			if (!services.meetingsOpenNotes) {
				throw new CodedRpcError(
					"server_error",
					"meetings.openNotes is not available"
				);
			}
			services.meetingsOpenNotes(input);
			return null;
		}
		case "meetings.openList":
			if (!services.meetingsOpenList) {
				throw new CodedRpcError(
					"server_error",
					"meetings.openList is not available"
				);
			}
			services.meetingsOpenList();
			return null;
		case "social.request": {
			const input = asSocialRequestArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"social.request requires a { path: string } beginning with '/' and containing no '..' segment"
				);
			}
			if (!services.socialRequest) {
				throw new CodedRpcError(
					"server_error",
					"social.request is not available"
				);
			}
			return await services.socialRequest(input);
		}
		case "app.request": {
			const input = asAppRequestArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"app.request requires a relative { path, method?, body? } request"
				);
			}
			if (!services.appRequest) {
				throw new CodedRpcError("server_error", "app.request is not available");
			}
			return await services.appRequest(input);
		}
		case "realtime.connect": {
			const input = asRealtimeConnectArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"realtime.connect requires a { room_id: string }"
				);
			}
			if (!services.realtimeConnect) {
				throw new CodedRpcError(
					"server_error",
					"realtime.connect is not available"
				);
			}
			return await services.realtimeConnect(input);
		}
		case "realtime.publish": {
			const input = asRealtimePublishArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"realtime.publish requires { connection_id, event, data? }"
				);
			}
			if (!services.realtimePublish) {
				throw new CodedRpcError(
					"server_error",
					"realtime.publish is not available"
				);
			}
			await services.realtimePublish(input);
			return null;
		}
		case "realtime.presence": {
			const input = asRealtimePresenceArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"realtime.presence requires { connection_id, data? }"
				);
			}
			if (!services.realtimePresence) {
				throw new CodedRpcError(
					"server_error",
					"realtime.presence is not available"
				);
			}
			await services.realtimePresence(input);
			return null;
		}
		case "realtime.close": {
			const input = asRealtimeConnectionArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"realtime.close requires { connection_id: string }"
				);
			}
			if (!services.realtimeClose) {
				throw new CodedRpcError(
					"server_error",
					"realtime.close is not available"
				);
			}
			await services.realtimeClose(input);
			return null;
		}
		case "social.open": {
			const input = asSocialOpenArg(args[0]);
			if (!services.socialOpen) {
				throw new CodedRpcError("server_error", "social.open is not available");
			}
			services.socialOpen(input);
			return null;
		}
		case "subtitles.request": {
			const input = asSubtitlesRequestArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"subtitles.request requires a { path: string } beginning with '/' and resolving under /api/subtitles"
				);
			}
			if (!services.subtitlesRequest) {
				throw new CodedRpcError(
					"server_error",
					"subtitles.request is not available"
				);
			}
			return await services.subtitlesRequest(input);
		}
		case "reasoning.request": {
			const input = asReasoningRequestArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"reasoning.request requires a { path: string } beginning with '/' and resolving under /api/reasoning"
				);
			}
			if (!services.reasoningRequest) {
				throw new CodedRpcError(
					"server_error",
					"reasoning.request is not available"
				);
			}
			return await services.reasoningRequest(input);
		}
		case "safeActions.request": {
			const input = asSafeActionsRequestArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"safeActions.request requires a relative { path, method? } under /api/tools/plans"
				);
			}
			if (!services.safeActionsRequest) {
				throw new CodedRpcError(
					"server_error",
					"safeActions.request is not available"
				);
			}
			return await services.safeActionsRequest(input);
		}
		case "rlm.request": {
			const input = asRlmRequestArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"rlm.request requires a { path: string } beginning with '/' and resolving under /api/rlm"
				);
			}
			if (!services.rlmRequest) {
				throw new CodedRpcError("server_error", "rlm.request is not available");
			}
			return await services.rlmRequest(input);
		}
		case "tuition.request": {
			const input = asTuitionRequestArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"tuition.request requires a { path: string } beginning with '/' and resolving under /api/tuition"
				);
			}
			if (!services.tuitionRequest) {
				throw new CodedRpcError(
					"server_error",
					"tuition.request is not available"
				);
			}
			return await services.tuitionRequest(input);
		}
		case "news.request": {
			const input = asNewsRequestArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"news.request requires a { path: string } beginning with '/' and resolving under /api/news"
				);
			}
			if (!services.newsRequest) {
				throw new CodedRpcError(
					"server_error",
					"news.request is not available"
				);
			}
			return await services.newsRequest(input);
		}
		case "blueprint.request": {
			const input = asBlueprintRequestArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"blueprint.request requires a { path: string } beginning with '/' and resolving under /api/blueprint"
				);
			}
			if (!services.blueprintRequest) {
				throw new CodedRpcError(
					"server_error",
					"blueprint.request is not available"
				);
			}
			return await services.blueprintRequest(input);
		}
		case "social.openList":
			if (!services.socialOpenList) {
				throw new CodedRpcError(
					"server_error",
					"social.openList is not available"
				);
			}
			services.socialOpenList();
			return null;
		case "skills.getSource": {
			const input = asSkillIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"skills.getSource requires a { id: string }"
				);
			}
			if (!services.skillsGetSource) {
				throw new CodedRpcError(
					"server_error",
					"skills.getSource is not available"
				);
			}
			return await services.skillsGetSource(input);
		}
		case "skills.create": {
			const input = asSkillDraftArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"skills.create requires a { name: string, body: string, … }"
				);
			}
			if (!services.skillsCreate) {
				throw new CodedRpcError(
					"server_error",
					"skills.create is not available"
				);
			}
			return await services.skillsCreate(input);
		}
		case "skills.update": {
			const input = asSkillUpdateArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"skills.update requires a { id: string, name: string, body: string, … }"
				);
			}
			if (!services.skillsUpdate) {
				throw new CodedRpcError(
					"server_error",
					"skills.update is not available"
				);
			}
			return await services.skillsUpdate(input);
		}
		case "skills.listVersions": {
			const input = asSkillIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"skills.listVersions requires a { id: string }"
				);
			}
			if (!services.skillsListVersions) {
				throw new CodedRpcError(
					"server_error",
					"skills.listVersions is not available"
				);
			}
			return await services.skillsListVersions(input);
		}
		case "skills.versionSource": {
			const input = asSkillVersionRefArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"skills.versionSource requires a { id: string, versionId: string }"
				);
			}
			if (!services.skillsVersionSource) {
				throw new CodedRpcError(
					"server_error",
					"skills.versionSource is not available"
				);
			}
			return await services.skillsVersionSource(input);
		}
		case "skills.snapshot": {
			const input = asSkillSnapshotArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"skills.snapshot requires a { id: string, label?: string }"
				);
			}
			if (!services.skillsSnapshot) {
				throw new CodedRpcError(
					"server_error",
					"skills.snapshot is not available"
				);
			}
			await services.skillsSnapshot(input);
			return null;
		}
		case "skills.restore": {
			const input = asSkillVersionRefArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"skills.restore requires a { id: string, versionId: string }"
				);
			}
			if (!services.skillsRestore) {
				throw new CodedRpcError(
					"server_error",
					"skills.restore is not available"
				);
			}
			await services.skillsRestore(input);
			return null;
		}
		case "skills.distribute": {
			const input = asSkillIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"skills.distribute requires a { id: string }"
				);
			}
			if (!services.skillsDistribute) {
				throw new CodedRpcError(
					"server_error",
					"skills.distribute is not available"
				);
			}
			await services.skillsDistribute(input);
			return null;
		}
		case "skills.setTitle": {
			const input = asSkillTitleArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"skills.setTitle requires a { title: string }"
				);
			}
			if (!services.skillsSetTitle) {
				throw new CodedRpcError(
					"server_error",
					"skills.setTitle is not available"
				);
			}
			services.skillsSetTitle(input);
			return null;
		}
		case "shell.openTab": {
			const input = asShellOpenTabArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"shell.openTab requires a { path: string }"
				);
			}
			if (!services.shellOpenTab) {
				throw new CodedRpcError(
					"server_error",
					"shell.openTab is not available"
				);
			}
			// The host service applies the route allowlist (a granted plugin may still
			// only open a safe first-party destination) and rejects otherwise.
			await services.shellOpenTab(input);
			return null;
		}
		default:
			// Unreachable: a method in METHOD_CAPABILITY must have a case here.
			throw new CapabilityError(`No handler for method: ${method}`);
	}
}

const TOAST_VARIANTS: ReadonlySet<ToastVariant> = new Set([
	"default",
	"success",
	"info",
	"warning",
	"error",
	"loading",
]);
const TOAST_SHOW_KEYS: ReadonlySet<string> = new Set([
	"title",
	"description",
	"variant",
	"duration",
]);
const TOAST_UPDATE_KEYS: ReadonlySet<string> = new Set([
	"id",
	...TOAST_SHOW_KEYS,
]);
const TOAST_DISMISS_KEYS: ReadonlySet<string> = new Set(["id"]);

function isToastDuration(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= TOAST_LIMITS.durationMinMs &&
		value <= TOAST_LIMITS.durationMaxMs
	);
}

function isToastVariant(value: unknown): value is ToastVariant {
	return typeof value === "string" && TOAST_VARIANTS.has(value as ToastVariant);
}

function hasOnlyKeys(
	candidate: Record<string, unknown>,
	allowed: ReadonlySet<string>
): boolean {
	return Object.keys(candidate).every((key) => allowed.has(key));
}

/** Validate a caller-local opaque toast id. It is bounded but otherwise has no
 * public structure: apps must only pass back an id returned by `show`. */
export function asToastId(value: unknown): string | null {
	return typeof value === "string" &&
		value.length > 0 &&
		value.length <= TOAST_LIMITS.idChars
		? value
		: null;
}

/** Strictly validate `ui.toast.show`. Unknown fields are rejected so actions,
 * renderer styles and placement cannot accidentally become an unofficial API. */
export function asToastShowArg(data: unknown): ToastShowInput | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return null;
	}
	const candidate = data as Record<string, unknown>;
	if (
		!hasOnlyKeys(candidate, TOAST_SHOW_KEYS) ||
		typeof candidate.title !== "string" ||
		candidate.title.trim().length === 0 ||
		candidate.title.length > TOAST_LIMITS.titleChars
	) {
		return null;
	}
	if (
		candidate.description !== undefined &&
		(typeof candidate.description !== "string" ||
			candidate.description.length > TOAST_LIMITS.descriptionChars)
	) {
		return null;
	}
	if (candidate.variant !== undefined && !isToastVariant(candidate.variant)) {
		return null;
	}
	if (
		candidate.duration !== undefined &&
		!isToastDuration(candidate.duration)
	) {
		return null;
	}
	const output: ToastShowInput = { title: candidate.title };
	if (typeof candidate.description === "string") {
		output.description = candidate.description;
	}
	if (isToastVariant(candidate.variant)) {
		output.variant = candidate.variant;
	}
	if (isToastDuration(candidate.duration)) {
		output.duration = candidate.duration;
	}
	return output;
}

/** Strictly validate `ui.toast.update`. At least one mutable field is required;
 * an empty description is valid and clears the existing description. */
export function asToastUpdateArg(data: unknown): ToastUpdateInput | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return null;
	}
	const candidate = data as Record<string, unknown>;
	const id = asToastId(candidate.id);
	if (!(hasOnlyKeys(candidate, TOAST_UPDATE_KEYS) && id)) {
		return null;
	}
	const hasTitle = Object.hasOwn(candidate, "title");
	const hasDescription = Object.hasOwn(candidate, "description");
	const hasVariant = Object.hasOwn(candidate, "variant");
	const hasDuration = Object.hasOwn(candidate, "duration");
	if (!(hasTitle || hasDescription || hasVariant || hasDuration)) {
		return null;
	}
	if (
		hasTitle &&
		(typeof candidate.title !== "string" ||
			candidate.title.trim().length === 0 ||
			candidate.title.length > TOAST_LIMITS.titleChars)
	) {
		return null;
	}
	if (
		hasDescription &&
		(typeof candidate.description !== "string" ||
			candidate.description.length > TOAST_LIMITS.descriptionChars)
	) {
		return null;
	}
	if (hasVariant && !isToastVariant(candidate.variant)) {
		return null;
	}
	if (hasDuration && !isToastDuration(candidate.duration)) {
		return null;
	}
	const output: ToastUpdateInput = { id };
	if (hasTitle) {
		output.title = candidate.title as string;
	}
	if (hasDescription) {
		output.description = candidate.description as string;
	}
	if (hasVariant) {
		output.variant = candidate.variant as ToastVariant;
	}
	if (hasDuration) {
		output.duration = candidate.duration as number;
	}
	return output;
}

/** Strictly validate `ui.toast.dismiss`; only one caller-local id is accepted. */
export function asToastDismissArg(data: unknown): ToastDismissInput | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return null;
	}
	const candidate = data as Record<string, unknown>;
	const id = asToastId(candidate.id);
	return id && hasOnlyKeys(candidate, TOAST_DISMISS_KEYS) ? { id } : null;
}

/** Narrow an RPC argument to a `{ prompt: string }`. Returns null for any other
 *  shape so a malformed follow-up never reaches the governed route. */
export function asPromptArg(data: unknown): { prompt: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const candidate = data as Record<string, unknown>;
	if (typeof candidate.prompt !== "string" || candidate.prompt.length === 0) {
		return null;
	}
	return { prompt: candidate.prompt };
}

// ── Assistant bridge argument validators ─────────────────────────────────────
//
// Everything an app publishes here ends up INSIDE a prompt sent to the user's
// model, on the user's budget, on every turn the context changes. So the caps
// below are not politeness — an uncapped `text` is a way to spend someone else's
// tokens, and an uncapped item count is a way to bury the user's actual question.
// Over-long values are TRUNCATED rather than rejected: a dashboard that grew one
// widget too many should lose a paragraph, not lose its context entirely.

/** Max context items one app may publish at once. */
const MAX_CONTEXT_ITEMS = 8;
/** Max characters per context item's body. */
const MAX_CONTEXT_TEXT = 8000;
/** Max characters for a short label (chip title, surface label). */
const MAX_LABEL = 120;
/** Max characters for an app-supplied preamble. */
const MAX_PREAMBLE = 4000;
/** Max advisory tool names / starter prompts a surface may declare. */
const MAX_LIST_ENTRIES = 12;

function clamp(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

/** Narrow `assistant.publishContext`'s argument to `{ items }`, dropping any
 *  malformed item and clamping the rest. Returns null only when the envelope
 *  itself is wrong (not an object / no `items` array). */
export function asAssistantContextArg(data: unknown): {
	items: { id: string; text: string; title: string }[];
} | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const raw = (data as Record<string, unknown>).items;
	if (!Array.isArray(raw)) {
		return null;
	}
	const items: { id: string; text: string; title: string }[] = [];
	for (const entry of raw.slice(0, MAX_CONTEXT_ITEMS)) {
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const c = entry as Record<string, unknown>;
		if (typeof c.id !== "string" || c.id.length === 0) {
			continue;
		}
		if (typeof c.title !== "string" || c.title.length === 0) {
			continue;
		}
		items.push({
			id: clamp(c.id, MAX_LABEL),
			title: clamp(c.title, MAX_LABEL),
			text: typeof c.text === "string" ? clamp(c.text, MAX_CONTEXT_TEXT) : "",
		});
	}
	return { items };
}

/** Narrow a string array argument, dropping non-strings and empties. */
function asStringList(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const out = raw
		.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
		.slice(0, MAX_LIST_ENTRIES)
		.map((v) => clamp(v, MAX_LABEL));
	return out.length > 0 ? out : undefined;
}

/** Narrow `assistant.registerSurface`'s argument. `label` is REQUIRED — an
 *  unlabelled takeover would leave the user staring at a chat that has silently
 *  changed whose instructions it is following. */
export function asAssistantSurfaceArg(data: unknown): {
	description?: string;
	label: string;
	preamble?: string;
	prompts?: string[];
	tools?: string[];
} | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const c = data as Record<string, unknown>;
	if (typeof c.label !== "string" || c.label.trim().length === 0) {
		return null;
	}
	const out: {
		description?: string;
		label: string;
		preamble?: string;
		prompts?: string[];
		tools?: string[];
	} = { label: clamp(c.label, MAX_LABEL) };
	if (typeof c.description === "string" && c.description.length > 0) {
		out.description = clamp(c.description, MAX_CONTEXT_TEXT);
	}
	if (typeof c.preamble === "string" && c.preamble.length > 0) {
		out.preamble = clamp(c.preamble, MAX_PREAMBLE);
	}
	const tools = asStringList(c.tools);
	if (tools) {
		out.tools = tools;
	}
	const prompts = asStringList(c.prompts);
	if (prompts) {
		out.prompts = prompts;
	}
	return out;
}

/** Narrow `assistant.open`'s argument. Everything is optional (a bare
 *  `assistant.open()` just shows the panel), so only a wrong TYPE fails. */
export function asAssistantOpenArg(data: unknown): {
	mode?: "floating" | "sidebar";
	prompt?: string;
} | null {
	if (data === undefined || data === null) {
		return {};
	}
	if (typeof data !== "object") {
		return null;
	}
	const c = data as Record<string, unknown>;
	const out: { mode?: "floating" | "sidebar"; prompt?: string } = {};
	if (c.mode === "floating" || c.mode === "sidebar") {
		out.mode = c.mode;
	}
	if (typeof c.prompt === "string" && c.prompt.trim().length > 0) {
		out.prompt = clamp(c.prompt, MAX_CONTEXT_TEXT);
	}
	return out;
}

/** Narrow a `shell.openTab` argument to `{ path, … }`. `path` must be a non-empty
 *  string; the optional `openTab` options are copied through only when well-typed.
 *  Returns null for any other shape. The host service (not this validator) enforces
 *  the route ALLOWLIST — this only guarantees the shape is safe to forward. */
export function asShellOpenTabArg(data: unknown): {
	path: string;
	title?: string;
	conversationId?: string;
	forceNew?: boolean;
	initialPrompt?: string;
	icon?: unknown;
} | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const c = data as Record<string, unknown>;
	if (typeof c.path !== "string" || c.path.length === 0) {
		return null;
	}
	const out: {
		path: string;
		title?: string;
		conversationId?: string;
		forceNew?: boolean;
		initialPrompt?: string;
		icon?: unknown;
	} = { path: c.path };
	if (typeof c.title === "string") {
		out.title = c.title;
	}
	if (typeof c.conversationId === "string") {
		out.conversationId = c.conversationId;
	}
	if (typeof c.forceNew === "boolean") {
		out.forceNew = c.forceNew;
	}
	if (typeof c.initialPrompt === "string") {
		out.initialPrompt = c.initialPrompt;
	}
	if ("icon" in c) {
		out.icon = c.icon ?? null;
	}
	return out;
}

/** Narrow an RPC argument to a valid display mode string (R6). Accepts either a
 *  bare string or a `{ mode }` object; returns null for anything else. */
export function asDisplayModeArg(
	data: unknown
): "inline" | "fullscreen" | "pip" | null {
	const raw =
		typeof data === "string"
			? data
			: typeof data === "object" && data !== null
				? (data as Record<string, unknown>).mode
				: undefined;
	if (raw === "inline" || raw === "fullscreen" || raw === "pip") {
		return raw;
	}
	return null;
}

/** Narrow an `ui.openExternal` argument to `{ href }` with an http(s) URL. Accepts a
 *  bare string, `{ href }`, or `{ url }`. Returns null for any other shape or a
 *  non-http(s) scheme, so the host never opens `javascript:`/`file:`/`data:` URLs. */
export function asOpenExternalArg(data: unknown): { href: string } | null {
	const raw =
		typeof data === "string"
			? data
			: typeof data === "object" && data !== null
				? ((data as Record<string, unknown>).href ??
					(data as Record<string, unknown>).url)
				: undefined;
	if (typeof raw !== "string" || raw.length === 0) {
		return null;
	}
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return null;
	}
	return { href: parsed.href };
}

/** Narrow to optional `{ accept?, multiple? }` for `ui.uploadFile`. */
export function asUploadFileArg(data: unknown): {
	accept?: string;
	multiple?: boolean;
} {
	if (!data || typeof data !== "object") {
		return {};
	}
	const obj = data as { accept?: unknown; multiple?: unknown };
	const out: { accept?: string; multiple?: boolean } = {};
	if (typeof obj.accept === "string" && obj.accept.trim()) {
		out.accept = obj.accept.trim();
	}
	if (typeof obj.multiple === "boolean") {
		out.multiple = obj.multiple;
	}
	return out;
}

/** Read an optional string field, returning `undefined` for absent and `null` for a
 *  present-but-non-string value (so the caller can reject the whole arg). */
function optionalString(
	obj: Record<string, unknown>,
	field: string
): string | null | undefined {
	if (!(field in obj) || obj[field] === undefined) {
		return undefined;
	}
	return typeof obj[field] === "string" ? (obj[field] as string) : null;
}

/** Read an optional finite non-negative number, `undefined` for absent, `null` for
 *  a present-but-invalid value. */
function optionalNonNegNumber(
	obj: Record<string, unknown>,
	field: string
): number | null | undefined {
	if (!(field in obj) || obj[field] === undefined) {
		return undefined;
	}
	const v = obj[field];
	return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Narrow an arg to `model.complete` input: `prompt` required non-empty; optional
 *  string fields must be strings if present. Returns null on any bad shape. */
export function asModelCompleteArg(data: unknown): {
	prompt: string;
	system?: string;
	model?: string;
	provider?: string;
	model_pref_key?: string;
	effort?: string;
} | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.prompt !== "string" || o.prompt.length === 0) {
		return null;
	}
	const out: {
		prompt: string;
		system?: string;
		model?: string;
		provider?: string;
		model_pref_key?: string;
		effort?: string;
	} = { prompt: o.prompt };
	for (const f of [
		"system",
		"model",
		"provider",
		"model_pref_key",
		"effort",
	] as const) {
		const v = optionalString(o, f);
		if (v === null) {
			return null;
		}
		if (v !== undefined) {
			out[f] = v;
		}
	}
	return out;
}

/** Narrow a shared catalog discovery request to one non-empty provider id. */
export function asCatalogModelsArg(data: unknown): {
	providerId: string;
} | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const providerId = (data as Record<string, unknown>).providerId;
	return typeof providerId === "string" && providerId.trim().length > 0
		? { providerId: providerId.trim() }
		: null;
}

/** Narrow a Chat Broadcast send to one existing conversation id and a bounded,
 * non-empty user message. The host performs the ACL check again on Core; this
 * validator only keeps malformed or oversized frame input off the transport. */
export function asChatSendArg(data: unknown): {
	conversationId: string;
	text: string;
} | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const input = data as Record<string, unknown>;
	const conversationId = input.conversationId;
	const text = input.text;
	if (
		typeof conversationId !== "string" ||
		conversationId.trim().length === 0 ||
		conversationId.length > 200 ||
		typeof text !== "string" ||
		text.trim().length === 0 ||
		text.length > 8000
	) {
		return null;
	}
	return { conversationId: conversationId.trim(), text };
}

/** Narrow an arg to `agent.run` input: `task` required non-empty; `agent_id`/`preset`
 *  optional strings; `wall_time_secs`/`max_tokens` optional finite non-negative. */
export function asAgentRunArg(data: unknown): {
	task: string;
	agent_id?: string;
	preset?: string;
	wall_time_secs?: number;
	max_tokens?: number;
} | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.task !== "string" || o.task.length === 0) {
		return null;
	}
	const out: {
		task: string;
		agent_id?: string;
		preset?: string;
		wall_time_secs?: number;
		max_tokens?: number;
	} = { task: o.task };
	for (const f of ["agent_id", "preset"] as const) {
		const v = optionalString(o, f);
		if (v === null) {
			return null;
		}
		if (v !== undefined) {
			out[f] = v;
		}
	}
	for (const f of ["wall_time_secs", "max_tokens"] as const) {
		const v = optionalNonNegNumber(o, f);
		if (v === null) {
			return null;
		}
		if (v !== undefined) {
			out[f] = v;
		}
	}
	return out;
}

/** Narrow an arg to `{ namespace?: string, key: string }` (storage get/delete). */
export function asStorageKeyArg(
	data: unknown
): { namespace?: string; key: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.key !== "string" || o.key.length === 0) {
		return null;
	}
	const ns = optionalString(o, "namespace");
	if (ns === null) {
		return null;
	}
	return ns === undefined ? { key: o.key } : { key: o.key, namespace: ns };
}

/** Narrow an arg to `storage.set` input. `value` MUST be a string — the bridge reads
 *  it via `as_str` and silently drops a non-string (data loss), so reject it here. */
export function asStorageSetArg(
	data: unknown
): { namespace?: string; key: string; value: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.key !== "string" || o.key.length === 0) {
		return null;
	}
	if (typeof o.value !== "string") {
		return null;
	}
	const ns = optionalString(o, "namespace");
	if (ns === null) {
		return null;
	}
	return ns === undefined
		? { key: o.key, value: o.value }
		: { key: o.key, value: o.value, namespace: ns };
}

/** Narrow an arg to `{ namespace?: string }` (storage.keys). Absent arg is valid. */
export function asStorageKeysArg(data: unknown): { namespace?: string } {
	if (typeof data !== "object" || data === null) {
		return {};
	}
	const o = data as Record<string, unknown>;
	const ns = optionalString(o, "namespace");
	return typeof ns === "string" ? { namespace: ns } : {};
}

/** Narrow an atomic KV update. `null` means absent for either comparison side. */
export function asStorageCompareAndSetArg(data: unknown): {
	namespace?: string;
	key: string;
	expected?: string | null;
	value?: string | null;
} | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.key !== "string" || o.key.length === 0) {
		return null;
	}
	const ns = optionalString(o, "namespace");
	if (ns === null) {
		return null;
	}
	for (const field of ["expected", "value"] as const) {
		const value = o[field];
		if (value !== undefined && value !== null && typeof value !== "string") {
			return null;
		}
	}
	return {
		...(ns === undefined ? {} : { namespace: ns }),
		key: o.key,
		...(o.expected === undefined
			? {}
			: { expected: o.expected as string | null }),
		...(o.value === undefined ? {} : { value: o.value as string | null }),
	};
}

/** How the node holds the key its apps seal under (`host.crypto_status`).
 *  Carries no key material — only which custody rung is live. `key_beside_data`
 *  is the one an app should actually branch on: true means the key sits in a file
 *  next to the data it protects, so sealing buys much less than it looks like. */
export interface CryptoStatus {
	key_beside_data: boolean;
	key_file?: string | null;
	keychain_account?: string | null;
	keychain_service?: string | null;
	source: string;
}

/** Narrow to `{ value: string }` (crypto.seal / crypto.open). Both take a single
 *  string: seal takes plaintext, open takes a value produced by seal. */
export function asCryptoValueArg(data: unknown): { value: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const value = (data as Record<string, unknown>).value;
	return typeof value === "string" ? { value } : null;
}

/** Narrow to `{ space_id: string, title: string }` (spaces.createDoc). */
export function asSpacesCreateArg(
	data: unknown
): { space_id: string; title: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (
		typeof o.space_id !== "string" ||
		o.space_id.length === 0 ||
		typeof o.title !== "string"
	) {
		return null;
	}
	return { space_id: o.space_id, title: o.title };
}

/** Narrow to `{ name: string, description?: string | null }` (spaces.ensureSpace). */
export function asSpacesEnsureArg(data: unknown): {
	name: string;
	description?: string | null;
} | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.name !== "string" || o.name.trim().length === 0) {
		return null;
	}
	const description = o.description;
	if (
		description !== undefined &&
		description !== null &&
		typeof description !== "string"
	) {
		return null;
	}
	return {
		name: o.name.trim(),
		...(description === undefined ? {} : { description }),
	};
}

/** Narrow to a bounded semantic Space query. */
export function asSpacesSearchArg(data: unknown): {
	space_id: string;
	query: string;
	limit?: number;
} | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (
		typeof o.space_id !== "string" ||
		o.space_id.trim().length === 0 ||
		typeof o.query !== "string" ||
		o.query.trim().length === 0
	) {
		return null;
	}
	const limit = o.limit;
	if (
		limit !== undefined &&
		(typeof limit !== "number" || !Number.isFinite(limit) || limit < 1)
	) {
		return null;
	}
	return {
		space_id: o.space_id.trim(),
		query: o.query.trim(),
		...(limit === undefined ? {} : { limit: Math.min(50, Math.floor(limit)) }),
	};
}

/** Narrow to `{ doc_id: string }` (spaces.getDoc / deleteDoc). */
export function asSpacesDocIdArg(data: unknown): { doc_id: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.doc_id !== "string" || o.doc_id.length === 0) {
		return null;
	}
	return { doc_id: o.doc_id };
}

/** Narrow to `{ doc_id, title?, source }` (spaces.updateDoc). `source` MUST be a
 *  string (JSON-stringify structured content yourself, like storage values). */
export function asSpacesUpdateArg(
	data: unknown
): { doc_id: string; title?: string; source: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (
		typeof o.doc_id !== "string" ||
		o.doc_id.length === 0 ||
		typeof o.source !== "string"
	) {
		return null;
	}
	const title = optionalString(o, "title");
	if (title === null) {
		return null;
	}
	return title === undefined
		? { doc_id: o.doc_id, source: o.source }
		: { doc_id: o.doc_id, title, source: o.source };
}

/** Narrow to `{ space_id: string }` (spaces.listDocs). */
export function asSpacesListArg(data: unknown): { space_id: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.space_id !== "string" || o.space_id.length === 0) {
		return null;
	}
	return { space_id: o.space_id };
}

/** Narrow to `media.image` input: `prompt` required non-empty; `count` optional
 *  finite non-negative; `size`/`provider`/`model` optional strings. */
export function asMediaImageArg(data: unknown): {
	prompt: string;
	count?: number;
	size?: string;
	provider?: string;
	model?: string;
	input_images?: string[];
} | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.prompt !== "string" || o.prompt.length === 0) {
		return null;
	}
	const out: {
		prompt: string;
		count?: number;
		size?: string;
		provider?: string;
		model?: string;
		input_images?: string[];
	} = { prompt: o.prompt };
	const count = optionalNonNegNumber(o, "count");
	if (count === null) {
		return null;
	}
	if (count !== undefined) {
		out.count = count;
	}
	for (const f of ["size", "provider", "model"] as const) {
		const v = optionalString(o, f);
		if (v === null) {
			return null;
		}
		if (v !== undefined) {
			out[f] = v;
		}
	}
	if ("input_images" in o && o.input_images !== undefined) {
		if (
			!Array.isArray(o.input_images) ||
			o.input_images.length > 16 ||
			o.input_images.some(
				(value) =>
					typeof value !== "string" ||
					value.length === 0 ||
					value.length > 16 * 1024 * 1024
			)
		) {
			return null;
		}
		out.input_images = o.input_images;
	}
	return out;
}

/** Narrow to `media.video` input: `prompt` required non-empty; `provider`/`model`
 *  optional strings. */
export function asMediaVideoArg(data: unknown): {
	prompt: string;
	provider?: string;
	model?: string;
} | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.prompt !== "string" || o.prompt.length === 0) {
		return null;
	}
	const out: { prompt: string; provider?: string; model?: string } = {
		prompt: o.prompt,
	};
	for (const f of ["provider", "model"] as const) {
		const v = optionalString(o, f);
		if (v === null) {
			return null;
		}
		if (v !== undefined) {
			out[f] = v;
		}
	}
	return out;
}

/** Narrow to `media.tts` input: `text` required non-empty; `engine`/`voice`/
 *  `language` optional strings; `speed` optional finite non-negative. */
export function asMediaTtsArg(data: unknown): {
	text: string;
	engine?: string;
	voice?: string;
	speed?: number;
	language?: string;
} | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.text !== "string" || o.text.length === 0) {
		return null;
	}
	const out: {
		text: string;
		engine?: string;
		voice?: string;
		speed?: number;
		language?: string;
	} = { text: o.text };
	for (const f of ["engine", "voice", "language"] as const) {
		const v = optionalString(o, f);
		if (v === null) {
			return null;
		}
		if (v !== undefined) {
			out[f] = v;
		}
	}
	const speed = optionalNonNegNumber(o, "speed");
	if (speed === null) {
		return null;
	}
	if (speed !== undefined) {
		out.speed = speed;
	}
	return out;
}

/** Narrow to `media.transcribe` input: `audio` required non-empty string (a
 *  `data:` URL); `filename` optional string. */
export function asMediaTranscribeArg(
	data: unknown
): { audio: string; filename?: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.audio !== "string" || o.audio.length === 0) {
		return null;
	}
	const filename = optionalString(o, "filename");
	if (filename === null) {
		return null;
	}
	return filename === undefined
		? { audio: o.audio }
		: { audio: o.audio, filename };
}

/** Narrow an arg to `{ query: string }` (assets.searchGifs). An empty query is
 *  valid (returns trending), so only the shape is checked. */
export function asAssetQueryArg(data: unknown): { query: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.query !== "string") {
		return null;
	}
	return { query: o.query };
}

/** Narrow an arg to `{ id: string }` (finetune.get / cancel / stream). */
export function asFinetuneIdArg(data: unknown): { id: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) {
		return null;
	}
	return { id: o.id };
}

/** Narrow an arg to a plain object record (finetune.start / merge job specs). The
 *  fields are forwarded VERBATIM to Core, which validates each defensively, so this
 *  only rejects non-objects. */
export function asRecordArg(data: unknown): Record<string, unknown> | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return null;
	}
	return data as Record<string, unknown>;
}

/** Narrow an arg to `{ id: string }` (monitors get/delete/run). */
export function asMonitorIdArg(data: unknown): { id: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) {
		return null;
	}
	return { id: o.id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCheckType(value: unknown): value is MonitorCheckType {
	if (!isRecord(value) || typeof value.type !== "string") {
		return false;
	}
	if (value.type === "uptime") {
		return (
			value.expect_status === undefined ||
			(Array.isArray(value.expect_status) &&
				value.expect_status.every((status) => typeof status === "number"))
		);
	}
	if (value.type === "keyword") {
		return (
			typeof value.pattern === "string" &&
			(value.is_regex === undefined || typeof value.is_regex === "boolean") &&
			(value.case_sensitive === undefined ||
				typeof value.case_sensitive === "boolean") &&
			(value.alert_when_present === undefined ||
				typeof value.alert_when_present === "boolean")
		);
	}
	if (value.type === "content_diff") {
		return (
			value.region_regex === undefined ||
			value.region_regex === null ||
			typeof value.region_regex === "string"
		);
	}
	if (value.type === "price") {
		return (
			typeof value.extract_regex === "string" &&
			(value.comparator === undefined ||
				[
					"changed",
					"less_than",
					"greater_than",
					"drops_by_pct",
					"rises_by_pct",
				].includes(value.comparator as string)) &&
			(value.threshold === undefined ||
				value.threshold === null ||
				typeof value.threshold === "number")
		);
	}
	if (value.type === "stock") {
		return (
			typeof value.in_stock_pattern === "string" &&
			(value.is_regex === undefined || typeof value.is_regex === "boolean") &&
			(value.alert_when_in_stock === undefined ||
				typeof value.alert_when_in_stock === "boolean")
		);
	}
	return false;
}

function isNotifyTarget(value: unknown): value is MonitorNotifyTarget {
	if (!isRecord(value) || typeof value.kind !== "string") {
		return false;
	}
	if (value.kind === "webhook") {
		return typeof value.url === "string";
	}
	if (value.kind === "telegram") {
		return (
			typeof value.bot_token === "string" && typeof value.chat_id === "string"
		);
	}
	if (value.kind === "expo_push") {
		return typeof value.token === "string";
	}
	return value.kind === "email" && typeof value.to === "string";
}

/** Narrow a monitor create/update payload to the canonical Core wire model while
 * preserving unknown fields for forward-compatible server validation. */
function isMonitorInput(value: unknown): value is MonitorInputPayload {
	if (!isRecord(value)) {
		return false;
	}
	return (
		(value.backend === "http" ||
			value.backend === "spider" ||
			value.backend === "agentbrowser") &&
		typeof value.check === "object" &&
		isCheckType(value.check) &&
		typeof value.enabled === "boolean" &&
		typeof value.interval === "string" &&
		typeof value.name === "string" &&
		Array.isArray(value.notify) &&
		value.notify.every(isNotifyTarget) &&
		typeof value.url === "string"
	);
}

export function asMonitorInputArg(data: unknown): MonitorInputPayload | null {
	return isMonitorInput(data) ? data : null;
}

/** Narrow a monitor update arg `{ id, input }`. The nested `input` is validated
 *  with {@link asMonitorInputArg}. */
export function asMonitorUpdateArg(
	data: unknown
): { id: string; input: MonitorInputPayload } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) {
		return null;
	}
	const input = asMonitorInputArg(o.input);
	if (!input) {
		return null;
	}
	return { id: o.id, input };
}

/** Narrow an arg to `{ id: string, limit?: number }` (monitors snapshots/alerts).
 *  `limit`, when present, must be a finite non-negative number. */
export function asMonitorListLimitArg(
	data: unknown
): { id: string; limit?: number } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) {
		return null;
	}
	const limit = optionalNonNegNumber(o, "limit");
	if (limit === null) {
		return null;
	}
	return limit === undefined ? { id: o.id } : { id: o.id, limit };
}

/** Narrow an arg to `{ id: string }` (quests complete/dismiss/delete/judge +
 *  suggestion accept/dismiss). */
export function asQuestIdArg(data: unknown): { id: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) {
		return null;
	}
	return { id: o.id };
}

/** Narrow an explicit-recipient Inbox notification payload. Core applies the
 *  authoritative length and membership bounds after the host gate. */
export function asNotificationSendArg(data: unknown): {
	body?: string;
	target_user_id: string;
	title: string;
} | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (
		typeof o.target_user_id !== "string" ||
		o.target_user_id.length === 0 ||
		typeof o.title !== "string" ||
		o.title.length === 0 ||
		(o.body !== undefined && typeof o.body !== "string")
	) {
		return null;
	}
	return {
		...(o.body === undefined ? {} : { body: o.body }),
		target_user_id: o.target_user_id,
		title: o.title,
	};
}

/** Read an optional boolean field off a loose arg object. Anything that is not a
 *  real boolean is dropped so the host applies its own default rather than
 *  coercing a truthy string into `true`. */
function asOptionalBoolean(data: unknown, key: string): boolean | undefined {
	if (typeof data !== "object" || data === null) {
		return undefined;
	}
	const v = (data as Record<string, unknown>)[key];
	return typeof v === "boolean" ? v : undefined;
}

/** Narrow an optional `{ kind?: string }` for `quests.list`. A missing or blank
 *  kind means "every kind", which is what the board asks for. */
export function asQuestListArg(data: unknown): { kind?: string } {
	if (typeof data !== "object" || data === null) {
		return {};
	}
	const kind = (data as Record<string, unknown>).kind;
	if (typeof kind !== "string" || kind.trim().length === 0) {
		return {};
	}
	return { kind };
}

/** Narrow a `quests.capture` arg. Only `body` is required; `kind`/`title` are
 *  inferred server-side when absent, and a source with no usable field is dropped
 *  rather than forwarded as an empty object. */
export function asQuestCaptureArg(data: unknown): {
	body: string;
	kind?: string;
	title?: string;
	source?: { app?: string; title?: string; url?: string };
} | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.body !== "string" || o.body.trim().length === 0) {
		return null;
	}
	const out: {
		body: string;
		kind?: string;
		title?: string;
		source?: { app?: string; title?: string; url?: string };
	} = { body: o.body };
	if (typeof o.kind === "string" && o.kind.length > 0) {
		out.kind = o.kind;
	}
	if (typeof o.title === "string" && o.title.length > 0) {
		out.title = o.title;
	}
	if (typeof o.source === "object" && o.source !== null) {
		const s = o.source as Record<string, unknown>;
		const source: { app?: string; title?: string; url?: string } = {};
		for (const key of ["app", "title", "url"] as const) {
			const v = s[key];
			if (typeof v === "string" && v.length > 0) {
				source[key] = v;
			}
		}
		if (Object.keys(source).length > 0) {
			out.source = source;
		}
	}
	return out;
}

/** Narrow a `quests.setScratchpad` arg to its text. An empty string is VALID
 *  (that is how the buffer is cleared), so this returns `null` only when the
 *  argument is not a `{ text: string }` at all. */
export function asQuestScratchpadArg(data: unknown): string | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const text = (data as Record<string, unknown>).text;
	return typeof text === "string" ? text : null;
}

/** Narrow an optional `{ limit?: number }` for `activity.list`. Missing/invalid
 *  limit is dropped (Core applies its own default cap), so this always returns a
 *  well-formed object — the read has no required argument. */
export function asActivityListArg(data: unknown): { limit?: number } {
	if (typeof data !== "object" || data === null) {
		return {};
	}
	const o = data as Record<string, unknown>;
	return typeof o.limit === "number" && Number.isFinite(o.limit)
		? { limit: o.limit }
		: {};
}

/** Narrow an optional background-process list arg. Core applies the running-only
 * default; invalid optional fields are dropped rather than widening the read. */
export function asBackgroundListArg(data: unknown): {
	producer?: string;
	running_only?: boolean;
} {
	if (typeof data !== "object" || data === null) {
		return {};
	}
	const o = data as Record<string, unknown>;
	const result: { producer?: string; running_only?: boolean } = {};
	if (typeof o.running_only === "boolean") {
		result.running_only = o.running_only;
	}
	if (typeof o.producer === "string" && o.producer.trim().length > 0) {
		result.producer = o.producer.trim();
	}
	return result;
}

/** Narrow a background stop arg so an empty id never reaches the Core queue. */
export function asBackgroundStopArg(
	data: unknown
): { process_id: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const processId = (data as Record<string, unknown>).process_id;
	if (typeof processId !== "string" || processId.trim().length === 0) {
		return null;
	}
	return { process_id: processId.trim() };
}

/** Narrow an RPC argument to a `{ session_id: string }` for `activity.openSession`.
 *  Returns null for any other shape so a malformed nav call never opens a tab. */
export function asActivitySessionArg(
	data: unknown
): { session_id: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.session_id !== "string" || o.session_id.length === 0) {
		return null;
	}
	return { session_id: o.session_id };
}

/** Narrow an RPC argument to a `{ rangeMinutes: number }` for `timeline.list`.
 *  Returns null for any other shape so a malformed read never reaches Shadow. */
export function asTimelineRangeArg(
	data: unknown
): { rangeMinutes: number } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.rangeMinutes !== "number" || !Number.isFinite(o.rangeMinutes)) {
		return null;
	}
	return { rangeMinutes: o.rangeMinutes };
}

/** Narrow an RPC argument to `{ rangeMinutes: number, narrate?: boolean }` for
 *  `timeline.journal`. A present non-boolean `narrate` is dropped (defaults off);
 *  a missing/invalid `rangeMinutes` rejects (null). */
export function asTimelineJournalArg(
	data: unknown
): { rangeMinutes: number; narrate?: boolean } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.rangeMinutes !== "number" || !Number.isFinite(o.rangeMinutes)) {
		return null;
	}
	return typeof o.narrate === "boolean"
		? { rangeMinutes: o.rangeMinutes, narrate: o.narrate }
		: { rangeMinutes: o.rangeMinutes };
}

/** Narrow an RPC argument to a `{ tsMicros: number }` for `timeline.frame`.
 *  Returns null for any other shape so a malformed keyframe read is rejected. */
export function asTimelineFrameArg(data: unknown): { tsMicros: number } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.tsMicros !== "number" || !Number.isFinite(o.tsMicros)) {
		return null;
	}
	return { tsMicros: o.tsMicros };
}

/** Parse an approval decide payload (`{ id, note? }`). The note is optional; a
 *  present non-string is dropped (never forwarded as a bad shape). */
export function asApprovalDecideArg(
	data: unknown
): ApprovalDecidePayload | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) {
		return null;
	}
	const out: ApprovalDecidePayload = { id: o.id };
	if (typeof o.note === "string") {
		out.note = o.note;
	}
	return out;
}

const SUGGESTION_FEEDBACK_KINDS = new Set([
	"thumbs_up",
	"thumbs_down",
	"dismiss",
]);

/** Parse a Shadow feedback payload (`{ kind, suggestion_type }`). */
export function asSuggestionFeedbackArg(
	data: unknown
): SuggestionFeedbackPayload | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (
		typeof o.kind !== "string" ||
		!SUGGESTION_FEEDBACK_KINDS.has(o.kind) ||
		typeof o.suggestion_type !== "string"
	) {
		return null;
	}
	return {
		kind: o.kind as SuggestionFeedbackPayload["kind"],
		suggestion_type: o.suggestion_type,
	};
}

/** Parse a chat-open navigation payload (`{ prompt: string }`). */
export function asOpenInChatArg(data: unknown): { prompt: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.prompt !== "string") {
		return null;
	}
	return { prompt: o.prompt };
}

/** Narrow an arg to `{ id: string }` (mail delete / rotate-secret). */
export function asMailIdArg(data: unknown): { id: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) {
		return null;
	}
	return { id: o.id };
}

/** Narrow an arg to `{ inboxId: string }` (mail messages / inbound URL). */
export function asMailInboxRefArg(data: unknown): { inboxId: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.inboxId !== "string" || o.inboxId.length === 0) {
		return null;
	}
	return { inboxId: o.inboxId };
}

/** Type guard: a value is a well-formed create-inbox payload. Only the shape
 *  (`name`+`address` strings) is checked — Core validates server-side. Written as
 *  a predicate so a matching value NARROWS to {@link MailCreatePayload} (no cast),
 *  which is what lets {@link asMailCreateArg} forward `data` verbatim (unknown
 *  fields survive) without the unsound `Record<string, unknown>` double-cast. */
function isMailCreatePayload(data: unknown): data is MailCreatePayload {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return false;
	}
	const o = data as Record<string, unknown>;
	return typeof o.name === "string" && typeof o.address === "string";
}

/** Narrow a mail create payload `{ name, address, provider? }`. Only the shape
 *  (`name`+`address` strings) is checked — Core validates server-side — and the
 *  whole object is forwarded verbatim so unknown fields survive. */
export function asMailCreateArg(data: unknown): MailCreatePayload | null {
	return isMailCreatePayload(data) ? data : null;
}

/** Narrow a mail send payload `{ inboxId, to, subject, text? }`. `to` must be a
 *  non-empty array of strings; `subject` a string (may be empty); `text` optional. */
export function asMailSendArg(data: unknown): MailSendPayload | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.inboxId !== "string" || o.inboxId.length === 0) {
		return null;
	}
	if (
		!Array.isArray(o.to) ||
		o.to.length === 0 ||
		!o.to.every((t) => typeof t === "string")
	) {
		return null;
	}
	if (typeof o.subject !== "string") {
		return null;
	}
	if (o.text !== undefined && typeof o.text !== "string") {
		return null;
	}
	return {
		inboxId: o.inboxId,
		to: o.to as string[],
		subject: o.subject,
		...(o.text === undefined ? {} : { text: o.text as string }),
	};
}

/** Narrow an RPC argument to a `{ id: string }` for `meetings.transcript`/`finalize`/
 *  `delete`. Returns null for any other shape so a malformed call never reaches Core. */
export function asMeetingIdArg(data: unknown): { id: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) {
		return null;
	}
	return { id: o.id };
}

/** Narrow an optional `{ source?, app?, title? }` for `meetings.start`. Missing/invalid
 *  fields are dropped (Core applies its own defaults), so this always returns a
 *  well-formed object — the start has no required argument. */
export function asMeetingStartArg(data: unknown): MeetingStartPayload {
	if (typeof data !== "object" || data === null) {
		return {};
	}
	const o = data as Record<string, unknown>;
	return {
		...(typeof o.source === "string" ? { source: o.source } : {}),
		...(typeof o.app === "string" ? { app: o.app } : {}),
		...(typeof o.title === "string" ? { title: o.title } : {}),
	};
}

/** Methods `social.request` will forward. A closed set, so the frame cannot reach the
 *  sidecar with a verb its router does not serve (PUT, HEAD, or an arbitrary string). */
const SOCIAL_METHODS = new Set(["GET", "POST", "PATCH", "DELETE"]);
const APP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** The mount Core serves the `ryu-social` sidecar on. Mirrors `SOCIAL_MOUNT` in
 *  `apps/desktop/src/lib/api/social.ts`, which is the layer that actually builds the
 *  URL — this one validates the same string one hop earlier. */
const SOCIAL_MOUNT = "/api/social";

/** A base that exists only to give `new URL()` something to resolve against. Never
 *  reaches a socket; only `pathname`/`search` are read off the result. */
const SOCIAL_PARSE_BASE = "http://social.invalid";

/** Resolve a frame-supplied sub-path against the mount with the SAME parser `fetch`
 *  will use, and return the normalized `pathname + search`, or null when it does not
 *  land under the mount.
 *
 *  This replaces a literal `/(^|\/)\.\.(\/|$)/` blocklist. The blocklist matched the
 *  raw string, but `fetch` acts on the WHATWG URL parser's output, and that parser
 *  also collapses `%2e%2e`, `%2E%2E`, `.%2e` and `%2e.` into double-dot segments — so
 *  `/%2e%2e/settings` passed the check and left the desktop addressed to
 *  `/api/settings`, with the node bearer attached and Core's own dot-segment guard
 *  already bypassed. Enumerating encodings is a race the blocklist loses; agreeing
 *  with the parser is not. */
function resolveMountedRequestPath(mount: string, path: string): string | null {
	let url: URL;
	try {
		url = new URL(`${mount}${path}`, SOCIAL_PARSE_BASE);
	} catch {
		return null;
	}
	if (url.pathname !== mount && !url.pathname.startsWith(`${mount}/`)) {
		return null;
	}
	// Hand back the path RELATIVE to the mount, because that is what the payload's
	// `path` means to every consumer — and normalized, so the host below can never
	// re-derive a different one from the frame's raw string.
	const rest = url.pathname.slice(mount.length);
	return `${rest || "/"}${url.search}`;
}

function resolveSocialRequestPath(path: string): string | null {
	return resolveMountedRequestPath(SOCIAL_MOUNT, path);
}

/** Validate the relative half of an own-app request. A synthetic fixed mount lets
 * the same WHATWG containment check catch encoded dot segments before the trusted
 * host attaches credentials and the real owning plugin id. */
export function asAppRequestArg(data: unknown): AppRequestPayload | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const value = data as Record<string, unknown>;
	if (
		typeof value.path !== "string" ||
		!value.path.startsWith("/") ||
		value.path.startsWith("//") ||
		value.path.includes("\\")
	) {
		return null;
	}
	const path = resolveMountedRequestPath("/api/ext/app", value.path);
	if (!path) {
		return null;
	}
	const method = value.method ?? "GET";
	if (typeof method !== "string" || !APP_METHODS.has(method)) {
		return null;
	}
	return {
		path,
		method: method as AppRequestPayload["method"],
		...(value.body === undefined ? {} : { body: value.body }),
	};
}

function nonEmptyString(value: unknown, maxLength = 512): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= maxLength
	);
}

/** Narrow a generic application-room connect payload. */
export function asRealtimeConnectArg(
	data: unknown
): RealtimeConnectPayload | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return null;
	}
	const value = data as Record<string, unknown>;
	return nonEmptyString(value.room_id)
		? { room_id: value.room_id.trim() }
		: null;
}

/** Narrow a host-owned connection reference. */
export function asRealtimeConnectionArg(
	data: unknown
): RealtimeConnectionPayload | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return null;
	}
	const value = data as Record<string, unknown>;
	return nonEmptyString(value.connection_id, 128)
		? { connection_id: value.connection_id }
		: null;
}

/** Narrow a named event publish payload. */
export function asRealtimePublishArg(
	data: unknown
): RealtimePublishPayload | null {
	const connection = asRealtimeConnectionArg(data);
	if (!connection || typeof data !== "object" || data === null) {
		return null;
	}
	const value = data as Record<string, unknown>;
	return nonEmptyString(value.event, 128)
		? { ...connection, event: value.event.trim(), data: value.data }
		: null;
}

/** Narrow a presence payload while preserving its opaque app-owned data. */
export function asRealtimePresenceArg(
	data: unknown
): RealtimePresencePayload | null {
	const connection = asRealtimeConnectionArg(data);
	if (!connection || typeof data !== "object" || data === null) {
		return null;
	}
	return {
		...connection,
		data: (data as Record<string, unknown>).data,
	};
}

/**
 * Narrow an RPC argument to a `social.request` payload, or null.
 *
 * This is the security boundary for the generic forwarder, so it is deliberately
 * strict about `path` — the frame picks a SUB-PATH of `/api/social` and nothing else:
 *
 *  - must be a non-empty string starting with `/`, which rejects `"https://evil/x"`,
 *    `"//evil/x"` (protocol-relative — it would resolve against the node's origin as a
 *    different HOST), and any bare-relative path;
 *  - must carry no `\` (a backslash is a path separator to some URL parsers and not to
 *    others, which is exactly how a traversal slips past a `/`-only check);
 *  - must RESOLVE to a path under `/api/social` — see
 *    {@link resolveSocialRequestPath}. The returned `path` is the normalized one, not
 *    the frame's raw string, so nothing downstream can re-derive a different target.
 *
 * `method` falls back to `"GET"`; anything outside {@link SOCIAL_METHODS} is refused
 * rather than silently downgraded. `body` is passed through untouched — it is JSON the
 * sidecar validates, not something this layer can meaningfully check.
 */
export function asSocialRequestArg(data: unknown): SocialRequestPayload | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	const path = o.path;
	if (typeof path !== "string" || !path.startsWith("/")) {
		return null;
	}
	if (path.startsWith("//") || path.includes("\\")) {
		return null;
	}
	const resolved = resolveSocialRequestPath(path);
	if (resolved === null) {
		return null;
	}
	let method: SocialRequestPayload["method"] = "GET";
	if (o.method !== undefined) {
		if (typeof o.method !== "string" || !SOCIAL_METHODS.has(o.method)) {
			return null;
		}
		method = o.method as SocialRequestPayload["method"];
	}
	return {
		path: resolved,
		method,
		...(o.body === undefined ? {} : { body: o.body }),
	};
}

/** Methods `reasoning.request` will forward. `PUT` instead of Outpost's `PATCH`,
 *  matching the sidecar's policy-update route; a verb outside this set is refused
 *  rather than downgraded to GET. */
const REASONING_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);

/** The mount Core serves the `ryu-reasoning` sidecar on. Mirrors `REASONING_MOUNT` in
 *  `apps/desktop/src/lib/api/reasoning.ts`, which is the layer that actually builds
 *  the URL — this one validates the same string one hop earlier. */
const REASONING_MOUNT = "/api/reasoning";

/**
 * Narrow an RPC argument to a `reasoning.request` payload, or null.
 *
 * The same security boundary as {@link asSocialRequestArg}, against the reasoning
 * mount — and deliberately routed through the SAME {@link resolveMountedRequestPath}
 * rather than a second copy of it. That resolver exists because a literal `..`
 * blocklist loses to the WHATWG URL parser's own decoding (`%2e%2e` and friends
 * collapse into dot segments after the check runs), and a re-implementation is exactly
 * where that lesson gets lost a second time.
 */
export function asReasoningRequestArg(
	data: unknown
): ReasoningRequestPayload | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	const path = o.path;
	if (typeof path !== "string" || !path.startsWith("/")) {
		return null;
	}
	if (path.startsWith("//") || path.includes("\\")) {
		return null;
	}
	const resolved = resolveMountedRequestPath(REASONING_MOUNT, path);
	if (resolved === null) {
		return null;
	}
	let method: ReasoningRequestPayload["method"] = "GET";
	if (o.method !== undefined) {
		if (typeof o.method !== "string" || !REASONING_METHODS.has(o.method)) {
			return null;
		}
		method = o.method as ReasoningRequestPayload["method"];
	}
	return {
		path: resolved,
		method,
		...(o.body === undefined ? {} : { body: o.body }),
	};
}

const SAFE_ACTIONS_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);
const SAFE_ACTIONS_MOUNT = "/api/tools/plans";

/** Validate a frame-chosen Safe Actions sub-path with the same URL-parser
 * containment rule used by the other fixed-mount companion bridges. */
export function asSafeActionsRequestArg(
	data: unknown
): SafeActionsRequestPayload | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const value = data as Record<string, unknown>;
	if (
		typeof value.path !== "string" ||
		!value.path.startsWith("/") ||
		value.path.startsWith("//") ||
		value.path.includes("\\") ||
		value.path.includes("?") ||
		value.path.includes("#")
	) {
		return null;
	}
	const path = resolveMountedRequestPath(SAFE_ACTIONS_MOUNT, value.path);
	if (path === null) {
		return null;
	}
	let method: SafeActionsRequestPayload["method"] = "GET";
	if (value.method !== undefined) {
		if (
			typeof value.method !== "string" ||
			!SAFE_ACTIONS_METHODS.has(value.method)
		) {
			return null;
		}
		method = value.method as SafeActionsRequestPayload["method"];
	}
	return {
		path,
		method,
		...(value.body === undefined ? {} : { body: value.body }),
	};
}

/** Methods `rlm.request` will forward. The companion creates contexts (POST),
 *  reads them (GET) and deletes them (DELETE); nothing is edited in place, because a
 *  context is immutable by construction — but PUT is accepted so a future route does
 *  not need a change here. A verb outside this set is refused rather than downgraded
 *  to GET. */
const RLM_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);

/** The mount Core serves the `ryu-rlm` sidecar on. Mirrors `RLM_MOUNT` in
 *  `apps/desktop/src/lib/api/rlm.ts`, which is the layer that actually builds the
 *  URL — this one validates the same string one hop earlier. */
const RLM_MOUNT = "/api/rlm";

/**
 * Narrow an RPC argument to an `rlm.request` payload, or null.
 *
 * The same security boundary as {@link asReasoningRequestArg}, against the RLM mount
 * — and deliberately routed through the SAME {@link resolveMountedRequestPath} rather
 * than a second copy of it. That resolver exists because a literal `..` blocklist
 * loses to the WHATWG URL parser's own decoding (`%2e%2e` and friends collapse into
 * dot segments after the check runs), and a re-implementation is exactly where that
 * lesson gets lost a second time.
 */
export function asRlmRequestArg(data: unknown): RlmRequestPayload | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	const path = o.path;
	if (typeof path !== "string" || !path.startsWith("/")) {
		return null;
	}
	if (path.startsWith("//") || path.includes("\\")) {
		return null;
	}
	const resolved = resolveMountedRequestPath(RLM_MOUNT, path);
	if (resolved === null) {
		return null;
	}
	let method: RlmRequestPayload["method"] = "GET";
	if (o.method !== undefined) {
		if (typeof o.method !== "string" || !RLM_METHODS.has(o.method)) {
			return null;
		}
		method = o.method as RlmRequestPayload["method"];
	}
	return {
		path: resolved,
		method,
		...(o.body === undefined ? {} : { body: o.body }),
	};
}

/** Methods `tuition.request` and `news.request` will forward. Both surfaces patch in
 *  place (a skill's name, a source's title) and replace whole documents (settings), so
 *  both verbs are here. A verb outside the set is refused rather than downgraded to
 *  GET, so a frame asking for one gets an error instead of silently reading where it
 *  meant to write. */
const APP_CRUD_METHODS = new Set(["DELETE", "GET", "PATCH", "POST", "PUT"]);

/** The mount Core serves the `ryu-tuition` sidecar on. Mirrors `TUITION_MOUNT` in
 *  `apps/desktop/src/lib/api/tuition.ts`, which is the layer that actually builds the
 *  URL — this one validates the same string one hop earlier. Two copies on purpose:
 *  either layer alone would be the only thing between a sandboxed frame and the node's
 *  credentials. */
const TUITION_MOUNT = "/api/tuition";

/** The mount Core serves the `ryu-news` sidecar on. See {@link TUITION_MOUNT}. */
const NEWS_MOUNT = "/api/news";

/**
 * Narrow an RPC argument to a `tuition.request` payload, or null.
 *
 * The same security boundary as {@link asReasoningRequestArg}, against the tuition
 * mount — and deliberately routed through the SAME {@link resolveMountedRequestPath}
 * rather than a second copy of it. That resolver exists because a literal `..`
 * blocklist loses to the WHATWG URL parser's own decoding (`%2e%2e` and friends
 * collapse into dot segments after the check runs), and a re-implementation is exactly
 * where that lesson gets lost a second time.
 */
export function asTuitionRequestArg(
	data: unknown
): TuitionRequestPayload | null {
	return asMountedCrudArg(data, TUITION_MOUNT) as TuitionRequestPayload | null;
}

/** Narrow an RPC argument to a `news.request` payload, or null. Same boundary and the
 *  same shared resolver as {@link asTuitionRequestArg}. */
export function asNewsRequestArg(data: unknown): NewsRequestPayload | null {
	return asMountedCrudArg(data, NEWS_MOUNT) as NewsRequestPayload | null;
}

/** The mount Core serves the `ryu-subtitles` sidecar on. Mirrors `SUBTITLES_MOUNT` in
 *  `apps/desktop/src/lib/api/subtitles.ts`, which is the layer that actually builds
 *  the URL — this one validates the same string one hop earlier. */
const SUBTITLES_MOUNT = "/api/subtitles";

/** Methods `subtitles.request` will forward. No PATCH: nothing in this app edits a
 *  field in place, and a verb outside this set is refused rather than downgraded to
 *  GET, so a frame asking for one gets an error instead of silently reading where it
 *  meant to write. */
const SUBTITLES_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);

/**
 * Narrow an RPC argument to a `subtitles.request` payload, or null.
 *
 * The same security boundary as {@link asReasoningRequestArg}, against the subtitles
 * mount — and deliberately routed through the SAME {@link resolveMountedRequestPath}
 * rather than a second copy of it. That resolver exists because a literal `..`
 * blocklist loses to the WHATWG URL parser's own decoding (`%2e%2e` and friends
 * collapse into dot segments after the check runs), and a re-implementation is exactly
 * where that lesson gets lost a second time.
 */
export function asSubtitlesRequestArg(
	data: unknown
): SubtitlesRequestPayload | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	const path = o.path;
	if (typeof path !== "string" || !path.startsWith("/")) {
		return null;
	}
	if (path.startsWith("//") || path.includes("\\")) {
		return null;
	}
	const resolved = resolveMountedRequestPath(SUBTITLES_MOUNT, path);
	if (resolved === null) {
		return null;
	}
	let method: SubtitlesRequestPayload["method"] = "GET";
	if (o.method !== undefined) {
		if (typeof o.method !== "string" || !SUBTITLES_METHODS.has(o.method)) {
			return null;
		}
		method = o.method as SubtitlesRequestPayload["method"];
	}
	return {
		path: resolved,
		method,
		...(o.body === undefined ? {} : { body: o.body }),
	};
}

/** The shared body of the two validators above. Shared between THEM only — not with
 *  the reasoning or social validators, whose method unions differ — so that widening
 *  one app's verbs cannot silently widen another's. */
function asMountedCrudArg(
	data: unknown,
	mount: string
): { body?: unknown; method?: string; path: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	const path = o.path;
	if (typeof path !== "string" || !path.startsWith("/")) {
		return null;
	}
	if (path.startsWith("//") || path.includes("\\")) {
		return null;
	}
	const resolved = resolveMountedRequestPath(mount, path);
	if (resolved === null) {
		return null;
	}
	let method = "GET";
	if (o.method !== undefined) {
		if (typeof o.method !== "string" || !APP_CRUD_METHODS.has(o.method)) {
			return null;
		}
		method = o.method;
	}
	return {
		path: resolved,
		method,
		...(o.body === undefined ? {} : { body: o.body }),
	};
}

/** Methods `blueprint.request` will forward — three, not four: the plan-review
 *  surface never edits in place (see {@link BlueprintRequestPayload}), so there is no
 *  PUT and no PATCH to accept. A verb outside this set is refused rather than
 *  downgraded to GET, so a frame asking for one gets an error instead of silently
 *  reading where it meant to write. */
const BLUEPRINT_METHODS = new Set(["GET", "POST", "DELETE"]);

/** The mount Core serves the `ryu-blueprint` sidecar on. Mirrors `BLUEPRINT_MOUNT` in
 *  `apps/desktop/src/lib/api/blueprint.ts`, which is the layer that actually builds
 *  the URL — this one validates the same string one hop earlier. */
const BLUEPRINT_MOUNT = "/api/blueprint";

/**
 * Narrow an RPC argument to a `blueprint.request` payload, or null.
 *
 * The same security boundary as {@link asReasoningRequestArg}, against the blueprint
 * mount, and through the SAME {@link resolveMountedRequestPath} for the same reason:
 * a literal `..` blocklist loses to the WHATWG URL parser's own decoding (`%2e%2e`
 * and friends collapse into dot segments after the check runs), and each
 * re-implementation is a fresh chance to lose that lesson.
 *
 * It matters more here than it reads: plan ids are attacker-adjacent. They arrive
 * from whatever an agent passed to `plan_publish`, they appear in every path this
 * verb builds (`/plans/:id/annotations`), and the frame is the one assembling the
 * string. The sidecar validates ids again on its side — this is the outer half of
 * that pair, not a substitute for it.
 */
export function asBlueprintRequestArg(
	data: unknown
): BlueprintRequestPayload | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	const path = o.path;
	if (typeof path !== "string" || !path.startsWith("/")) {
		return null;
	}
	if (path.startsWith("//") || path.includes("\\")) {
		return null;
	}
	const resolved = resolveMountedRequestPath(BLUEPRINT_MOUNT, path);
	if (resolved === null) {
		return null;
	}
	let method: BlueprintRequestPayload["method"] = "GET";
	if (o.method !== undefined) {
		if (typeof o.method !== "string" || !BLUEPRINT_METHODS.has(o.method)) {
			return null;
		}
		method = o.method as BlueprintRequestPayload["method"];
	}
	return {
		path: resolved,
		method,
		...(o.body === undefined ? {} : { body: o.body }),
	};
}

/** Narrow an RPC argument to a `social.open` payload. Total rather than nullable: both
 *  fields are optional (no id opens the Outpost tab itself), so there is no shape a
 *  navigation verb should refuse — a bad field is simply dropped.
 *
 *  Deliberately only `postId` and `title`. The frame ALSO reads
 *  `window.ryu.context.section`, but that arrives through the mount context, not
 *  through this verb — accepting a `section` here would be an argument the host silently
 *  drops, which is how a verb becomes decorative. */
export function asSocialOpenArg(data: unknown): {
	postId?: string;
	title?: string;
} {
	if (typeof data !== "object" || data === null) {
		return {};
	}
	const o = data as Record<string, unknown>;
	return {
		...(typeof o.postId === "string" && o.postId.length > 0
			? { postId: o.postId }
			: {}),
		...(typeof o.title === "string" ? { title: o.title } : {}),
	};
}

/** Narrow an RPC argument to `{ id: string, title: string }` for `meetings.rename`.
 *  Returns null for any other shape so a malformed rename never reaches Core. */
export function asMeetingRenameArg(
	data: unknown
): { id: string; title: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) {
		return null;
	}
	if (typeof o.title !== "string") {
		return null;
	}
	return { id: o.id, title: o.title };
}

/** Narrow an RPC argument to `{ id: string, icon: unknown | null }` for
 *  `meetings.setIcon`. `icon` may be null (clear) or any JSON glyph object. */
export function asMeetingSetIconArg(
	data: unknown
): { id: string; icon: unknown | null } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) {
		return null;
	}
	if (!("icon" in o)) {
		return null;
	}
	return { id: o.id, icon: o.icon ?? null };
}

/** Narrow an RPC argument to `{ id: string, title? }` for the `meetings.open`
 *  shell-navigation verb. Returns null for any other shape so a malformed nav call
 *  never opens a tab. */
export function asMeetingOpenArg(
	data: unknown
): { id: string; title?: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) {
		return null;
	}
	return {
		id: o.id,
		...(typeof o.title === "string" ? { title: o.title } : {}),
	};
}

/** Narrow an RPC argument to `{ spaceId, docId, title? }` for the `meetings.openNotes`
 *  shell-navigation verb. Returns null for any other shape so a malformed nav call
 *  never opens a tab. */
export function asMeetingOpenNotesArg(
	data: unknown
): { spaceId: string; docId: string; title?: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.spaceId !== "string" || o.spaceId.length === 0) {
		return null;
	}
	if (typeof o.docId !== "string" || o.docId.length === 0) {
		return null;
	}
	return {
		spaceId: o.spaceId,
		docId: o.docId,
		...(typeof o.title === "string" ? { title: o.title } : {}),
	};
}

/** Narrow an RPC argument to a `{ id: string }` for skill reads/distribution.
 *  Returns null for any other shape so a malformed read never reaches Core. */
export function asSkillIdArg(data: unknown): { id: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) {
		return null;
	}
	return { id: o.id };
}

/** Narrow the shared skill-draft fields (`name` + `body` required; `description`/
 *  `allowedTools`/`alwaysOn` optional, invalid-typed ones dropped). Returns null when
 *  a required field is missing so a malformed write never reaches Core. */
function pickSkillDraft(o: Record<string, unknown>): SkillDraftPayload | null {
	if (typeof o.name !== "string" || o.name.length === 0) {
		return null;
	}
	if (typeof o.body !== "string") {
		return null;
	}
	const out: SkillDraftPayload = { name: o.name, body: o.body };
	if (typeof o.description === "string") {
		out.description = o.description;
	} else if (o.description === null) {
		out.description = null;
	}
	if (
		Array.isArray(o.allowedTools) &&
		o.allowedTools.every((t) => typeof t === "string")
	) {
		out.allowedTools = o.allowedTools as string[];
	}
	if (typeof o.alwaysOn === "boolean") {
		out.alwaysOn = o.alwaysOn;
	}
	return out;
}

/** Narrow a `skills.create` payload (a bare {@link SkillDraftPayload}). */
export function asSkillDraftArg(data: unknown): SkillDraftPayload | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return null;
	}
	return pickSkillDraft(data as Record<string, unknown>);
}

/** Narrow a `skills.update` payload (`{ id }` + a {@link SkillDraftPayload}). */
export function asSkillUpdateArg(
	data: unknown
): ({ id: string } & SkillDraftPayload) | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) {
		return null;
	}
	const draft = pickSkillDraft(o);
	if (!draft) {
		return null;
	}
	return { id: o.id, ...draft };
}

/** Narrow an RPC argument to `{ id, versionId }` for `skills.versionSource`/`restore`. */
export function asSkillVersionRefArg(
	data: unknown
): { id: string; versionId: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) {
		return null;
	}
	if (typeof o.versionId !== "string" || o.versionId.length === 0) {
		return null;
	}
	return { id: o.id, versionId: o.versionId };
}

/** Narrow a `skills.snapshot` payload (`{ id, label? }`; a non-string label dropped). */
export function asSkillSnapshotArg(
	data: unknown
): { id: string; label?: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) {
		return null;
	}
	return typeof o.label === "string"
		? { id: o.id, label: o.label }
		: { id: o.id };
}

/** Narrow a `skills.setTitle` payload (`{ title: string }`). Returns null for any
 *  other shape so a malformed nav call never renames the tab. */
export function asSkillTitleArg(data: unknown): { title: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.title !== "string" || o.title.length === 0) {
		return null;
	}
	return { title: o.title };
}

/** Narrow a calendar New-automation payload `{ agentId, agentName,
 *  conversationId?, schedule, requireApproval? }`. The `schedule` must be a tagged `{ kind: "cron", expr }` or
 *  `{ kind: "every", interval }`; Core validates the cron/interval server-side. Any
 *  other shape returns null so a malformed call never reaches the composite. */
export function asCalendarCreateAutomationArg(
	data: unknown
): CalendarCreateAutomationPayload | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.agentId !== "string" || o.agentId.length === 0) {
		return null;
	}
	if (typeof o.agentName !== "string") {
		return null;
	}
	if (typeof o.schedule !== "object" || o.schedule === null) {
		return null;
	}
	const s = o.schedule as Record<string, unknown>;
	let schedule: CalendarCreateAutomationPayload["schedule"];
	if (s.kind === "cron" && typeof s.expr === "string") {
		schedule = { kind: "cron", expr: s.expr };
	} else if (s.kind === "every" && typeof s.interval === "string") {
		schedule = { kind: "every", interval: s.interval };
	} else {
		return null;
	}
	if (
		o.requireApproval !== undefined &&
		typeof o.requireApproval !== "boolean"
	) {
		return null;
	}
	if (
		o.conversationId !== undefined &&
		o.conversationId !== null &&
		(typeof o.conversationId !== "string" || o.conversationId.length === 0)
	) {
		return null;
	}
	return {
		agentId: o.agentId,
		agentName: o.agentName,
		...(o.conversationId === undefined
			? {}
			: { conversationId: o.conversationId as string | null }),
		schedule,
		...(o.requireApproval === undefined
			? {}
			: { requireApproval: o.requireApproval as boolean }),
	};
}

/**
 * Narrow the job list `warmup.apply` replaces this app's schedule with.
 *
 * Deliberately reconstructs each entry field by field rather than forwarding the
 * object: the frame must not be able to widen this capability past what it is
 * for. `target` is pinned to `agent` (a workflow or monitor target would let a
 * warmup grant schedule arbitrary work), and the owning app id is NOT read from
 * the input at all — the host stamps it, so the frame cannot claim ownership of
 * another app's jobs and have the same call delete them.
 *
 * Cron expressions, intervals and zone names are left to Core, which already
 * validates all three and answers 400 with a message the app surfaces.
 */
export function asWarmupJobsArg(data: unknown): WarmupJobInput[] | null {
	if (!Array.isArray(data)) {
		return null;
	}
	const jobs: WarmupJobInput[] = [];
	for (const item of data) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			return null;
		}
		const o = item as Record<string, unknown>;
		if (typeof o.name !== "string" || o.name.length === 0) {
			return null;
		}
		if (typeof o.schedule !== "object" || o.schedule === null) {
			return null;
		}
		const s = o.schedule as Record<string, unknown>;
		let schedule: WarmupJobInput["schedule"];
		if (s.kind === "cron" && typeof s.expr === "string") {
			schedule =
				typeof s.tz === "string" && s.tz.length > 0
					? { kind: "cron", expr: s.expr, tz: s.tz }
					: { kind: "cron", expr: s.expr };
		} else if (s.kind === "every" && typeof s.interval === "string") {
			schedule = { kind: "every", interval: s.interval };
		} else {
			return null;
		}
		if (typeof o.target !== "object" || o.target === null) {
			return null;
		}
		const t = o.target as Record<string, unknown>;
		if (
			t.type !== "agent" ||
			typeof t.agentId !== "string" ||
			t.agentId.length === 0 ||
			typeof t.prompt !== "string"
		) {
			return null;
		}
		jobs.push({
			name: o.name,
			schedule,
			target: {
				type: "agent",
				agentId: t.agentId,
				prompt: t.prompt,
				...(typeof t.model === "string" && t.model.length > 0
					? { model: t.model }
					: {}),
			},
		});
	}
	return jobs;
}

/**
 * Narrow the one-off `warmup.runNow` payload.
 *
 * It names an existing job rather than describing a turn, so what the button
 * proves is what the schedule will actually do — and so the capability cannot be
 * used to run an arbitrary prompt on an arbitrary agent. The host additionally
 * refuses a job this app does not own.
 */
export function asWarmupRunNowArg(data: unknown): WarmupRunNowPayload | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.jobId !== "string" || o.jobId.length === 0) {
		return null;
	}
	return { jobId: o.jobId };
}

/** Narrow a quest create payload. Only the shape (`title`+`completion_condition`
 *  strings) is checked — Core validates server-side — and the whole object is
 *  forwarded verbatim so unknown fields survive. */
export function asQuestInputArg(data: unknown): QuestInputPayload | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (
		typeof o.title !== "string" ||
		typeof o.completion_condition !== "string"
	) {
		return null;
	}
	return o as QuestInputPayload;
}

/** Narrow a quest update arg `{ id, input }`. The nested `input` is validated with
 *  {@link asQuestInputArg}. */
export function asQuestUpdateArg(
	data: unknown
): { id: string; input: QuestInputPayload } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) {
		return null;
	}
	const input = asQuestInputArg(o.input);
	if (!input) {
		return null;
	}
	return { id: o.id, input };
}

/** Narrow an arg to `{ id: string }` (workflows get/delete/versionsList/webhook/
 *  templateGet). */
export function asWorkflowIdArg(data: unknown): { id: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) {
		return null;
	}
	return { id: o.id };
}

/** Narrow an explicit Webhooks secret read to `{ id: string }`. */
export function asWebhookSecretIdArg(data: unknown): { id: string } | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.trim().length === 0) {
		return null;
	}
	return { id: o.id };
}

/** Narrow a Webhooks secret write to `{ id: string, secret?: string }`. */
export function asWebhookSecretSetArg(
	data: unknown
): { id: string; secret?: string } | null {
	const id = asWebhookSecretIdArg(data);
	if (!id) {
		return null;
	}
	const secret = optionalString(data as Record<string, unknown>, "secret");
	if (secret === null) {
		return null;
	}
	return secret === undefined ? id : { ...id, secret };
}

/** Narrow an arg to `{ id: string, versionId: string }` (workflows versionGet/
 *  versionRestore). */
export function asWorkflowVersionGetArg(
	data: unknown
): { id: string; versionId: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (
		typeof o.id !== "string" ||
		o.id.length === 0 ||
		typeof o.versionId !== "string" ||
		o.versionId.length === 0
	) {
		return null;
	}
	return { id: o.id, versionId: o.versionId };
}

/** Narrow an arg to `{ id: string, label?: string }` (workflows.versionCreate). */
export function asWorkflowVersionCreateArg(
	data: unknown
): { id: string; label?: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) {
		return null;
	}
	const label = optionalString(o, "label");
	if (label === null) {
		return null;
	}
	return label === undefined ? { id: o.id } : { id: o.id, label };
}

/** Narrow an arg to `{ templateId: string }` (workflows.templateInstall). */
export function asTemplateInstallArg(
	data: unknown
): { templateId: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.templateId !== "string" || o.templateId.length === 0) {
		return null;
	}
	return { templateId: o.templateId };
}

/** Narrow an arg to `{ id: string, input?: Record<string,string>, dryRun?: boolean }` (workflows.run).
 *  `input` is an optional string→string map (the initial run inputs); a present-but-
 *  malformed value rejects the whole arg. `dryRun` is an optional boolean that
 *  requests Core's transient read-only execution mode. */
export function asWorkflowRunArg(
	data: unknown
): { dryRun?: boolean; id: string; input?: Record<string, string> } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) {
		return null;
	}
	if (o.dryRun !== undefined && typeof o.dryRun !== "boolean") {
		return null;
	}
	const dryRun = o.dryRun as boolean | undefined;
	if (o.input === undefined) {
		return dryRun === undefined ? { id: o.id } : { id: o.id, dryRun };
	}
	if (
		typeof o.input !== "object" ||
		o.input === null ||
		Array.isArray(o.input)
	) {
		return null;
	}
	const input: Record<string, string> = {};
	for (const [k, v] of Object.entries(o.input)) {
		if (typeof v !== "string") {
			return null;
		}
		input[k] = v;
	}
	return dryRun === undefined
		? { id: o.id, input }
		: { id: o.id, input, dryRun };
}

/** Narrow an arg to `{ runId: string }` (workflows.runGet). */
export function asWorkflowRunIdArg(data: unknown): { runId: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.runId !== "string" || o.runId.length === 0) {
		return null;
	}
	return { runId: o.runId };
}

/** Narrow an arg to `{ runId: string, payload: string }` (workflows.resume). */
export function asWorkflowResumeArg(
	data: unknown
): { runId: string; payload: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (
		typeof o.runId !== "string" ||
		o.runId.length === 0 ||
		typeof o.payload !== "string"
	) {
		return null;
	}
	return { runId: o.runId, payload: o.payload };
}

/** Narrow an arg to the composio catalog request (workflows.composio): a `kind`
 *  from the closed set + an optional `toolkit` slug. */
export function asComposioArg(data: unknown): {
	kind: "status" | "toolkits" | "triggers" | "connections";
	toolkit?: string;
} | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (
		o.kind !== "status" &&
		o.kind !== "toolkits" &&
		o.kind !== "triggers" &&
		o.kind !== "connections"
	) {
		return null;
	}
	const toolkit = optionalString(o, "toolkit");
	if (toolkit === null) {
		return null;
	}
	return toolkit === undefined ? { kind: o.kind } : { kind: o.kind, toolkit };
}

/** Narrow an arg to `{ task: string }` (ghost.recordStart). */
export function asRecordStartArg(data: unknown): { task: string } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.task !== "string") {
		return null;
	}
	return { task: o.task };
}

/** Narrow an unknown postMessage payload to a valid {@link RpcRequest}. Rejects
 *  anything not shaped like our envelope so stray messages never reach dispatch. */
export function asRpcRequest(data: unknown): RpcRequest | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const candidate = data as Record<string, unknown>;
	if (
		candidate.kind !== "ryu-plugin-rpc" ||
		typeof candidate.id !== "number" ||
		typeof candidate.method !== "string" ||
		!Array.isArray(candidate.args)
	) {
		return null;
	}
	return {
		kind: "ryu-plugin-rpc",
		id: candidate.id,
		method: candidate.method,
		args: candidate.args,
	};
}

/** Narrow an unknown RPC argument to a {@link RouteClaim}. Returns null for
 *  anything not shaped like `{ path: string, title: string }`, so a malformed
 *  claim never reaches {@link validatePluginRoute}. */
export function asRouteClaim(data: unknown): RouteClaim | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const candidate = data as Record<string, unknown>;
	if (
		typeof candidate.path !== "string" ||
		typeof candidate.title !== "string"
	) {
		return null;
	}
	return { path: candidate.path, title: candidate.title };
}
