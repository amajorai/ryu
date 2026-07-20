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
// mount time. Reading it from the plugin's `plugin.json` grants is #443's job;
// here we prove the gate works given a grant set.

import hostApiContract from "../../../crates/core/kernel-contracts/schemas/host-api.json" with {
	type: "json",
};

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
	| "core.listAgents"
	| "ui.render"
	// Widget host capabilities (Ryu Apps). `tool.call`/`ui.sendMessage` are
	// Gateway-sourced (they map from approved grants below); `widget.state` and
	// `ui.displayMode` are LOCAL host caps always granted to a mounted widget and
	// never derived from a manifest grant (decisions doc D5, spec R8).
	| "tool.call"
	| "ui.sendMessage"
	| "widget.state"
	| "ui.displayMode"
	// App host-bridge capabilities (full-page Companion apps). Gateway-sourced from
	// the SAME grant strings the Core `PluginHookBridge` gates on (`hook:side-model`,
	// `hook:run-agent`, `storage:kv`). Each unlocks a family of `/api/plugins/:id/host`
	// methods; `storage.kv` gates all four storage methods (one grant, one cap).
	| "model.complete"
	| "agent.run"
	| "storage.kv"
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
	// Fine-tune runs (grant `finetune:runs`) — the `com.ryu.finetune` app drives
	// training runs against Core's orchestration + durable job store. One capability
	// gates the whole `finetune.*` family (unary calls + the live progress stream).
	| "finetune.runs"
	// Website monitors (grant `monitors:crud`) — the `com.ryu.monitors` app drives
	// Core's `/api/monitors/*` orchestration (list/create/update/delete/run +
	// snapshots/alerts). One capability gates the whole `monitors.*` family. Unlike
	// the bridge-backed families, the host services call the existing Core monitors
	// API directly (the media pattern) since `/api/monitors/*` is already gated on
	// the same `com.ryu.monitors` enabled bit — no new Core bridge verb is needed.
	| "monitors.crud"
	// Workflows (grants `workflows:crud` / `workflows:runstate` / `workflows:catalogs`)
	// — the `com.ryu.workflows` app drives Core's DAG workflow engine from its
	// sandboxed companion frame. Like monitors these are host-DIRECT families (the
	// host holds the node token and calls the existing `/workflows*` + `/api/workflows/
	// catalog*` API, already gated on the `com.ryu.workflows` enabled bit — no new Core
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
	// Inbound webhook registry (grant `webhooks:crud`) — the `com.ryu.webhooks` app
	// renders Core's `/api/webhooks` + `/api/webhook-ingress/status` reads from its
	// sandboxed companion frame. Host-direct (the monitors pattern): the host holds the
	// node token and calls the existing read-only registry endpoints. One capability
	// gates the whole (read-only) `webhooks.*` family.
	| "webhooks.crud"
	// Quests (grant `quests:crud`) — the `com.ryu.quests` app drives Core's
	// `/api/quests/*` auto-detecting-todo orchestration (list/create/update/delete +
	// complete/dismiss + suggestion accept/dismiss + judge) from its sandboxed companion
	// frame. Host-direct (the monitors pattern): the host holds the node token and calls
	// the existing `/api/quests/*` API. One capability gates the whole `quests.*` family,
	// including the `quests.openDetectionSettings` shell-navigation verb that opens the
	// Settings dialog at the Quests (detection) tab.
	| "quests.crud"
	// Activity feed (grant `activity:read`) — the `com.ryu.activity` app renders Core's
	// read-only unified feed (`GET /api/activity`) from its sandboxed companion frame.
	// Host-direct (the monitors pattern): the host holds the node token and calls the
	// existing `/api/activity` read. One capability gates the whole (read-only)
	// `activity.*` family, including the `activity.openSession` shell-navigation verb
	// that opens the chat tab for an item's session id.
	| "activity.read"
	// Timeline (grant `timeline:read`) — the `com.ryu.timeline` app renders the
	// CapCut-style activity replay scrubber (Shadow's captured lanes + keyframe
	// preview + Dayflow work journal) from its sandboxed companion frame. Host-direct
	// (the monitors pattern), but device-LOCAL: Shadow (:3030) is pinned to the
	// physical machine, so the host calls it WITHOUT a node token (the `shadow.ts`
	// INVARIANT — the same host-direct-to-Shadow shape as `suggestions.*` above). One
	// capability gates the whole (read-only) `timeline.*` family, including the
	// `timeline.frame` keyframe→data-URL verb (CSP `img-src data: blob:`) and the
	// `timeline.openReview`/`openSettings` shell-navigation verbs.
	| "timeline.read"
	// Agent Inboxes (grant `mail:crud`) — the `com.ryu.mail` app drives Core's
	// `/api/mail/*` orchestration (inbox CRUD, message list/send, inbound-secret
	// rotation) from its sandboxed companion frame. Host-direct (the monitors
	// pattern): the host holds the node token and calls the existing `/api/mail/*`
	// client (served by the out-of-process `ryu-mail` sidecar, already gated on the
	// `com.ryu.mail` enabled bit). One capability gates the whole `mail.*` family,
	// including the `mail.inboundUrl` verb the host resolves from the node URL (the
	// frame has none) — the `workflows.webhook` precedent.
	| "mail.crud"
	// Calendar (grant `calendar:crud`) — the `com.ryu.calendar` app renders the
	// scheduled-runs calendar (every agent/workflow scheduled job projected onto
	// Month/Week/Day/Agenda) from its sandboxed companion frame, and schedules an
	// agent via the New-automation dialog. Host-direct (the monitors pattern): the
	// host holds the node token and calls the existing `/heartbeat/jobs` (jobs),
	// `/workflows` (names), and `/api/agents` (picker) reads, plus the idempotent
	// `createScheduledAgentWorkflow` composite. One capability gates the whole
	// `calendar.*` family.
	| "calendar.crud"
	// Learning (grant `learning:crud`) — the `com.ryu.learning` app renders the
	// read-only continual-learning surface (the two opt-in levels + the models in
	// use, the experience buffer's captured/scored/trainable counts, and the
	// read-only self-healing attempt history) from its sandboxed companion frame.
	// Host-direct (the monitors pattern): the host holds the node token and calls the
	// existing `/api/learn/config` (config), `/api/experience/list` (buffer), and
	// `/api/healing/status` (heal history) reads. READ-ONLY — the actions (skill
	// approvals + the heal inbox) stay in the Inbox, the opt-ins in Privacy settings.
	// One capability gates the whole `learning.*` family.
	| "learning.crud"
	// Inbox / Approvals (grant `approvals:crud`) — the `com.ryu.approvals` app renders
	// the unified inbox from its sandboxed companion frame: pending HITL approvals
	// (approve/reject), the per-user notification feed (read + the workflow-resume ack
	// gate), and Shadow's proactive suggestions (list + feedback + open-in-chat). Host-
	// direct (the monitors pattern): the host holds the node token and calls the existing
	// `/api/approvals/*`, `/api/notifications/*` (host-resolved user id), and Shadow's
	// `/proactive` + `/api/feedback` — plus the `suggestions.openInChat` shell-navigation
	// verb. One capability gates that whole family; the inbox's quest task check-off reuses
	// the separate `quests.crud` capability (the app declares BOTH grants).
	| "approvals.crud"
	// Meetings (grant `meetings:crud`) — the `com.ryu.meetings` app renders the
	// record → live-transcript → AI-notes surface from its sandboxed companion frame.
	// Host-direct (the monitors pattern): the host holds the node token and calls the
	// existing `/api/meetings/*` orchestration (list/transcript + start/finalize/delete/
	// rename). One capability gates the whole `meetings.*` family, including the
	// host-owned `meetings.import` audio-upload verb (the frame carries no file picker +
	// cannot POST multipart under the CSP) and the `meetings.open`/`openNotes`/`openList`
	// shell-navigation verbs (mirroring the desktop page's `openTab`).
	| "meetings.crud"
	// Skill authoring (grant `skills:crud`) — the `com.ryu.skill-editor` app authors a
	// user-owned Agent Skill (`SKILL.md`): front-matter form fields + a markdown body +
	// server-backed version history. Host-direct (the monitors pattern): the host holds
	// the node token and calls the existing `/api/skills` authoring endpoints (reusing the
	// desktop `skills.ts` client, which normalizes Core's snake_case to camelCase). One
	// capability gates the whole `skills.*` family, including the `skills.setTitle`
	// shell-navigation verb that renames the owning tab (the desktop page's
	// `updateTabTitle`).
	| "skills.crud"
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

// --- Monitor payload shapes (grant `monitors:crud`). Minimal INLINE aliases so
// rpc.ts stays dependency-free; they mirror Core's `/api/monitors/*` serde JSON
// (snake_case) verbatim. The host forwards these through unchanged; the app owns
// the richer typed copies in `@ryu/monitors-app/types`. ---

/** A website monitor as Core returns it (opaque check/notify unions kept loose so
 *  rpc.ts carries no schema — Core validates server-side). */
export interface MonitorRecord {
	id: string;
	name: string;
	url: string;
	[key: string]: unknown;
}

/** The create/update payload for a monitor (forwarded verbatim to Core). */
export interface MonitorInputPayload {
	name: string;
	url: string;
	[key: string]: unknown;
}

/** A single check snapshot (loose — Core owns the shape). */
export type MonitorSnapshot = Record<string, unknown>;

/** A monitor alert (loose — Core owns the shape). */
export type MonitorAlert = Record<string, unknown>;

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

/** The New-automation payload: schedule an agent on a cron/interval schedule. The
 *  host runs the same idempotent `createScheduledAgentWorkflow` composite the
 *  desktop dialog ran. */
export interface CalendarCreateAutomationPayload {
	agentId: string;
	agentName: string;
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

/** The privileged service callbacks the trusted host injects. The plugin can only
 *  reach these indirectly, through {@link dispatchRpc}, and only for methods whose
 *  capability it was granted.
 *
 *  INVARIANT #5: no method here returns a token/secret or performs ungoverned
 *  network egress. `listAgents` returns only a `{id,name}` projection; a future
 *  capability MUST keep that rule (every reply is readable by the sandboxed
 *  frame by construction). */
export interface HostServices {
	// --- Activity feed (grant `activity:read`). The `com.ryu.activity` app renders
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
	/** Approve a pending request (`POST /api/approvals/:id/approve`). */
	approvalsApprove?(input: ApprovalDecidePayload): Promise<ApprovalRecord>;

	// --- Inbox / Approvals (grant `approvals:crud`). The `com.ryu.approvals` app
	// renders the unified inbox. Host-direct (the monitors pattern): the host holds the
	// node token and calls the existing `/api/approvals/*`, `/api/notifications/*`
	// (host-resolved user id — the sandboxed frame has no session), and Shadow's
	// `/proactive` + `/api/feedback`, plus the `suggestionsOpenInChat` shell-navigation
	// verb. All optional so a non-inbox host is unaffected. ---

	/** List the pending + decided approval queue (`GET /api/approvals`). */
	approvalsList?(): Promise<ApprovalRecord[]>;
	/** Reject a pending request (`POST /api/approvals/:id/reject`). */
	approvalsReject?(input: ApprovalDecidePayload): Promise<ApprovalRecord>;
	/** List agents (`GET /api/agents`) for the New-automation picker (id+name). */
	calendarAgents?(): Promise<CalendarAgentRecord[]>;
	/** Create (or update) the scheduled workflow that runs an agent on a schedule,
	 *  then drain any legacy agent-target job — the exact composite the desktop dialog
	 *  ran. Rejects with Core's validation message on a bad cron/interval. */
	calendarCreateAutomation?(
		input: CalendarCreateAutomationPayload
	): Promise<void>;

	// --- Calendar (grant `calendar:crud`). The `com.ryu.calendar` app renders the
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

	// --- Fine-tune runs (grant `finetune:runs`). The `com.ryu.finetune` app drives
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
	// `/api/recipes/*` API, already gated on the `com.ryu.workflows` enabled bit. All
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

	// --- Learning (grant `learning:crud`). The `com.ryu.learning` app renders the
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

	// --- Agent Inboxes (grant `mail:crud`). The `com.ryu.mail` app drives Core's
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

	// --- Meetings (grant `meetings:crud`). The `com.ryu.meetings` app renders the
	// record → live-transcript → AI-notes surface. Host-direct (the monitors pattern):
	// the host holds the node token and calls the existing `/api/meetings/*` client
	// (already gated on the `com.ryu.meetings` enabled bit). `meetingsImport` is
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
		model_pref_key?: string;
		effort?: string;
	}): Promise<string>;

	// --- Website monitors (grant `monitors:crud`). The `com.ryu.monitors` app drives
	// Core's `/api/monitors/*` orchestration. Unlike the bridge families, the host
	// calls the existing Core monitors API DIRECTLY (the media pattern: it holds the
	// node token; `/api/monitors/*` is already gated on the `com.ryu.monitors` bit).
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
	monitorsRun?(input: { id: string }): Promise<string>;
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
	/** List the signed-in user's inbox rows (`GET /api/notifications`; the host
	 *  resolves the user id). */
	notificationsList?(): Promise<NotificationRecord[]>;
	/** Mark a notification read (`POST /api/notifications/:id/read`). */
	notificationsMarkRead?(input: { id: string }): Promise<void>;
	/** Report the widget's intrinsic content height so the host can size the frame
	 *  (capped by `maxHeight`). Fire-and-forget. */
	notifyHeight?(px: number): void;
	/** Open a URL OUTSIDE the widget (the user's real browser / desktop shell), never
	 *  in the sandboxed frame. The host MUST vet the href (http/https only) before
	 *  opening. Governed `window.openai.openExternal` impl. */
	openExternal?(input: { href: string }): Promise<void>;

	// --- Quests (grant `quests:crud`). The `com.ryu.quests` app drives Core's
	// `/api/quests/*` auto-detecting-todo orchestration. Host-direct (the monitors
	// pattern): the host holds the node token and calls the existing `/api/quests/*`
	// API. All optional so a non-quests host is unaffected. ---

	/** Accept a detection suggestion (`POST /api/quests/:id/suggestion/accept`). */
	questsAcceptSuggestion?(input: { id: string }): Promise<QuestRecord>;
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
	/** List all quests (`GET /api/quests`). */
	questsList?(): Promise<QuestRecord[]>;
	/** Open the shell Settings dialog at the Quests (detection) tab. A pure shell-
	 *  navigation verb (no Core call); fire-and-forget from the frame's view. */
	questsOpenDetectionSettings?(): void;
	/** Update a quest (`PUT /api/quests/:id`). Returns the updated record. */
	questsUpdate?(input: {
		id: string;
		input: QuestInputPayload;
	}): Promise<QuestRecord>;
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
	// theme / palette / event-stream seams (no Core fetch). `shellOpenTab` is unary and
	// MUST validate `path` against the host's safe-route allowlist before navigating
	// (a granted plugin can still only open a first-party destination — the anti-phishing
	// gate). The three subscribe/register verbs are STREAMING (dispatched by
	// `ExtensionHost`'s streaming path, torn down on frame unmount): each attaches its
	// listener and releases it when `signal` aborts. All optional so a non-shell host is
	// unaffected. ---

	/** Open a shell tab at an ALLOWLISTED route, forwarding `openTab` options
	 *  (`title`/`conversationId`/`forceNew`/`initialPrompt`). Rejects (`denied`) any
	 *  path not on the host's safe-route allowlist or the caller's own `/plugin/<id>`. */
	shellOpenTab?(input: {
		path: string;
		title?: string;
		conversationId?: string;
		forceNew?: boolean;
		initialPrompt?: string;
	}): Promise<void>;
	/** Contribute Cmd+K palette commands. `input.commands` is `{ id, title, group?,
	 *  keywords? }[]`; each invocation emits the invoked command id (a JSON string) back
	 *  to the frame. The commands are removed from the palette when `signal` aborts. */
	shellRegisterCommand?(
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

	// --- Skill authoring (grant `skills:crud`). The `com.ryu.skill-editor` app authors a
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

	// --- Spaces documents (grant `spaces:docs`). An app owns documents of kind
	// `app:<plugin_id>` — persisted in the Space, search-embedded, backlinked. `source`
	// is a string (JSON.stringify structured content yourself, e.g. a scene). ---

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
	/** Delete a durable KV value (`host.storage_delete`). */
	storageDelete?(input: { namespace?: string; key: string }): Promise<void>;
	/** Read the app's own durable KV value (`host.storage_get`). `null` when unset. */
	storageGet?(input: {
		namespace?: string;
		key: string;
	}): Promise<string | null>;
	/** List the keys the app has set in a namespace, newest first (`host.storage_keys`). */
	storageKeys?(input: { namespace?: string }): Promise<string[]>;
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

	// --- Timeline (grant `timeline:read`). The `com.ryu.timeline` app renders the
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

	// --- Inbound webhook registry (grant `webhooks:crud`). The `com.ryu.webhooks` app
	// renders Core's read-only webhook endpoint registry from its sandboxed companion.
	// Host-direct (the monitors pattern): the host holds the node token and calls the
	// existing `/api/webhooks` + `/api/webhook-ingress/status` reads, already ungated on
	// the main router. Both return the camelCase-normalized shape the desktop client
	// produces (`fetchWebhooks`/`fetchWebhookIngressStatus`), forwarded verbatim (kept
	// `unknown` so rpc.ts carries no webhook schema — the app owns the typed copies).
	// All optional so a non-webhooks host is unaffected. ---

	/** The resolved ingress backend + public URL (`GET /api/webhook-ingress/status`). */
	webhooksIngressStatus?(): Promise<unknown>;
	/** The unified webhook endpoint registry (`GET /api/webhooks`). */
	webhooksList?(): Promise<unknown>;
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
	/** List all workflows (`GET /workflows`). */
	workflowsList?(): Promise<unknown>;
	/** Node-config picker: MCP servers + their tools (`GET /api/mcp/*`). */
	workflowsMcp?(): Promise<unknown>;
	/** Resume a run suspended at an Awakeable gate (`POST /workflows/runs/:runId/resume`). */
	workflowsResume?(input: { runId: string; payload: string }): Promise<unknown>;
	/** Run a workflow (`POST /workflows/:id/run`). Returns the run record. */
	workflowsRun?(input: {
		id: string;
		input?: Record<string, string>;
	}): Promise<unknown>;
	/** Poll a run's current state (`GET /workflows/runs/:runId`). */
	workflowsRunGet?(input: { runId: string }): Promise<unknown>;
	/** Upsert a workflow definition (`POST /workflows`). Core validates the DAG. */
	workflowsSave?(input: Record<string, unknown>): Promise<unknown>;
	/** Node-config picker: schedules/jobs (`GET /api/schedules/jobs`). */
	workflowsSchedules?(): Promise<unknown>;
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

/** Capabilities whose ungranted call throws a STRUCTURED {@link CodedRpcError}
 *  (`denied`) instead of the legacy plain-string {@link CapabilityError}. Only the
 *  greenfield app host-bridge methods opt in; the legacy paths keep string errors so
 *  their existing readers are unaffected. */
const CODED_ERROR_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
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
	"activity.read",
	"mail.crud",
	"calendar.crud",
	"learning.crud",
	"approvals.crud",
	"meetings.crud",
	"skills.crud",
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
 * {@link CodedRpcError} (or anything carrying a string `code`) becomes the
 * structured `{ code, message }` a widget expects (D6); everything else — notably
 * the legacy {@link CapabilityError} — stays a plain string so the existing plugin
 * bridge (which checks `typeof error === "string"`) is unaffected.
 */
export function toRpcError(err: unknown): string | RpcErrorPayload {
	if (err && typeof err === "object" && "code" in err) {
		const coded = err as { code?: unknown; message?: unknown };
		if (typeof coded.code === "string") {
			return {
				code: coded.code as WidgetRpcErrorCode,
				message:
					typeof coded.message === "string" ? coded.message : String(err),
			};
		}
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
	if (!granted.has(capability)) {
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
	const capability = METHOD_CAPABILITY[method];
	if (!capability) {
		throw new CapabilityError(`Unknown method: ${method}`);
	}
	if (!granted.has(capability)) {
		// The app host-bridge methods are greenfield (no legacy string-error reader),
		// so a denied call gets a structured `denied` code the app can surface as a
		// real permission message. The legacy paths keep the plain-string CapabilityError.
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
	switch (method) {
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
		// File methods: KNOWN so they reject with a clean structured error, never the
		// unknown-method deny (which reads like a bug). Wire minimally later.
		case "ui.uploadFile":
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
					"workflows.run requires a { id: string, input?: Record<string,string> }"
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
		case "quests.list":
			if (!services.questsList) {
				throw new CodedRpcError("server_error", "quests.list is not available");
			}
			return await services.questsList();
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
		case "calendar.createAutomation": {
			const input = asCalendarCreateAutomationArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"calendar.createAutomation requires a { agentId: string, agentName: string, schedule: { kind: 'cron', expr } | { kind: 'every', interval }, requireApproval?: boolean }"
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
			return await services.notificationsList();
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
		model_pref_key?: string;
		effort?: string;
	} = { prompt: o.prompt };
	for (const f of ["system", "model", "model_pref_key", "effort"] as const) {
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

/** Narrow a monitor create payload. Only the shape (`name`+`url` strings) is
 *  checked — Core validates the full check/notify unions server-side — and the
 *  whole object is forwarded verbatim so unknown fields survive. */
export function asMonitorInputArg(data: unknown): MonitorInputPayload | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.name !== "string" || typeof o.url !== "string") {
		return null;
	}
	return o as MonitorInputPayload;
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

/** Narrow an RPC argument to a `{ id: string }` for `skills.getSource`/`listVersions`.
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

/** Narrow a calendar New-automation payload `{ agentId, agentName, schedule,
 *  requireApproval? }`. The `schedule` must be a tagged `{ kind: "cron", expr }` or
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
	return {
		agentId: o.agentId,
		agentName: o.agentName,
		schedule,
		...(o.requireApproval === undefined
			? {}
			: { requireApproval: o.requireApproval as boolean }),
	};
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

/** Narrow an arg to `{ id: string, input?: Record<string,string> }` (workflows.run).
 *  `input` is an optional string→string map (the initial run inputs); a present-but-
 *  malformed value rejects the whole arg. */
export function asWorkflowRunArg(
	data: unknown
): { id: string; input?: Record<string, string> } | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const o = data as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) {
		return null;
	}
	if (o.input === undefined) {
		return { id: o.id };
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
	return { id: o.id, input };
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
