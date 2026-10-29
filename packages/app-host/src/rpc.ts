import {
	type WorkflowAgentsRecords,
	type WorkflowAppsRecords,
	type WorkflowComposioKind,
	type WorkflowComposioResponse,
	type WorkflowHookEventsRecords,
	type WorkflowMcpRecord,
	type WorkflowNotifyTargetsRecords,
	type WorkflowSchedulesRecords,
	type WorkflowSkillsRecords,
	workflowAgentsRecordsSchema,
	workflowAppsRecordsSchema,
	workflowComposioKindSchema,
	workflowComposioResponseSchema,
	workflowHookEventsRecordsSchema,
	workflowMcpRecordSchema,
	workflowNotifyTargetsRecordsSchema,
	workflowSchedulesRecordsSchema,
	workflowSkillsRecordsSchema,
} from "./workflow-picker-records.ts";

export {
	type WorkflowAgentsRecords,
	type WorkflowAppsRecords,
	type WorkflowComposioKind,
	type WorkflowComposioResponse,
	type WorkflowHookEventsRecords,
	type WorkflowMcpRecord,
	type WorkflowNotifyTargetsRecords,
	type WorkflowSchedulesRecords,
	type WorkflowSkillsRecords,
	workflowAgentsRecordsSchema,
	workflowAppsRecordsSchema,
	workflowComposioKindSchema,
	workflowComposioResponseSchema,
	workflowHookEventsRecordsSchema,
	workflowMcpRecordSchema,
	workflowNotifyTargetsRecordsSchema,
	workflowSchedulesRecordsSchema,
	workflowSkillsRecordsSchema,
} from "./workflow-picker-records.ts";

import {
	type ActivityTraceImportRecord,
	activityTraceImportRecordSchema,
} from "./activity-trace-import.ts";
import {
	type AppBundleInstallResult,
	appBundleInstallResultSchema,
} from "./app-bundle.ts";

export {
	type ActivityTraceImportRecord,
	activityTraceImportRecordSchema,
} from "./activity-trace-import.ts";

import {
	type ActivityAuditResponse,
	type ActivityEvalResponse,
	type ActivityPruneResponse,
	type ActivityRedteamResponse,
	type ActivityScoreResponse,
	type ActivityTraceResponse,
	activityAuditResponseSchema,
	activityEvalResponseSchema,
	activityPruneResponseSchema,
	activityRedteamResponseSchema,
	activityScoreResponseSchema,
	activityTraceResponseSchema,
} from "./activity-operation-records.ts";
import {
	type AppBackupMethod,
	appBackupResponseSchema,
} from "./backup-records.ts";
import {
	type QuestJudgeResult,
	questJudgeResultSchema,
} from "./quest-judge-records.ts";
import {
	type SpaceDocumentWriteResult,
	spaceDocumentWriteResultSchema,
} from "./space-document-write.ts";
import {
	type VoiceEngineInstallRecord,
	voiceEngineInstallRecordSchema,
} from "./voice-install-records.ts";
import {
	type WorkflowConnectBindingRecord,
	type WorkflowWebhookRecord,
	workflowConnectBindingRecordSchema,
	workflowConnectBindingRecordsSchema,
	workflowWebhookRecordSchema,
} from "./workflow-binding-records.ts";

export {
	type ActivityAuditResponse,
	type ActivityEvalCaseScore,
	type ActivityEvalResponse,
	type ActivityPruneResponse,
	type ActivityRedteamResponse,
	type ActivityScoreResponse,
	type ActivityTraceResponse,
	activityAuditResponseSchema,
	activityEvalCaseScoreSchema,
	activityEvalResponseSchema,
	activityPruneResponseSchema,
	activityRedteamResponseSchema,
	activityScoreResponseSchema,
	activityTraceResponseSchema,
} from "./activity-operation-records.ts";
export {
	type AppBackupMethod,
	appBackupMethodSchema,
	appBackupResponseSchema,
} from "./backup-records.ts";
export {
	type QuestJudgeResult,
	questJudgeResultSchema,
} from "./quest-judge-records.ts";
export {
	type SpaceDocumentWriteResult,
	spaceDocumentWriteResultSchema,
} from "./space-document-write.ts";
export {
	type VoiceEngineInstallRecord,
	voiceEngineInstallRecordSchema,
} from "./voice-install-records.ts";
export {
	type WorkflowConnectBindingRecord,
	type WorkflowWebhookRecord,
	workflowConnectBindingRecordSchema,
	workflowConnectBindingRecordsSchema,
	workflowWebhookRecordSchema,
} from "./workflow-binding-records.ts";

import type { ShellStreamInput } from "./shell-stream-input.ts";

export {
	type ShellStreamInput,
	shellStreamInputSchema,
} from "./shell-stream-input.ts";

import {
	type TimelineJournalRecord,
	timelineJournalRecordSchema,
} from "./timeline-records.ts";
import {
	type WorkflowDefinitionInput,
	type WorkflowRecord,
	type WorkflowRunRecord,
	type WorkflowTemplateDetailRecord,
	type WorkflowTemplateRecord,
	type WorkflowVersionRecord,
	workflowDefinitionInputSchema,
	workflowRecordSchema,
	workflowRecordsSchema,
	workflowRunRecordSchema,
	workflowTemplateDetailRecordSchema,
	workflowTemplateRecordsSchema,
	workflowVersionRecordsSchema,
} from "./workflow-records.ts";

export {
	timelineJournalAppRecordSchema,
	timelineJournalRecordSchema,
} from "./timeline-records.ts";
export {
	type WorkflowDefinitionInput,
	type WorkflowNodeRecord,
	type WorkflowRecord,
	type WorkflowRunRecord,
	type WorkflowTemplateDetailRecord,
	type WorkflowTemplateRecord,
	type WorkflowVersionRecord,
	workflowDefinitionInputSchema,
	workflowEdgeRecordSchema,
	workflowNodeRecordSchema,
	workflowRecordSchema,
	workflowRecordsSchema,
	workflowRunRecordSchema,
	workflowTemplateDetailRecordSchema,
	workflowTemplateRecordSchema,
	workflowTemplateRecordsSchema,
	workflowTriggerRecordSchema,
	workflowVersionRecordSchema,
	workflowVersionRecordsSchema,
} from "./workflow-records.ts";

import {
	type WebhookIngressStatusRecord,
	type WebhookRegistryRecord,
	type WebhookSecretReadRecord,
	type WebhookSecretWriteRecord,
	webhookIngressStatusRecordSchema,
	webhookRegistryRecordSchema,
	webhookSecretReadSchema,
	webhookSecretWriteSchema,
} from "./webhook-records.ts";

export {
	webhookEndpointRecordSchema,
	webhookIngressStatusRecordSchema,
	webhookRegistryRecordSchema,
	webhookSecretReadSchema,
	webhookSecretWriteSchema,
} from "./webhook-records.ts";

import {
	type SkillSourceRecord,
	type SkillVersionRecord,
	type SkillWriteRecord,
	skillSourceRecordSchema,
	skillVersionRecordsSchema,
	skillWriteRecordSchema,
} from "./skill-records.ts";

export {
	type SkillSourceRecord,
	type SkillVersionRecord,
	type SkillWriteRecord,
	skillSourceRecordSchema,
	skillVersionRecordSchema,
	skillVersionRecordsSchema,
	skillWriteRecordSchema,
} from "./skill-records.ts";

import {
	type LearningConfigRecord,
	type LearningExperienceRecord,
	type LearningHealingRecord,
	learningConfigSchema,
	learningExperienceListSchema,
	learningHealingStatusSchema,
} from "./learning-records.ts";

export {
	type LearningConfigRecord,
	type LearningExperience,
	type LearningExperienceRecord,
	type LearningHealAttempt,
	type LearningHealingRecord,
	learningConfigSchema,
	learningExperienceListSchema,
	learningExperienceSchema,
	learningHealAttemptSchema,
	learningHealingStatusSchema,
} from "./learning-records.ts";

import {
	jsonResponseValueSchema as databaseResponseJsonSchema,
	jsonResponseDocumentSchema,
	type RyuJsonValue,
} from "./json-values.ts";

export type { RyuJsonValue } from "./json-values.ts";

import {
	type MailCreatePayload,
	type MailRequestPayload,
	type MailSendPayload,
	mailCreateInputSchema,
	mailRequestInputSchema,
	mailSendInputSchema,
} from "./mail-inputs.ts";

export type {
	MailCreatePayload,
	MailRequestPayload,
	MailSendPayload,
} from "./mail-inputs.ts";
export {
	mailAttachmentInputSchema,
	mailCreateInputSchema,
	mailRequestInputSchema,
	mailSendInputSchema,
} from "./mail-inputs.ts";

import type { RecipeSummary, RecordingState } from "@ryuhq/core-client/recipes";
import type { SpaceMatch } from "@ryuhq/core-client/spaces";
import {
	type GhostRecordingStop,
	ghostRecipeSummariesSchema,
	ghostRecordingStateSchema,
	ghostRecordingStopSchema,
} from "./ghost-recording.ts";

export {
	ghostRecipeSummariesSchema,
	ghostRecordingStateSchema,
	ghostRecordingStopSchema,
} from "./ghost-recording.ts";

import { throwIfAppRequestAborted } from "@ryuhq/core-client/app-request";
import type { Transcript } from "@ryuhq/core-client/meetings";
import {
	parseSpeechHistoryInput,
	type SpeechHistory,
	type SpeechHistoryInput,
} from "@ryuhq/core-client/shadow";
import {
	SPEAK_EFFECT_TYPES,
	SPEAK_FORMATS,
	SPEAK_INSTRUCT_MAX_CHARS,
	SPEAK_MAX_EFFECTS,
	SPEAK_NORMALIZE_MODES,
	SPEAK_REFERENCE_TEXT_MAX_CHARS,
	SPEAK_SEED_MAX,
	SPEAK_TEXT_MAX_CHARS,
	type SpeakEffect,
	type SpeakFormat,
	type SpeakNormalize,
	type TranscriptionDetail,
} from "@ryuhq/core-client/voice";
import { z } from "zod";
import { isBoundedActivityJson } from "./activity-score-input.ts";
import { appHttpGrantTarget, isScopedAppId } from "./app-request-target.ts";
import {
	type MediaRecordingService,
	parseMediaRecordingInput,
} from "./media-recording.ts";
import {
	type RouteClaim,
	type RouteRegistrationRecord,
	routeClaimSchema,
	routeRegistrationRecordSchema,
} from "./rpc-routes.ts";

export {
	isShellSafeRoute,
	SHELL_SAFE_ROUTE_PREFIXES,
	validatePluginRoute,
} from "./rpc-routes.ts";

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

import type { I18nHostSnapshot, I18nHostTranslateInput } from "@ryu/i18n/core";
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
	RyuProviderUsageReading,
	RyuSubscriptions,
	RyuSubscriptionsListArgs,
	RyuSubscriptionUsageArgs,
} from "./app-bridge.ts";

import {
	CapabilityError,
	CodedRpcError,
	type RpcErrorPayload,
} from "./rpc-errors.ts";

export {
	CapabilityError,
	CodedRpcError,
	type RpcErrorPayload,
	toRpcError,
	type WidgetRpcErrorCode,
	widgetRpcErrorCodeSchema,
} from "./rpc-errors.ts";

/** A request envelope a plugin sends over the bridge. `id` correlates the reply. */
export interface RpcRequest {
	args: unknown[];
	id: number;
	kind: "ryu-plugin-rpc";
	method: string;
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
	deepLink?: { url: string };
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
	modelContext?: import("./model-context.ts").ModelContextState | null;
	openedFile?: {
		uri: string;
		name: string;
		editable: boolean;
		revision: string;
	};
	safeArea?: { bottom: number; left: number; right: number; top: number };
	theme?: "light" | "dark";
	/** Complete resolved Ryu appearance tokens for the widget document. */
	themeTokens?: Record<string, string>;
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
export const capabilitySchema = z.enum([
	"host.capabilities",
	"i18n",
	"node.shareOrigins",
	"native.haptics",
	"native.notifications",
	"native.liveActivities",
	"core.listAgents",
	// Cross-chat broadcast (grant `chat.sendFollowUp`) — the companion receives
	// only redacted, caller-visible conversation summaries and can post an
	// explicitly confirmed message into selected existing chats.
	"chat.broadcast",
	"ui.render",
	"app.http",
	"app.realtime",
	// Widget host capabilities (Ryu Apps). `tool.call`/`ui.sendMessage` are
	// Gateway-sourced (they map from approved grants below); `widget.state` and
	// `ui.displayMode` are LOCAL host caps always granted to a mounted widget and
	// never derived from a manifest grant (decisions doc D5, spec R8).
	"tool.call",
	"ui.sendMessage",
	"ui.toast",
	"widget.state",
	"file.access",
	"ui.displayMode",
	// Assistant bridge (grant `assistant:context`) — the app describes ITS page to
	// the one global "Ask Ryu" surface: what the user is looking at, optionally its
	// own instructions + starter prompts while that page is open, and opening the
	// panel. Write-only in one direction: an app can steer the assistant about
	// itself, and can never read the conversation back.
	"assistant.context",
	// App host-bridge capabilities (full-page Companion apps). Gateway-sourced from
	// the SAME grant strings the Core `PluginHookBridge` gates on (`hook:side-model`,
	// `hook:run-agent`, `storage:kv`). Each unlocks a family of `/api/plugins/:id/host`
	// methods; `storage.kv` gates all four storage methods (one grant, one cap).
	"model.complete",
	"agent.run",
	"storage.kv",
	"crypto.seal",
	"backups.app",
	// Spaces documents (grant `spaces:docs`) — an app owns Space documents of kind
	// `app:<plugin_id>`: persisted, search-embedded, backlinked, versioned,
	// Space-routed. This is the integration that lets a feature (e.g. whiteboard) be
	// ported to an app WITHOUT losing its Spaces membership.
	"spaces.docs",
	"spaces.database",
	// Media generation (grant `media:generate`) — image / video / speech synthesis.
	// Each runs a Core media data-path call (`/api/images/generate`,
	// `/api/video/generate`, `/api/voice/speak`) which routes through the Gateway.
	// The host performs the privileged fetch (holds the node token) and converts any
	// remote-URL result to a `data:` URL before returning, so the CSP-locked frame
	// (img/media-src data: blob: only) can render it. This is the integration that
	// lets a generation app (e.g. the canvas) reach media engines from the sandbox.
	"media.generate",
	// Optional local TTS runtime installation (grant `voice:models:manage`).
	"voice.models.manage",
	// Speech-to-text (grant `media:transcribe`) — the frame hands the host an audio
	// `data:` URL; the host posts it to `/api/voice/transcribe` and returns the text.
	// Split from `media.generate` so a transcribe-only app need not also unlock
	// generation (least privilege).
	"media.transcribe",
	"media.recording",
	// Fine-tune runs (grant `finetune:runs`) — the `@ryu/finetune` app's legacy
	// verbs, served by hosts from its own sidecar through the ext-proxy. One capability
	// gates the whole `finetune.*` family (unary calls + the live progress stream).
	"finetune.runs",
	// Website monitors (grant `monitors:crud`) — the `@ryu/monitors` app drives
	// Core's `/api/monitors/*` orchestration (list/create/update/delete/run +
	// snapshots/alerts). One capability gates the whole `monitors.*` family. Unlike
	// the bridge-backed families, the host services call the existing Core monitors
	// API directly (the media pattern) since `/api/monitors/*` is already gated on
	// the same `@ryu/monitors` enabled bit — no new Core bridge verb is needed.
	"monitors.crud",
	// Workflows (grants `workflows:crud` / `workflows:runstate` / `workflows:catalogs`)
	// — the `@ryu/workflows` app drives Core's DAG workflow engine from its
	// sandboxed companion frame. Like monitors these are host-DIRECT families (the
	// host holds the node token and calls the existing `/workflows*` + `/api/workflows/
	// catalog*` API, already gated on the `@ryu/workflows` enabled bit — no new Core
	// bridge verb). Split into three least-privilege caps: `crud` (definition CRUD +
	// versions + templates + webhook URL), `runstate` (run + poll + resume), and
	// `catalogs` (the read-only node-config pickers: agents/apps/mcp/skills/schedules/
	// composio — under CSP `connect-src 'none'` the canvas is useless without them).
	"workflows.crud",
	"workflows.runstate",
	"workflows.catalogs",
	// Ghost record→replay (grant `ghost:record`) — the RecordToWorkflow flow records a
	// native-desktop action sequence into a recipe (start/status/stop) and lists the
	// saved recipes (the recipe-node picker reads the same list). Host-direct over
	// Core's `/api/recipes/*`. Split from `workflows.*` so a workflow app that does not
	// use ghost capture need not hold it (least privilege).
	"ghost.record",
	// Inbound webhook registry and protected secret management (grant
	// `webhooks:crud`) — the `@ryu/webhooks` app renders Core's registry and
	// explicit secret routes from its sandboxed companion frame. The host holds the
	// node token; secret values cross this bridge only through explicit get/set calls,
	// never through the metadata registry response. One capability gates the whole
	// `webhooks.*` family.
	"webhooks.crud",
	// Quests (grant `quests:crud`) — the `@ryu/quests` app drives Core's
	// `/api/quests/*` auto-detecting-todo orchestration (list/create/update/delete +
	// complete/dismiss + suggestion accept/dismiss + judge) from its sandboxed companion
	// frame. Host-direct (the monitors pattern): the host holds the node token and calls
	// the existing `/api/quests/*` API. One capability gates the whole `quests.*` family,
	// including the `quests.openDetectionSettings` shell-navigation verb that opens the
	// Settings dialog at the Quests (detection) tab.
	"quests.crud",
	// Keeping a selection from another app (grant `quests:capture`). Split from
	// `quests.crud` because it is a wider reach than editing the board: an app
	// that only renders quests holds `quests:crud` and cannot capture.
	"quests.capture",
	// Activity feed (grant `activity:read`) — the `@ryu/activity` app renders Core's
	// read-only unified feed (`GET /api/activity`) from its sandboxed companion frame.
	// Host-direct (the monitors pattern): the host holds the node token and calls the
	// existing `/api/activity` read. One capability gates the whole (read-only)
	// `activity.*` family, including the `activity.openSession` shell-navigation verb
	// that opens the chat tab for an item's session id.
	"activity.read",
	// Agent observability actions (grant `activity:run`). Read-side trace capture is
	// still `activity:read`; running a provider-backed security sweep and importing a
	// trace into Quality tests are kept behind a separate reviewed grant.
	"activity.run",
	"background.control",
	"warmup.crud",
	// Subscription accounts (grant `subscriptions:read`) — a Core-bridge family
	// (`subscriptions.list` / `subscriptions.usage`) that reads each provider's
	// saved logins and their usage. Labels are often email addresses, so Core also
	// requires a verified node owner/admin caller; credentials never cross.
	"subscriptions.read",
	// Timeline (grant `timeline:read`) — the `@ryu/timeline` app renders the
	// CapCut-style activity replay scrubber (Shadow's captured lanes + keyframe
	// preview + Dayflow work journal) from its sandboxed companion frame. Host-direct
	// (the monitors pattern), but device-LOCAL: Shadow (:3030) is pinned to the
	// physical machine, so the host calls it WITHOUT a node token (the `shadow.ts`
	// INVARIANT — the same host-direct-to-Shadow shape as `suggestions.*` above). One
	// capability gates the whole (read-only) `timeline.*` family, including the
	// `timeline.frame` keyframe→data-URL verb (CSP `img-src data: blob:`) and the
	// `timeline.openReview`/`openSettings` shell-navigation verbs.
	"timeline.read",
	"timeline.speech",
	// Agent Inboxes (grant `mail:crud`) — the `@ryu/mail` app drives Core's
	// `/api/mail/*` orchestration (inbox CRUD, message list/send, inbound-secret
	// rotation) from its sandboxed companion frame. Host-direct (the monitors
	// pattern): the host holds the node token and calls the existing `/api/mail/*`
	// client (served by the out-of-process `ryu-mail` sidecar, already gated on the
	// `@ryu/mail` enabled bit). One capability gates the whole `mail.*` family,
	// including the `mail.inboundUrl` verb the host resolves from the node URL (the
	// frame has none) — the `workflows.webhook` precedent.
	"mail.crud",
	// Calendar (grant `calendar:crud`) — the `@ryu/calendar` app renders the
	// scheduled-runs calendar (every agent/workflow scheduled job projected onto
	// Month/Week/Day/Agenda) from its sandboxed companion frame, and schedules an
	// agent via the New-automation dialog. Host-direct (the monitors pattern): the
	// host holds the node token and calls the existing `/heartbeat/jobs` (jobs),
	// `/workflows` (names), and `/api/agents` (picker) reads, plus the idempotent
	// `createScheduledAgentWorkflow` routine composite. One capability gates the whole
	// `calendar.*` family.
	"calendar.crud",
	// Learning (grant `learning:crud`) — the `@ryu/learning` app renders the
	// read-only continual-learning surface (the two opt-in levels + the models in
	// use, the experience buffer's captured/scored/trainable counts, and the
	// read-only self-healing attempt history) from its sandboxed companion frame.
	// Host-direct (the monitors pattern): the host holds the node token and calls the
	// existing `/api/learn/config` (config), `/api/experience/list` (buffer), and
	// `/api/healing/status` (heal history) reads. READ-ONLY — the actions (skill
	// approvals + the heal inbox) stay in the Inbox, the opt-ins in Privacy settings.
	// One capability gates the whole `learning.*` family.
	"learning.crud",
	// Inbox / Approvals (grant `approvals:crud`) — the `@ryu/approvals` app renders
	// the unified inbox from its sandboxed companion frame: pending HITL approvals
	// (approve/reject), the per-user notification feed (read, sender icons, archive/restore,
	// and the workflow-resume ack gate), and Shadow's proactive suggestions (list + feedback + open-in-chat). Host-
	// direct (the monitors pattern): the host holds the node token and calls the existing
	// `/api/approvals/*`, `/api/notifications/*` (host-resolved user id), and Shadow's
	// `/proactive` + `/api/feedback` — plus the `suggestions.openInChat` shell-navigation
	// verb. One capability gates that whole family; the inbox's quest task check-off reuses
	// the separate `quests.crud` capability (the app declares BOTH grants).
	"approvals.crud",
	// Targeted Inbox notifications (grant `notifications:send-to-user`). Core
	// re-checks the recipient against the node's organization/team roster.
	"notifications.send",
	// Meetings (grant `meetings:crud`) — the `@ryu/meetings` app renders the
	// record → live-transcript → AI-notes surface from its sandboxed companion frame.
	// Host-direct (the monitors pattern): the host holds the node token and calls the
	// existing `/api/meetings/*` orchestration (list/transcript + start/finalize/delete/
	// rename). One capability gates the whole `meetings.*` family, including the
	// host-owned `meetings.import` audio-upload verb (the frame carries no file picker +
	// cannot POST multipart under the CSP) and the `meetings.open`/`openNotes`/`openList`
	// shell-navigation verbs (mirroring the desktop page's `openTab`).
	"meetings.crud",
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
	"social.crud",
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
	"subtitles.crud",
	// Skill authoring (grant `skills:crud`) — the `@ryu/skill-editor` app authors a
	// user-owned Agent Skill (`SKILL.md`): front-matter form fields + a markdown body +
	// server-backed version history. Host-direct (the monitors pattern): the host holds
	// the node token and calls the existing `/api/skills` authoring endpoints (reusing the
	// desktop `skills.ts` client, which normalizes Core's snake_case to camelCase). One
	// capability gates the whole `skills.*` family, including the `skills.setTitle`
	// shell-navigation verb that renames the owning tab (the desktop page's
	// `updateTabTitle`).
	"skills.crud",
	// App installation (grant `plugins:install`) — `apps.installBundle` lets a
	// builder app such as `@ryu/app-studio` install the companion-only app it made.
	// Host-direct: the desktop host validates the bundle with `app-bundle.ts`
	// (companion runnable only, `com.local.<caller>.*` id, reviewed grants) and posts
	// it to Core's generic install-bundle sink, which leaves the app disabled until
	// the user enables it and the Gateway approves its grants.
	"plugins.install",
	// Automated Reasoning (grant `reasoning:check`) — the `@ryu/reasoning` app authors
	// formal policies and runs the solver playground from its sandboxed companion
	// frame. Host-direct (the monitors pattern) with ONE generic forwarder (the Outpost
	// pattern): `reasoning.request` carries `{ method, path, body }` that the host
	// re-issues against Core's `/api/reasoning<path>` public mount. That mount already
	// answers any client holding the node token — which is what the host holds — so the
	// forwarder widens nothing; the gates are this capability and Core's ext-proxy route
	// allowlist, where an undeclared sub-path is a hard 404. No navigation verb: the
	// companion is the whole surface and never opens a shell tab.
	"reasoning.check",
	"safe-actions.manage",
	// Deep Read (grant `rlm:query`) — the `@ryu/rlm` app loads a corpus, browses its
	// outline, asks questions of it and reads run traces from its sandboxed companion
	// frame. Host-direct with ONE generic forwarder, the same shape as
	// `reasoning.request` directly above: `rlm.request` carries `{ method, path, body }`
	// the host re-issues against Core's `/api/rlm<path>` public mount, which already
	// answers any client holding the node token — so the forwarder widens nothing. The
	// gates are this capability and Core's ext-proxy route allowlist, where an
	// undeclared sub-path is a hard 404. No navigation verb: the companion is the whole
	// surface.
	"rlm.query",
	// Tuition (grant `tuition:crud`) and Wire (grant `news:crud`) — the `@ryu/tuition`
	// and `@ryu/news` companions. Host-direct with ONE generic forwarder each, the same
	// shape as `reasoning.request` directly above: `<app>.request` carries
	// `{ method, path, body }` the host re-issues against that app's public mount.
	// Forty-three sidecar routes between them would otherwise be forty-three verbs.
	// Neither widens anything — the mount already answers any client holding the node
	// token, which is what the host holds — and the gates stay the capability plus
	// Core's ext-proxy route allowlist, where an undeclared sub-path is a hard 404.
	"tuition.crud",
	"news.crud",
	// Visual plan review (grant `blueprint:review`) — the `@ryu/blueprint` app renders a
	// plan an agent published (markdown blocks, the dependency graph derived from the
	// steps, the annotation rail) and records the human's verdict. Host-direct with ONE
	// generic forwarder, the same shape as `reasoning.request` directly above:
	// `blueprint.request` carries `{ method, path, body }` the host re-issues against
	// Core's `/api/blueprint<path>` public mount, which already answers any client
	// holding the node token — so the forwarder widens nothing. The gates are this
	// capability and Core's ext-proxy route allowlist, where an undeclared sub-path is a
	// hard 404. No navigation verb: the review surface IS the companion.
	"blueprint.review",
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
	"shell.integrate",
]);
export type Capability = z.output<typeof capabilitySchema>;

/** A route a plugin claims for its own surface. Sent by the plugin over
 *  `ui.registerRoute`; the host validates it with {@link validatePluginRoute}
 *  before accepting. Kept minimal (path + title) — the anti-phishing enforcement
 *  point (#6). */
export {
	type RouteClaim,
	type RouteRegistrationRecord,
	routeRegistrationRecordSchema,
} from "./rpc-routes.ts";
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

/** Validate the host-owned projection while forwarding Core's original object.
 * Unselected metadata is owned by the app and must not be cloned or stripped. */
function preserveHostResponse<S extends z.ZodType>(schema: S) {
	return z.custom<z.output<S>>((value) => schema.safeParse(value).success);
}

/** Core's generic HTTP forwarders return JSON, or undefined for an empty body.
 * Endpoint-specific fields remain owned by the companion that serves the route. */
export const rpcJsonResponseSchema = preserveHostResponse(
	databaseResponseJsonSchema
).optional();
export type RpcJsonResponse = z.output<typeof rpcJsonResponseSchema>;

/** Core forwards these worker-owned objects verbatim, including future fields. */
export const finetuneJobSpecSchema = preserveHostResponse(
	jsonResponseDocumentSchema
);
export type FinetuneJobSpec = z.output<typeof finetuneJobSpecSchema>;

function asFinetuneJobSpecArg(
	data: Parameters<typeof finetuneJobSpecSchema.safeParse>[0]
): FinetuneJobSpec | null {
	const parsed = finetuneJobSpecSchema.safeParse(data);
	return parsed.success ? parsed.data : null;
}

// --- Quest payload shapes (grant `quests:crud`). Minimal INLINE aliases that mirror Core's `/api/quests/*` serde JSON (snake_case)
// verbatim. The host forwards these through unchanged; the app owns the richer typed
// copies in `@ryu/quests-app/types`. ---

/** Core quest identity; status and suggestion metadata are forwarded unchanged. */
export const questRecordSchema = preserveHostResponse(
	z.object({ id: z.string(), title: z.string() })
);
export type QuestRecord = z.output<typeof questRecordSchema>;

/** The create/update payload for a quest (forwarded verbatim to Core). */
export interface QuestInputPayload {
	completion_condition: string;
	title: string;
}

/** One activity-feed record as Core returns it (grant `activity:read`). Loose beyond
 *  the id — the app owns the richer typed copy in
 *  `@ryu/activity-app/types`. Forwarded verbatim (snake_case) by the host. */
export const activityRecordSchema = preserveHostResponse(
	z.object({ id: z.string() })
);
export type ActivityRecord = z.output<typeof activityRecordSchema>;

/** Bounded Gateway audit filters accepted by the Activity observability view. */
export interface ActivityAuditInput {
	agent_id?: string;
	errors_only?: boolean;
	event_type?: string;
	from?: string;
	limit?: number;
	model?: string;
	provider?: string;
	until?: string;
	widget_instance_id?: string;
}

/** Completed production output submitted to the shared online scorer. */
export type ActivityScoreInput = z.output<typeof activityScoreInputSchema>;

/** A redacted conversation summary for the Chat Broadcast companion. The host
 * never forwards message bodies through this list; the send service loads the
 * transcript privately and returns only an accepted/failed result. */
export const chatConversationSummarySchema = preserveHostResponse(
	z.object({
		agent_id: z.string().nullable(),
		archived: z.boolean().optional(),
		created_at: z.number(),
		id: z.string(),
		last_message: z.string().optional(),
		last_message_at: z.number().optional(),
		last_message_role: z.string().optional(),
		message_count: z.number(),
		run_status: z.string().nullable(),
		title: z.string().nullable(),
		updated_at: z.number(),
	})
);
export type ChatConversationSummary = z.output<
	typeof chatConversationSummarySchema
>;

/** Result returned after the host has detached an accepted chat stream. */
export const chatSendResultSchema = preserveHostResponse(
	z.object({
		conversation_id: z.string(),
		status: z.literal("accepted"),
	})
);
export type ChatSendResult = z.output<typeof chatSendResultSchema>;

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

/** Decode the Core process projection at native/IPC response boundaries. */
export const backgroundProcessSchema = z.looseObject({
	command: z.string(),
	cwd: z.string(),
	description: z.string().nullable().optional(),
	elapsed_ms: z.number(),
	exit_code: z.number().nullable().optional(),
	exit_signal: z.string().nullable().optional(),
	kind: z.string(),
	label: z.string().nullable().optional(),
	pid: z.number().nullable().optional(),
	process_id: z.string(),
	producer: z.string(),
	running: z.boolean(),
	shell_id: z.string().nullable().optional(),
	started_at: z.number(),
}) satisfies z.ZodType<BackgroundProcess>;

/** One Shadow timeline event as the device-local `/timeline` returns it (grant
 *  `timeline:read`). Opaque — rpc.ts carries no schema; the app owns the richer typed
 *  copy in `@ryu/timeline-app/types`. Forwarded verbatim (snake_case) by the host.
 *  `null` when Shadow (:3030) is unreachable (recording off). */
export const timelineEventRecordSchema = preserveHostResponse(
	z.object({
		app_name: z.string().nullable(),
		event_type: z.string(),
		track: z.number(),
		ts: z.number(),
		url: z.string().nullable(),
		window_title: z.string().nullable(),
	})
).refine(
	(value) => !("app_path" in value || "bundle_id" in value),
	"Device-local locators must be removed before forwarding timeline events"
);
export type TimelineEventRecord = z.output<typeof timelineEventRecordSchema>;

/** Shadow's derived work-journal snapshot as `/journal` returns it (grant
 *  `timeline:read`). Opaque — the app owns the typed copy. `null` when unreachable. */
export type { TimelineJournalRecord } from "./timeline-records.ts";

// --- Mail payload shapes (grant `mail:crud`). Minimal INLINE aliases that mirror Core's `/api/mail/*` serde JSON verbatim. The
// host forwards these through unchanged; the app owns the richer typed copies in
// `@ryu/mail-app/types`. ---

/** An inbox as Core returns it (opaque beyond the id — Core owns the shape). */
export const mailInboxSchema = preserveHostResponse(
	z.object({ id: z.string() })
);
export type MailInbox = z.output<typeof mailInboxSchema>;

/** A stored email message as Core returns it (opaque beyond the id). */
export const mailMessageSchema = preserveHostResponse(
	z.object({ id: z.string() })
);
export type MailMessage = z.output<typeof mailMessageSchema>;

// --- Calendar payload shapes (grant `calendar:crud`). Minimal INLINE aliases and
// the host forwards Core's shapes verbatim. The app
// owns the richer typed copies in `@ryu/calendar-app/types`. ---

/** A scheduled job as the host forwards it (the camelCase `fetchJobs` shape; opaque
 *  beyond the id — the app owns the full type). */
export const calendarJobRecordSchema = preserveHostResponse(
	z.object({ id: z.string() })
);
export type CalendarJobRecord = z.output<typeof calendarJobRecordSchema>;

/** A workflow as the host forwards it (the calendar reads only id+name; opaque
 *  beyond the id). */
export const calendarWorkflowRecordSchema = preserveHostResponse(
	z.object({ id: z.string() })
);
export type CalendarWorkflowRecord = z.output<
	typeof calendarWorkflowRecordSchema
>;

/** An agent summary as the host forwards it (the picker reads id+name; opaque
 *  beyond the id). */
export const calendarAgentRecordSchema = preserveHostResponse(
	z.object({ id: z.string() })
);
export type CalendarAgentRecord = z.output<typeof calendarAgentRecordSchema>;

// --- Warmup (grant `warmup:crud`). The `@ryu/warmup` app schedules a keep-alive
// ping to each subscription agent so its rolling usage window is already open. As
// with calendar, the host forwards Core's shapes
// verbatim; the app owns the richer typed copies in `@ryu/warmup-app/types`. ---

/** One agent the host detected, with its usage windows + advertised models. */
export const warmupAgentRecordSchema = preserveHostResponse(
	z.object({ id: z.string() })
);
export type WarmupAgentRecord = z.output<typeof warmupAgentRecordSchema>;

/** What `warmup.detect` reports: the agents plus the node's IANA zone. */
export const warmupDetectionSchema = preserveHostResponse(
	z.object({
		agents: z.array(warmupAgentRecordSchema),
		tz: z.string(),
	})
);
export type WarmupDetectionRecord = z.output<typeof warmupDetectionSchema>;

const questRecordsSchema = preserveHostResponse(z.array(questRecordSchema));
const activityRecordsSchema = preserveHostResponse(
	z.array(activityRecordSchema)
);
const mailInboxesSchema = preserveHostResponse(z.array(mailInboxSchema));
const mailMessagesSchema = preserveHostResponse(z.array(mailMessageSchema));
const calendarJobsSchema = preserveHostResponse(
	z.array(calendarJobRecordSchema)
);
const calendarWorkflowsSchema = preserveHostResponse(
	z.array(calendarWorkflowRecordSchema)
);
const calendarAgentsSchema = preserveHostResponse(
	z.array(calendarAgentRecordSchema)
);

/** One job to schedule. Deliberately narrower than Core's `CreateJobBody`: this
 *  capability schedules agent pings and single-account provider pings, so a
 *  workflow/monitor target is not
 *  expressible and the owning app is pinned host-side rather than claimed by the
 *  frame (see {@link asWarmupJobsArg}). */
export interface WarmupJobInput {
	name: string;
	schedule:
		| { kind: "cron"; expr: string; tz?: string }
		| { kind: "every"; interval: string };
	target:
		| {
				type: "agent";
				agentId: string;
				prompt: string;
				model?: string | null;
		  }
		| {
				type: "provider_account";
				providerId: string;
				accountId: string;
				prompt: string;
				model: string;
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

// --- Inbox / Approvals payload shapes (grant `approvals:crud`). Minimal INLINE
// aliases so rpc.ts stays dependency-free; the host forwards Core's / Shadow's
// snake_case shapes verbatim. The app owns the richer typed copies in
// `@ryu/approvals-app/types`. ---

/** An approval request as the host forwards it (`GET /api/approvals`, the
 *  `listApprovals`/decide shape; opaque here — the app owns the full type). */
export const approvalRecordSchema = preserveHostResponse(
	z.object({ id: z.string() })
);
export type ApprovalRecord = z.output<typeof approvalRecordSchema>;

/** A stored inbox notification row as the host forwards it (`GET /api/notifications`,
 *  the `listNotifications` shape; opaque here — the app owns the full type). */
export const notificationRecordSchema = preserveHostResponse(
	z.object({ id: z.string() })
);
export type NotificationRecord = z.output<typeof notificationRecordSchema>;

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
export const proactiveSuggestionRecordSchema = preserveHostResponse(
	z.object({ id: z.string() })
);
export type ProactiveSuggestionRecord = z.output<
	typeof proactiveSuggestionRecordSchema
>;

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

// --- Meetings payload shapes (grant `meetings:crud`). Minimal INLINE aliases and
// the host forwards Core's `/api/meetings/*` snake_case
// shapes verbatim. The app owns the richer typed copies in `@ryu/meetings-app/types`. ---

/** A meeting as the host forwards it (`GET /api/meetings`, the `listMeetings`/
 *  `startMeeting`/… shape; opaque here — the app owns the full type). */
export const meetingRecordSchema = preserveHostResponse(
	z.object({ id: z.string() })
);
export type MeetingRecord = z.output<typeof meetingRecordSchema>;

/** A meeting's transcript as the host forwards it (`GET /api/meetings/:id/transcript`,
 *  the `getTranscript` shape; opaque here — the app owns the full type). */
export const meetingTranscriptSchema = preserveHostResponse(
	z.object({
		segments: z.array(
			z.object({
				created_at: z.string(),
				id: z.number(),
				meeting_id: z.string(),
				speaker: z.string().nullable().optional(),
				t_offset_ms: z.number(),
				text: z.string(),
			})
		),
		text: z.string(),
	})
) satisfies z.ZodType<Transcript>;
export type MeetingTranscriptRecord = z.output<typeof meetingTranscriptSchema>;

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

/** Shared HTTP payload fields; each forwarder retains its actual method policy. */
function httpRequestPayloadSchema<Method extends string>(
	method: z.ZodType<Method>
) {
	return z.object({
		body: preserveHostResponse(databaseResponseJsonSchema).optional(),
		method: method.optional(),
		path: z.string(),
	});
}

/** One forwarded call onto the sidecar's `/api/social` public mount.
 *
 *  `path` is RELATIVE to that mount, leading slash included, query string and all
 *  (`"/posts?status=scheduled,due"`). The host prepends the mount and REFUSES an
 *  absolute URL, a path not starting with `/`, and any `..` segment — so the frame
 *  chooses the sub-path and nothing else. It can never name a host, and it can never
 *  climb out of the mount onto another Core API. */
export const socialRequestPayloadSchema = httpRequestPayloadSchema(
	z.enum(["DELETE", "GET", "PATCH", "POST"])
);
export type SocialRequestPayload = z.output<typeof socialRequestPayloadSchema>;

/** One forwarded call onto a manifest sidecar: the calling companion's OWN by
 * default, or another app's when `app` names it (Host API 1.18, additive). The host
 * owns the plugin ids and enforces `app:http` (own) or the reviewed per-target
 * `app:http:<app>` grant (other); the frame controls only a normalized relative
 * path, confined to the target's mount. */
export const appRequestPayloadSchema = httpRequestPayloadSchema(
	z.enum(["DELETE", "GET", "PATCH", "POST", "PUT"])
).extend({ app: z.string().optional() });
export type AppRequestPayload = z.output<typeof appRequestPayloadSchema>;

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
export const reasoningRequestPayloadSchema = httpRequestPayloadSchema(
	z.enum(["DELETE", "GET", "POST", "PUT"])
);
export type ReasoningRequestPayload = z.output<
	typeof reasoningRequestPayloadSchema
>;

/** One forwarded call onto Core's `/api/tools/plans` protected mount. */
export const safeActionsRequestPayloadSchema = httpRequestPayloadSchema(
	z.enum(["DELETE", "GET", "POST", "PUT"])
);
export type SafeActionsRequestPayload = z.output<
	typeof safeActionsRequestPayloadSchema
>;

/** One forwarded call onto the `ryu-rlm` sidecar's `/api/rlm` public mount. Same
 *  contract and the same method union as {@link ReasoningRequestPayload} — `path` is
 *  relative to the mount and validated by the same resolver. */
export const rlmRequestPayloadSchema = httpRequestPayloadSchema(
	z.enum(["DELETE", "GET", "POST", "PUT"])
);
export type RlmRequestPayload = z.output<typeof rlmRequestPayloadSchema>;

/** One forwarded call onto the `ryu-tuition` sidecar's `/api/tuition` public mount.
 *  Same contract as {@link SocialRequestPayload} — `path` is relative to the mount and
 *  validated by the same resolver. The method union carries PATCH as well as PUT: the
 *  subject, skill and item routes patch in place, while settings are replaced whole. */
export const tuitionRequestPayloadSchema = httpRequestPayloadSchema(
	z.enum(["DELETE", "GET", "PATCH", "POST", "PUT"])
);
export type TuitionRequestPayload = z.output<
	typeof tuitionRequestPayloadSchema
>;

/** One forwarded call onto the `ryu-news` sidecar's `/api/news` public mount. Same
 *  contract and the same method union as {@link TuitionRequestPayload}. */
export const newsRequestPayloadSchema = httpRequestPayloadSchema(
	z.enum(["DELETE", "GET", "PATCH", "POST", "PUT"])
);
export type NewsRequestPayload = z.output<typeof newsRequestPayloadSchema>;

/** One forwarded call onto the `ryu-subtitles` sidecar's `/api/subtitles` public
 *  mount. Same contract as {@link SocialRequestPayload} — `path` is relative to the
 *  mount and validated by the same resolver. The method union carries PUT (settings
 *  are replaced whole) but no PATCH: nothing in this app edits a field in place, and
 *  advertising a verb the sidecar answers with 405 helps nobody. */
export const subtitlesRequestPayloadSchema = httpRequestPayloadSchema(
	z.enum(["DELETE", "GET", "POST", "PUT"])
);
export type SubtitlesRequestPayload = z.output<
	typeof subtitlesRequestPayloadSchema
>;

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
export const blueprintRequestPayloadSchema = httpRequestPayloadSchema(
	z.enum(["DELETE", "GET", "POST"])
);
export type BlueprintRequestPayload = z.output<
	typeof blueprintRequestPayloadSchema
>;

// --- Skill authoring (grant `skills:crud`). The desktop skill client normalizes
// Core's snake_case records to the camelCase contracts in skill-records.ts. ---

/** The editable fields the editor sends on create/update (camelCase, matching the
 *  desktop `SkillDraft`). Forwarded verbatim to the host's `skills.ts` client. */
export interface SkillDraftPayload {
	allowedTools?: string[];
	alwaysOn?: boolean;
	body: string;
	description?: string | null;
	name: string;
}

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

export const uploadFileResultSchema = preserveHostResponse(
	z.object({
		data_url: z.string(),
		id: z.string(),
		mime_type: z.string(),
		name: z.string(),
		size: z.number(),
		space_id: z.string(),
		url: z.string(),
	})
) satisfies z.ZodType<UploadFileResult>;

/** Generation-bridge features an app can feature-detect before offering a UI.
 *  Each is `true` only when this host forwards that input to Core, so an app
 *  can hide a control instead of sending a request the host would drop. */
export interface HostBridgeFeatures {
	/** `media.audio` music and sound-effect generation is wired. */
	"media.audio": boolean;
	/** `media.video` forwards `input_images`, `input_video`, `input_audio`,
	 *  `duration_s` and `provider_input` to Core. */
	"media.video.inputs": boolean;
	/** `model.complete` forwards `images` to a vision-capable model. */
	"model.vision": boolean;
}
/** Bridge features a host declares it forwards (see {@link HostBridgeFeatures}).
 *  `media.audio` is implied by implementing `generateAudio`. */
export type DeclaredHostBridgeFeature = "media.video.inputs" | "model.vision";

/** Sanitized, read-only feature inventory exposed to sandboxed plugins. Values
 * are deliberately booleans or small public metadata; tokens, permission
 * objects, native module instances, and device identifiers never cross this
 * boundary. */
export interface HostCapabilityDescriptor {
	androidOngoingNotifications: boolean;
	/** Generation-bridge feature flags, filled in by the dispatcher from the
	 *  services this host implements. */
	bridge?: HostBridgeFeatures;
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

/** Acknowledgements produced by the native host implementations. */
export const nativeHapticsResultSchema = preserveHostResponse(
	z.object({ signaled: z.literal(true) })
) satisfies z.ZodType<NativeHapticsResult>;
export const nativeNotificationResultSchema = preserveHostResponse(
	z.object({ id: z.string(), scheduled: z.literal(true) })
) satisfies z.ZodType<NativeNotificationResult>;
export const nativeLiveActivityResultSchema = preserveHostResponse(
	z.object({ updated: z.literal(true) })
) satisfies z.ZodType<NativeLiveActivityResult>;

/** Limits applied before any native implementation sees plugin input. */
export const NATIVE_ACTION_LIMITS = {
	conversationIdChars: 200,
	detailChars: 500,
	notificationBodyChars: 2000,
	notificationTitleChars: 120,
	titleChars: 120,
} as const;

function nullableRpcParser<S extends z.ZodType>(schema: S) {
	return z.unknown().transform((value): z.output<S> | null => {
		const parsed = schema.safeParse(value);
		return parsed.success ? parsed.data : null;
	}).parse;
}

function optionalNativeParser<S extends z.ZodType>(schema: S) {
	return z.unknown().transform((value): z.output<S> | undefined => {
		const parsed = schema.safeParse(value);
		return parsed.success ? parsed.data : undefined;
	}).parse;
}

export const nativeHapticsInputSchema = z.object({
	style: z.enum(["light", "success", "warning", "error"]),
});
export const nativeNotificationInputSchema = z.object({
	body: z
		.string()
		.trim()
		.min(1)
		.max(NATIVE_ACTION_LIMITS.notificationBodyChars),
	title: z
		.string()
		.trim()
		.min(1)
		.max(NATIVE_ACTION_LIMITS.notificationTitleChars),
});
export const nativeLiveActivityInputSchema = z.object({
	conversationId: z
		.string()
		.trim()
		.min(1)
		.max(NATIVE_ACTION_LIMITS.conversationIdChars),
	detail: z.string().trim().min(1).max(NATIVE_ACTION_LIMITS.detailChars),
	status: z.enum(["running", "waiting", "review", "done", "error"]),
	title: z.string().trim().min(1).max(NATIVE_ACTION_LIMITS.titleChars),
});

export const asNativeHapticsInput = optionalNativeParser(
	nativeHapticsInputSchema
);
export const asNativeNotificationInput = optionalNativeParser(
	nativeNotificationInputSchema
);
export const asNativeLiveActivityUpdateInput = optionalNativeParser(
	nativeLiveActivityInputSchema
);

const openedFileUriSchema = z.object({ uri: z.string() });
const openedFileRevisionSchema = openedFileUriSchema.extend({
	expectedRevision: z.string(),
});
const openedFileRepresentationsSchema = openedFileRevisionSchema.extend({
	text: z.unknown().optional(),
	blob: z.unknown().optional(),
});
const openedFileTextWriteSchema = openedFileRepresentationsSchema
	.refine((value) => !("blob" in value))
	.pipe(openedFileRevisionSchema.extend({ text: z.string() }));
const openedFileBlobWriteSchema = openedFileRepresentationsSchema
	.refine((value) => !("text" in value))
	.pipe(openedFileRevisionSchema.extend({ blob: z.string() }));

const rpcToolNameSchema = z.string().min(1);
const rpcHeightSchema = z.number().nonnegative();
const rpcModalArgSchema = z
	.object({ template: z.unknown().optional() })
	.catch(() => ({}));
const rpcNotificationAppIconsSchema = z
	.object({
		appIds: z
			.array(z.string().min(1).optional().catch(undefined))
			.transform((ids) => ids.filter((id): id is string => id !== undefined))
			.catch(() => []),
	})
	.catch(() => ({ appIds: [] }));

const browserVibrationSchema = z.custom<Navigator["vibrate"]>(
	(value) => z.function().safeParse(value).success
);
const browserNotificationConstructorSchema = z.custom<typeof Notification>(
	(value) => z.function().safeParse(value).success
);
const browserUuidSchema = z.custom<Crypto["randomUUID"]>(
	(value) => z.function().safeParse(value).success
);

function browserPlatform(): HostCapabilityDescriptor["platform"] {
	return globalThis.navigator === undefined ? "unknown" : "browser";
}

/** Which generation-bridge inputs this host forwards. A feature counts only
 *  when its service exists AND the host declares it forwards the new fields,
 *  so an older host that implements `generateVideo` but drops reference inputs
 *  never advertises them. */
export function hostBridgeFeatures(
	services: Pick<
		HostServices,
		"bridgeFeatures" | "generateAudio" | "generateVideo" | "modelComplete"
	>
): HostBridgeFeatures {
	const declared = new Set(services.bridgeFeatures ?? []);
	return {
		"media.audio": services.generateAudio !== undefined,
		"media.video.inputs":
			services.generateVideo !== undefined &&
			declared.has("media.video.inputs"),
		"model.vision":
			services.modelComplete !== undefined && declared.has("model.vision"),
	};
}

/** Detect browser-only host features without requesting permission or returning
 * browser objects. Native hosts replace this with their platform detector. */
export function detectBrowserHostCapabilities(): HostCapabilityDescriptor {
	const browser = browserPlatform() === "browser";
	const notification = browser && globalThis.Notification !== undefined;
	const audio =
		browser &&
		(globalThis.AudioContext !== undefined || globalThis.Audio !== undefined);
	return {
		androidOngoingNotifications: false,
		browserNotifications: notification,
		dynamicIsland: false,
		hardwareBleRelay:
			browser && globalThis.navigator !== undefined && "bluetooth" in navigator,
		haptics:
			browser &&
			globalThis.navigator !== undefined &&
			browserVibrationSchema.safeParse(navigator.vibrate).success,
		localNotifications: notification,
		liveActivities: false,
		platform: browserPlatform(),
		pushRegistration:
			browser &&
			globalThis.PushManager !== undefined &&
			globalThis.ServiceWorkerContainer !== undefined,
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
	const vibration = browserVibrationSchema.safeParse(
		globalThis.navigator?.vibrate
	);
	if (!vibration.success) {
		throw new CodedRpcError(
			"server_error",
			"native.haptics is unavailable on this host"
		);
	}
	const vibrate = vibration.data;
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
	const notificationConstructor =
		browserNotificationConstructorSchema.safeParse(globalThis.Notification);
	if (
		!notificationConstructor.success ||
		notificationConstructor.data.permission !== "granted"
	) {
		throw new CodedRpcError(
			"server_error",
			"native.notifications.create requires notification permission granted by the host"
		);
	}
	const NotificationConstructor = notificationConstructor.data;
	const notification = new NotificationConstructor(input.title, {
		body: input.body,
	});
	const id = browserUuidSchema.safeParse(globalThis.crypto?.randomUUID).success
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

export interface SpaceDatabaseQueryResult {
	columns: string[];
	rows: RyuJsonValue[][];
	schema: { id: string; label: string; name: string }[];
	truncated: boolean;
}

export const spaceDatabaseQueryResultSchema = preserveHostResponse(
	z.object({
		columns: z.array(z.string()),
		rows: z.array(z.array(databaseResponseJsonSchema)),
		schema: z.array(
			z.object({ id: z.string(), label: z.string(), name: z.string() })
		),
		truncated: z.boolean(),
	})
) satisfies z.ZodType<SpaceDatabaseQueryResult>;

const timelineEventRecordsSchema = preserveHostResponse(
	z.array(timelineEventRecordSchema)
).nullable();
const chatConversationSummariesSchema = preserveHostResponse(
	z.array(chatConversationSummarySchema)
);
const approvalRecordsSchema = preserveHostResponse(
	z.array(approvalRecordSchema)
);
const notificationRecordsSchema = preserveHostResponse(
	z.array(notificationRecordSchema)
);
const proactiveSuggestionRecordsSchema = preserveHostResponse(
	z.array(proactiveSuggestionRecordSchema)
);
const meetingRecordsSchema = preserveHostResponse(z.array(meetingRecordSchema));
const uploadedFilesSchema = preserveHostResponse(
	z.union([uploadFileResultSchema, z.array(uploadFileResultSchema), z.null()])
);

/** The explicit secret-free projection exposed by core.listAgents. */
export const hostAgentSummarySchema = z.object({
	id: z.string(),
	name: z.string(),
});
export type HostAgentSummary = z.output<typeof hostAgentSummarySchema>;

export interface HostServices {
	/** Read Gateway audit rows for the node's observability explorer. */
	activityAudit?(input: ActivityAuditInput): Promise<ActivityAuditResponse>;
	/** Run the shared Promptfoo-compatible quality evaluator for one agent. */
	activityEval?(input: {
		agent_id: string;
		model?: string;
	}): Promise<ActivityEvalResponse>;
	/** Import a run's last user/assistant pair into the agent's first Quality suite. */
	activityImportTrace?(input: {
		agent_id?: string;
		run_id: string;
		suite_id?: string;
	}): Promise<ActivityTraceImportRecord>;

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
	/** Apply the local Gateway audit retention policy. */
	activityPrune?(): Promise<ActivityPruneResponse>;
	/** Run the server-owned bounded security probe campaign for one agent. */
	activityRedteam?(input: {
		agent_id: string;
		model?: string;
	}): Promise<ActivityRedteamResponse>;
	/** Score a completed output without replaying its provider request. */
	activityScore?(input: ActivityScoreInput): Promise<ActivityScoreResponse>;
	/** Read Core spans for one conversation/run. */
	activityTrace?(input: { run_id: string }): Promise<ActivityTraceResponse>;
	/** Forward a call to `/api/ext/<owning-plugin-id><path>`. */
	appRequest?(
		input: AppRequestPayload,
		signal?: AbortSignal
	): Promise<RpcJsonResponse>;
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
	/** Install or update a companion-only app the calling app built (grant
	 *  `plugins:install`). The host validates the frame-supplied bundle against the
	 *  caller's own id with `checkAppBundle` before posting it to Core. */
	appsInstallBundle?(bundle: unknown): Promise<AppBundleInstallResult>;
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
		/** What the conversation is about (e.g. one pull request). A new value
		 *  starts a separate thread; returning to an earlier one resumes it. */
		thread?: string;
		tools?: string[];
	}): Promise<void>;
	/** List Core-visible background processes, running by default. */
	backgroundList?(input: {
		producer?: string;
		running_only?: boolean;
	}): Promise<BackgroundProcess[]>;
	/** Request a process owner to stop one of its live processes. */
	backgroundStop?(input: {
		process_id: string;
	}): Promise<{ ok: boolean; requested: boolean; process_id: string }>;
	/** App-scoped backups; Core derives identity and keeps credentials sealed. */
	backupsRequest?(
		method: AppBackupMethod,
		input: RyuJsonValue
	): Promise<RyuJsonValue>;

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
	blueprintRequest?(input: BlueprintRequestPayload): Promise<RpcJsonResponse>;
	/** Generation-bridge inputs this host forwards to Core, reported to apps
	 *  through `host.capabilities().bridge` (see {@link hostBridgeFeatures}). */
	bridgeFeatures?: readonly DeclaredHostBridgeFeature[];
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
	callTool?(name: string, args: RpcJsonResponse): Promise<RpcJsonResponse>;
	/** Discover models for one provider; Core resolves credentials server-side. */
	catalogModels?(input: { providerId: string }): Promise<RyuCatalogModels>;
	/** Read the shared, secret-free provider/model/agent/app/hook catalog. */
	catalogSnapshot?(): Promise<RyuCatalogSnapshot>;
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
	/** Open a value this app sealed (`host.crypto_open`). Rejects another app's
	 *  ciphertext (different key, AEAD tag failure) and passes through values that
	 *  were never sealed, so a store can be migrated in place. */
	cryptoOpen?(input: { value: string }): Promise<string>;
	/** Seal a string under this app's own key (`host.crypto_seal`, grant
	 *  `crypto:seal`). Returns an opaque envelope to hand to `storageSet` or any
	 *  other sink. The key is derived by Core per app and never reaches the frame,
	 *  so this is the ONLY way an app gets encryption — there is no key accessor. */
	cryptoSeal?(input: { value: string }): Promise<string>;
	/** Which key custody is live (`host.crypto_status`) — keychain vs a key file
	 *  next to the data. Carries no key material; let an app tell the user what
	 *  its sealed data is actually worth before storing anything sensitive. */
	cryptoStatus?(): Promise<CryptoStatus>;
	/** The installed trained adapters with provenance (sidecar `GET /adapters`). */
	finetuneAdapters?(): Promise<RpcJsonResponse>;
	/** Cooperatively cancel a running job (sidecar `DELETE /:id`). */
	finetuneCancel?(input: { id: string }): Promise<RpcJsonResponse>;

	// --- Fine-tune runs (grant `finetune:runs`). Legacy host-API verbs kept for
	// compatibility (host API 1.x is additive-only). Core no longer bridges them:
	// hosts serve each from the companion's OWN `ryu-finetune` sidecar through the
	// generic ext-proxy (`finetune-compat.ts`), and current companions call
	// `app.request` directly. Live progress streams over `finetuneStream`. All
	// optional so a host that does not implement them is unaffected. ---

	/** Probe what this node can train (sidecar `GET /capability`): GPU, VRAM,
	 *  local-train gate + reason, and the sidecar's health. Takes no input. */
	finetuneCapability?(): Promise<RpcJsonResponse>;
	/** One job's live snapshot — step/loss/state (sidecar `GET /:id`). */
	finetuneGet?(input: { id: string }): Promise<RpcJsonResponse>;
	/** The durable job list, live-synced from the sidecar (`GET /list`). */
	finetuneList?(): Promise<RpcJsonResponse>;
	/** Merge a trained adapter into a servable GGUF + register it as an installed
	 *  model (sidecar `POST /merge`). `input` forwarded verbatim. */
	finetuneMerge?(input: FinetuneJobSpec): Promise<RpcJsonResponse>;
	/** Start a fine-tune job (sidecar `POST /start`). `input` is the job spec
	 *  forwarded verbatim (base model, dataset, hyperparams, target). */
	finetuneStart?(input: FinetuneJobSpec): Promise<RpcJsonResponse>;
	/** Subscribe to a run's live SSE progress (`finetune.stream`; the sidecar's
	 *  `GET /:id/stream` read through the ext-proxy). Each raw SSE
	 *  frame is delivered to `emit`; resolves when the stream ends; `signal` aborts. */
	finetuneStream?(
		input: { id: string },
		emit: (delta: string) => void,
		signal: AbortSignal
	): Promise<void>;
	/** Generate music or a sound effect (`/api/audio/generate`, polling the
	 *  cloud job internally). There is no local audio engine, so `provider` and
	 *  `model` are required. Returns `{ url, mediaType }[]` with `data:` URLs. */
	generateAudio?(
		input: MediaAudioInput
	): Promise<{ url: string; mediaType: string }[]>;

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
		/** Model-specific fields Core merges into a cloud provider body. */
		provider_input?: Record<string, RyuJsonValue>;
		request_id?: string;
	}): Promise<string[]>;
	/** Generate video clip(s) (`/api/video/generate`, polling cloud jobs
	 *  internally) from a prompt plus optional reference inputs: `[first, last?]`
	 *  frames, a source clip, an audio track and model-specific `provider_input`.
	 *  Core maps each input for the selected target or refuses the request.
	 *  Returns `{ url, mediaType }[]` with `url` a `data:` URL. */
	generateVideo?(input: {
		prompt: string;
		provider?: string;
		model?: string;
		request_id?: string;
		input_images?: string[];
		input_video?: string;
		input_audio?: string;
		duration_s?: number;
		provider_input?: Record<string, RyuJsonValue>;
	}): Promise<{ url: string; mediaType: string }[]>;
	/** Return the host's current global snapshot for this widget so the frame can
	 *  refresh after the bridge connects (spec §1.3 `widget.getGlobals`). */
	getGlobals?(): Promise<WidgetGlobalsPatch | null>;
	getModelContext?(): import("./model-context.ts").ModelContextState | null;

	// --- Workflows (grants `workflows:crud`/`runstate`/`catalogs`) + ghost record
	// (`ghost:record`). Host-direct families (the monitors pattern): the host holds the
	// node token and calls the existing `/workflows*` + `/api/workflows/catalog*` +
	// `/api/recipes/*` API, already gated on the `@ryu/workflows` enabled bit. All
	// return the existing desktop client JSON; recording replies follow the shared
	// Core client owner contracts. All
	// optional so a non-workflows host is unaffected. ---

	/** Ghost recipe list (`GET /api/recipes`) — the recipe-node picker + record flow. */
	ghostRecipes?(): Promise<RecipeSummary[]>;
	/** Begin a native-desktop recording (`POST /api/recipes/record/start`). */
	ghostRecordStart?(input: { task: string }): Promise<RecordingState>;
	/** Poll the live recording status (`GET /api/recipes/record/status`). */
	ghostRecordStatus?(): Promise<RecordingState>;
	/** Stop recording; returns the captured AX action sequence + recipe draft
	 *  (`POST /api/recipes/record/stop`). */
	ghostRecordStop?(): Promise<GhostRecordingStop>;
	/** Return a sanitized host feature inventory. This is a local capability and
	 * does not require a plugin grant. */
	hostCapabilities?():
		| Promise<HostCapabilityDescriptor>
		| HostCapabilityDescriptor;
	/** Return the current locale/pack metadata. This is a local, read-only
	 * primitive and never returns the pack's message catalog or user data. */
	i18nSnapshot?(): Promise<I18nHostSnapshot> | I18nHostSnapshot;
	/** Stream the current locale/pack snapshot and later changes as JSON. */
	i18nSubscribe?(
		input: ShellStreamInput,
		emit: (delta: string) => void,
		signal: AbortSignal
	): Promise<void>;
	/** Translate an app/plugin-owned message with the active shell pack. */
	i18nTranslate?(input: I18nHostTranslateInput): Promise<string> | string;
	/** Install one registered TTS engine's managed runtime dependencies. */
	installTtsEngine?(input: {
		engine: string;
	}): Promise<VoiceEngineInstallRecord>;

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
	listAgents(): Promise<HostAgentSummary[]>;
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
	/** Call one of the app's authenticated `/api/mail/*` JSON routes. */
	mailRequest?(input: MailRequestPayload): Promise<RpcJsonResponse>;
	/** Rotate the inbound HMAC secret (`POST /api/mail/inboxes/:id/rotate-secret`).
	 *  Returns the new secret string. */
	mailRotateSecret?(input: { id: string }): Promise<string>;
	/** Send a message (`POST /api/mail/inboxes/:id/send`). Returns the stored record. */
	mailSend?(input: MailSendPayload): Promise<MailMessage>;
	mediaRecording?: MediaRecordingService;
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
		/** Inline `data:image/{png,jpeg,webp}` URIs for a vision model. */
		images?: string[];
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

	/** Forward one call to `/api/news<path>`. Same contract as {@link tuitionRequest}. */
	newsRequest?(input: NewsRequestPayload): Promise<RpcJsonResponse>;
	/** Return secret-free active-node and mesh origins for share links. */
	nodeShareOrigins?(): Promise<RyuNodeShareOrigin[]>;
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
	readOpenedFile?(input: {
		uri: string;
	}): Promise<import("./opened-file.ts").OpenedFileSnapshot>;
	/** Close a host-owned application-room connection. */
	realtimeClose?(input: RealtimeConnectionPayload): Promise<void>;
	/** Open a host-owned application-room realtime connection. */
	realtimeConnect?(
		input: RealtimeConnectPayload
	): Promise<RealtimeConnectionInfo>;
	/** Publish presence through a host-owned application-room connection. */
	realtimePresence?(input: RealtimePresencePayload): Promise<void>;
	/** Publish a named event through a host-owned application-room connection. */
	realtimePublish?(input: RealtimePublishPayload): Promise<void>;
	/** Subscribe to events from a host-owned application-room connection. */
	realtimeSubscribe?(
		input: RealtimeConnectionPayload,
		emit: (delta: string) => void,
		signal: AbortSignal
	): Promise<void>;

	// --- Automated Reasoning (grant `reasoning:check`). The `@ryu/reasoning` app
	// authors formal policies and runs the solver playground. Host-direct through ONE
	// forwarder, the Outpost shape: the sidecar's seven routes need no per-route
	// service, and a route added to the manifest later needs no host change at all.
	// Optional, so a host without the app is unaffected. ---

	/** Forward one call to `/api/reasoning<path>`. Resolves with the parsed JSON body
	 *  and REJECTS on any non-2xx, so the frame uses try/catch rather than a status
	 *  check. The host validates `path` (see {@link ReasoningRequestPayload}) before
	 *  building the URL; it never accepts a host or an absolute URL from the frame. */
	reasoningRequest?(input: ReasoningRequestPayload): Promise<RpcJsonResponse>;
	/** Accept (or reject) the plugin's claim to render its own route. The concrete
	 *  implementation is pluginId-scoped (see {@link validatePluginRoute}); it must
	 *  reject any path that is not this plugin's own `/plugin/<id>` surface. */
	registerRoute(claim: RouteClaim): Promise<RouteRegistrationRecord>;
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

	// --- Deep Read (grant `rlm:query`). The `@ryu/rlm` app loads a corpus, browses
	// its outline and asks questions of it. Host-direct through ONE forwarder, the
	// same shape as Reasoning above: the sidecar's ten routes need no per-route
	// service, and a route added to the manifest later needs no host change at all.
	// Optional, so a host without the app is unaffected. ---

	/** Forward one call to `/api/rlm<path>`. Resolves with the parsed JSON body and
	 *  REJECTS on any non-2xx, so the frame uses try/catch rather than a status check.
	 *  The host validates `path` (see {@link RlmRequestPayload}) before building the
	 *  URL; it never accepts a host or an absolute URL from the frame. */
	rlmRequest?(input: RlmRequestPayload): Promise<RpcJsonResponse>;
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
	/** Forward one capability-gated call to Core's fixed Safe Actions mount. */
	safeActionsRequest?(
		input: SafeActionsRequestPayload
	): Promise<RpcJsonResponse>;
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
	/** Search node-proxied Openverse or Unsplash images. The host inlines both
	 * preview and full image URLs so CSP-locked frames receive only data URLs. */
	searchImages?(input: {
		provider: "openverse" | "unsplash";
		query: string;
	}): Promise<{
		configured: boolean;
		provider: "openverse" | "unsplash";
		error?: string;
		results: {
			id: string;
			title: string;
			preview: string;
			url: string;
			width: number;
			height: number;
			attribution: string;
			sourceUrl: string;
			licenseUrl?: string | null;
			rights: string;
		}[];
	}>;
	/** Governed follow-up: `POST /api/widgets/follow-up`. Injects a
	 *  widget-attributed user turn on the owning conversation (R4/D5). */
	sendFollowUpMessage?(input: { prompt: string }): Promise<void>;
	/** Persist widget state (client Zustand + best-effort `POST /api/widgets/state`,
	 *  D4). Keyed by `toolCallId` inside the host. */
	setWidgetState?(state: RpcJsonResponse): Promise<void>;
	/** Subscribe to the node event stream, filtered to `input.channels` (a subset of the
	 *  host's known channels). Each event emits a JSON `{ channel, data }`; resolves when
	 *  `signal` aborts. */
	shellEventsSubscribe?(
		input: ShellStreamInput,
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
		input: ShellStreamInput,
		emit: (delta: string) => void,
		signal: AbortSignal
	): Promise<void>;
	/** Contribute Cmd+K palette commands. `input.commands` is `{ id, title, group?,
	 *  keywords? }[]`; each invocation emits the invoked command id (a JSON string) back
	 *  to the frame. The commands are removed from the palette when `signal` aborts. */
	shellRegisterCommand?(
		input: ShellStreamInput,
		emit: (delta: string) => void,
		signal: AbortSignal
	): Promise<void>;
	/** Register default title-bar tab icons for path prefixes. `input.icons` is
	 *  `{ pathPrefix, pathIncludes?, icon }[]` — `icon` is an Iconify/Hugeicons id
	 *  (same vocabulary as companion / sidebar contribution icons). Rules are removed
	 *  when `signal` aborts (frame unmount). */
	shellRegisterTabIcon?(
		input: ShellStreamInput,
		emit: (delta: string) => void,
		signal: AbortSignal
	): Promise<void>;
	/** Subscribe to the host's LIVE resolved theme tokens. Emits the current token map
	 *  now and again on every theme change (each `emit` is a JSON `Record<string,string>`);
	 *  resolves when `signal` aborts (frame unmount / dispose). */
	shellThemeSubscribe?(
		input: ShellStreamInput,
		emit: (delta: string) => void,
		signal: AbortSignal
	): Promise<void>;
	/** Create a user-authored skill (`POST /api/skills`). Rejects (409) on a name
	 *  collision. Returns `{ id, source }`. */
	skillsCreate?(input: SkillDraftPayload): Promise<SkillWriteRecord>;
	/** Open the shared agent-target distribution flow for an installed skill. */
	skillsDistribute?(input: { id: string }): Promise<void>;

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
	socialRequest?(input: SocialRequestPayload): Promise<RpcJsonResponse>;
	/** Create a native Space database document (grant `spaces:database`). */
	spacesCreateDatabase?(input: {
		space_id: string;
		title: string;
	}): Promise<string>;

	/** Create an empty app-owned document in `space_id`; returns its doc id. */
	spacesCreateDoc?(input: { space_id: string; title: string }): Promise<string>;
	/** Delete a native database document, preserving the containing Space. */
	spacesDeleteDatabase?(input: {
		database_id: string;
		space_id: string;
	}): Promise<void>;
	/** Delete an app-owned document (and its links/versions). */
	spacesDeleteDoc?(input: { doc_id: string }): Promise<void>;

	// --- Spaces documents (grant `spaces:docs`). An app owns documents of kind
	// `app:<plugin_id>` — persisted in the Space, search-embedded, backlinked. `source`
	// is a string (JSON.stringify structured content yourself, e.g. a scene). ---

	/** Resolve or create a user-owned Space by name. */
	spacesEnsureSpace?(input: {
		name: string;
		description?: string | null;
	}): Promise<string>;
	/** Read a native Space database document. */
	spacesGetDatabase?(input: {
		space_id: string;
		database_id: string;
	}): Promise<{
		id: string;
		kind: "database";
		revision: number;
		space_id: string;
		source: string;
		title: string;
	} | null>;
	/** Read an app-owned document (null if missing / not this app's). */
	spacesGetDoc?(input: { doc_id: string }): Promise<{
		id: string;
		title: string;
		source: string;
		kind: string;
	} | null>;
	/** List native databases in one Space (newest first). */
	spacesListDatabases?(input: {
		space_id: string;
	}): Promise<{ id: string; title: string; updated_at: number }[]>;
	/** List this app's documents in a space (newest first). */
	spacesListDocs?(input: {
		space_id: string;
	}): Promise<{ id: string; title: string; updated_at: number }[]>;
	/** Run one bounded read-only SQL query against a native Space database. */
	spacesQueryDatabase?(input: {
		database_id: string;
		parameters?: RyuJsonValue[];
		query: string;
		space_id: string;
	}): Promise<SpaceDatabaseQueryResult>;
	/** Search a Space through Core's semantic retrieval endpoint. */
	spacesSearch?(input: {
		space_id: string;
		query: string;
		limit?: number;
	}): Promise<
		{
			chunk_id: string;
			content: string;
			distance: SpaceMatch["distance"];
			document_id: string;
		}[]
	>;
	/** Revision-aware save for a native database document. */
	spacesUpdateDatabase?(input: {
		expected_revision: number;
		database_id: string;
		space_id: string;
		title?: string;
		source: string;
	}): Promise<SpaceDocumentWriteResult>;
	/** Persist an app-owned document's `source` (+ optional `title`); triggers
	 *  search re-embedding and backlink re-resolution. */
	spacesUpdateDoc?(input: {
		doc_id: string;
		title?: string;
		source: string;
	}): Promise<void>;
	/** Atomically replace or delete a value when it still equals `expected`. */
	storageCompareAndSet?(input: {
		namespace?: string;
		key: string;
		expected?: string | null;
		value?: string | null;
	}): Promise<boolean>;
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
	// --- Subscription accounts (grant `subscriptions:read`). Core-bridge verbs
	// (`subscriptions.list` / `subscriptions.usage` → `host.subscriptions_*`): the
	// host forwards the validated args to the plugin's Core host endpoint, which
	// also requires a verified node owner/admin caller. Labels may be emails. ---
	/** Every subscription provider with its saved accounts and cached usage. */
	subscriptionsList?(
		input: RyuSubscriptionsListArgs
	): Promise<RyuSubscriptions>;
	/** One account's usage reading (the active account when `accountId` is omitted). */
	subscriptionsUsage?(
		input: RyuSubscriptionUsageArgs
	): Promise<RyuProviderUsageReading>;

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
	subtitlesRequest?(input: SubtitlesRequestPayload): Promise<RpcJsonResponse>;
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
	timelineTranscripts?(input: SpeechHistoryInput): Promise<SpeechHistory>;
	/** Transcribe audio. Detailed callers can retain engine segment timestamps. */
	transcribeAudio?(input: {
		audio: string;
		filename?: string;
		detailed?: boolean;
		/** BCP-47 language hint (`auto` = detect); engines may ignore it. */
		language?: string;
	}): Promise<string | TranscriptionDetail>;
	/** Synthesize speech (`/api/voice/speak`). Returns a `data:` audio URL whose
	 *  MIME is the container Core served (`audio/wav` unless `format` selected
	 *  another one the engine could encode). */
	ttsSpeak?(input: {
		text: string;
		engine?: string;
		voice?: string;
		speed?: number;
		language?: string;
		request_id?: string;
		reference_audio_data_url?: string;
		seed?: number;
		instruct?: string;
		reference_text?: string;
		effects?: SpeakEffect[];
		normalize?: SpeakNormalize;
		format?: SpeakFormat;
	}): Promise<string>;

	// --- Tuition (grant `tuition:crud`) and Wire (grant `news:crud`). Both are
	// host-direct through ONE forwarder, the same shape as Reasoning above: the
	// sidecars' twenty-four and nineteen routes need no per-route service, and a route
	// added to either manifest later needs no host change at all. Optional, so a host
	// without the app is unaffected. ---

	/** Forward one call to `/api/tuition<path>`. Resolves with the parsed JSON body and
	 *  REJECTS on any non-2xx, so the frame uses try/catch rather than a status check.
	 *  The host validates `path` (see {@link TuitionRequestPayload}) before building the
	 *  URL; it never accepts a host or an absolute URL from the frame. */
	tuitionRequest?(input: TuitionRequestPayload): Promise<RpcJsonResponse>;
	/** Dismiss one toast previously returned to this caller. There is deliberately
	 * no global clear operation. */
	uiToastDismiss?(input: ToastDismissInput): Promise<void> | void;
	/** Show an ephemeral host-rendered notification. The returned id is opaque and
	 * caller-local: implementations must not reveal the renderer's global id and
	 * must namespace it to the owning plugin before rendering. */
	uiToastShow?(input: ToastShowInput): Promise<string> | string;
	/** Update one toast previously returned to this caller. Unknown ids are a no-op
	 * at the renderer boundary; they must never reach another plugin's toast. */
	uiToastUpdate?(input: ToastUpdateInput): Promise<void> | void;
	updateModelContext?(
		input: import("./model-context.ts").ModelContextInput
	): Promise<import("./model-context.ts").ModelContextState>;
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
	webhooksIngressStatus?(): Promise<WebhookIngressStatusRecord>;
	/** The unified webhook endpoint registry (`GET /api/webhooks`). */
	webhooksList?(): Promise<WebhookRegistryRecord>;
	/** Read one secret through the explicit protected route (`GET /api/webhooks/:id/secret`). */
	webhooksSecretGet?(input: { id: string }): Promise<WebhookSecretReadRecord>;
	/** Set or generate one secret (`POST /api/webhooks/:id/secret`). */
	webhooksSecretSet?(input: {
		id: string;
		secret?: string;
	}): Promise<WebhookSecretWriteRecord>;
	/** Node-config picker: agents on the node (`GET /api/agents`). */
	workflowsAgents?(): Promise<WorkflowAgentsRecords>;
	/** Node-config picker: installed apps + their runnables (`GET /api/plugins`). */
	workflowsApps?(): Promise<WorkflowAppsRecords>;
	workflowsBindConnectTrigger?(input: {
		id: string;
		connectTriggerId: string;
	}): Promise<WorkflowConnectBindingRecord>;
	/** Composio catalog for the trigger picker (`GET /api/composio/*`). One method,
	 *  keyed by `kind`, so one bridge verb covers status/toolkits/triggers/connections. */
	workflowsComposio?(input: {
		kind: WorkflowComposioKind;
		toolkit?: string;
	}): Promise<WorkflowComposioResponse>;
	workflowsConnectBindings?(input: {
		id: string;
	}): Promise<WorkflowConnectBindingRecord[]>;
	/** Delete a workflow (`DELETE /workflows/:id`). */
	workflowsDelete?(input: { id: string }): Promise<void>;
	/** Read one workflow definition (`GET /workflows/:id`). */
	workflowsGet?(input: { id: string }): Promise<WorkflowRecord>;
	/** Node-config picker: every app event an enabled app declares in its manifest
	 *  `contributes.hook_events` (`GET /api/plugins/contributions` → `hook_events`).
	 *  Backs the `event` trigger's picker, so a user chooses a real event instead of
	 *  typing a fully-qualified id from memory. */
	workflowsHookEvents?(): Promise<WorkflowHookEventsRecords>;
	/** List all workflows (`GET /workflows`). */
	workflowsList?(): Promise<WorkflowRecord[]>;
	/** Node-config picker: MCP servers + their tools (`GET /api/mcp/*`). */
	workflowsMcp?(): Promise<WorkflowMcpRecord>;
	/** Node-config picker: verified organization members for NotifyUser steps
	 *  (`GET /api/notifications/mention-targets`). */
	workflowsNotifyTargets?(): Promise<WorkflowNotifyTargetsRecords>;
	workflowsRemoveConnectBinding?(input: {
		id: string;
		bindingId: string;
	}): Promise<void>;
	/** Resume a run suspended at an Awakeable gate (`POST /workflows/runs/:runId/resume`). */
	workflowsResume?(input: {
		runId: string;
		payload: string;
	}): Promise<WorkflowRunRecord>;
	/** Run or dry-run a workflow (`POST /workflows/:id/run`). Returns the run
	 * record; dry runs are transient and read-only. */
	workflowsRun?(input: {
		dryRun?: boolean;
		id: string;
		input?: Record<string, string>;
	}): Promise<WorkflowRunRecord>;
	/** Poll a run's current state (`GET /workflows/runs/:runId`). */
	workflowsRunGet?(input: { runId: string }): Promise<WorkflowRunRecord>;
	/** Upsert a workflow definition (`POST /workflows`). Core validates the DAG. */
	workflowsSave?(input: WorkflowDefinitionInput): Promise<WorkflowRecord>;
	/** Node-config picker: schedules/jobs (`GET /api/schedules/jobs`). */
	workflowsSchedules?(): Promise<WorkflowSchedulesRecords>;
	/** Node-config picker: installed skills (`GET /api/skills`). */
	workflowsSkills?(): Promise<WorkflowSkillsRecords>;
	/** Fetch one workflow template's detail (`GET /api/workflows/catalog/:id`). */
	workflowsTemplateGet?(input: {
		id: string;
	}): Promise<WorkflowTemplateDetailRecord>;
	/** Install a workflow template (`POST /api/workflows/catalog/install`). Returns
	 *  the minted primary workflow id. */
	workflowsTemplateInstall?(input: { templateId: string }): Promise<string>;
	/** Browse the workflow-template catalog (`GET /api/workflows/catalog`). */
	workflowsTemplatesList?(): Promise<WorkflowTemplateRecord[]>;
	/** Snapshot the workflow as a new version (`POST /workflows/:id/versions`). */
	workflowsVersionCreate?(input: {
		id: string;
		label?: string;
		expectedRevision?: string;
	}): Promise<void>;
	/** Read one version's captured definition (`GET /workflows/:id/versions/:vid`). */
	workflowsVersionGet?(input: {
		id: string;
		versionId: string;
	}): Promise<WorkflowDefinitionInput>;
	/** Restore a version as the current definition (`POST …/versions/:vid/restore`). */
	workflowsVersionRestore?(input: {
		id: string;
		versionId: string;
	}): Promise<WorkflowRecord>;
	/** List a workflow's saved versions (`GET /workflows/:id/versions`). */
	workflowsVersionsList?(input: {
		id: string;
	}): Promise<WorkflowVersionRecord[]>;
	/** The workflow's inbound webhook URL for display (`GET /api/workflows/:id/webhook`). */
	workflowsWebhook?(input: { id: string }): Promise<WorkflowWebhookRecord>;
	writeOpenedFile?(
		input: { uri: string; expectedRevision: string } & (
			| { text: string; blob?: never }
			| { blob: string; text?: never }
		)
	): Promise<import("./opened-file.ts").OpenedFileSnapshot>;
}

export interface I18nHostRuntime {
	getSnapshot(): I18nHostSnapshot;
	subscribe(listener: () => void): () => void;
	t(
		id: string,
		values?: I18nHostTranslateInput["values"],
		fallback?: string
	): string;
}

/** Build the shared i18n host callbacks for every trusted shell surface. */
export function createI18nHostServices(
	runtime: I18nHostRuntime
): Pick<HostServices, "i18nSnapshot" | "i18nTranslate" | "i18nSubscribe"> {
	return {
		i18nSnapshot: () => runtime.getSnapshot(),
		i18nTranslate: (input) =>
			runtime.t(input.id, input.values, input.defaultMessage),
		i18nSubscribe: (_input, emit, signal) =>
			new Promise<void>((resolve) => {
				let done = false;
				const finish = () => {
					if (done) {
						return;
					}
					done = true;
					unsubscribe();
					signal.removeEventListener("abort", finish);
					resolve();
				};
				const push = () => emit(JSON.stringify(runtime.getSnapshot()));
				const unsubscribe = runtime.subscribe(push);
				push();
				if (signal.aborted) {
					finish();
				} else {
					signal.addEventListener("abort", finish, { once: true });
				}
			}),
	};
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
const hostApiMethodFieldsSchema = z.object({
	grant: z.string().nullable(),
	method: z.string(),
	streaming: z.boolean(),
});
/** Rust-only methods retain their own vocabulary; dispatched rows use host caps. */
const hostApiMethodsSchema = z.array(
	z.discriminatedUnion("tsHost", [
		hostApiMethodFieldsSchema.extend({
			tsHost: z.literal(false),
			capability: z.string(),
		}),
		hostApiMethodFieldsSchema.extend({
			tsHost: z.literal(true),
			capability: capabilitySchema,
		}),
	])
);

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

const HOST_API_METHODS = hostApiMethodsSchema.parse(hostApiContract.methods);

const methodCapability: Record<string, Capability> = {};
const grantCapability: Record<string, Capability> = {};
const streamingMethods = new Set<string>();
for (const entry of HOST_API_METHODS) {
	// A Rust-bridge-only method (`tsHost === false`) is not part of this host's
	// dispatch surface; skipping it keeps its capability out of the TS tables.
	if (!entry.tsHost) {
		continue;
	}
	const capability = entry.capability;
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
export const METHOD_CAPABILITY = methodCapability;

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
export const GRANT_CAPABILITY = grantCapability;

/** Local host capabilities are intentionally available only through their
 * explicit contract rows; they are never inferred from plugin grants. */
const LOCAL_HOST_CAPABILITIES: ReadonlySet<Capability> = new Set([
	"host.capabilities",
	"i18n",
	"node.shareOrigins",
	"ui.displayMode",
]);

/** Capabilities whose ungranted call throws a STRUCTURED {@link CodedRpcError}
 *  (`denied`) instead of the legacy plain-string {@link CapabilityError}. Only the
 *  greenfield app host-bridge methods opt in; the legacy paths keep string errors so
 *  their existing readers are unaffected. */
const CODED_ERROR_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
	"timeline.speech",
	"media.recording",
	"ui.toast",
	"app.http",
	"app.realtime",
	"model.complete",
	"agent.run",
	"storage.kv",
	"spaces.docs",
	"spaces.database",
	"media.generate",
	"voice.models.manage",
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
	"plugins.install",
	"reasoning.check",
	"safe-actions.manage",
	"rlm.query",
	"blueprint.review",
	"tuition.crud",
	"news.crud",
	"subscriptions.read",
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
		} else if (appHttpGrantTarget(grant) !== null) {
			// A reviewed per-target grant (`app:http:@scope/name`) unlocks the
			// `app.request` verb; the host's service then admits only that target
			// (and the caller's own sidecar only with plain `app:http`).
			caps.add("app.http");
		}
	}
	return caps;
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

export type RpcDispatchResult = Awaited<ReturnType<typeof dispatchRpc>>;

export async function dispatchRpc(
	method: string,
	args: unknown[],
	granted: ReadonlySet<Capability>,
	services: HostServices,
	signal?: AbortSignal
) {
	assertGranted(method, granted);
	switch (method) {
		case "host.capabilities":
			if (args.length !== 0) {
				throw new CapabilityError("host.capabilities takes no arguments");
			}
			return {
				...(await (services.hostCapabilities?.() ??
					detectBrowserHostCapabilities())),
				bridge: hostBridgeFeatures(services),
			};
		case "i18n.get":
			if (args.length !== 0) {
				throw new CapabilityError("i18n.get takes no arguments");
			}
			if (!services.i18nSnapshot) {
				throw new CapabilityError("i18n.get is not available");
			}
			return await services.i18nSnapshot();
		case "i18n.translate": {
			const input = asI18nTranslateArg(args[0]);
			if (!input || args.length !== 1) {
				throw new CodedRpcError(
					"invalid_args",
					"i18n.translate requires { id, defaultMessage, values? }"
				);
			}
			if (!services.i18nTranslate) {
				throw new CodedRpcError(
					"server_error",
					"i18n.translate is not available"
				);
			}
			return await services.i18nTranslate(input);
		}
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
		case "subscriptions.list": {
			const input = args.length === 0 ? {} : asSubscriptionsListArg(args[0]);
			if (!input || args.length > 1) {
				throw new CodedRpcError(
					"invalid_args",
					"subscriptions.list takes an optional { providerId?: string, usage?: 'none'|'cached'|'refresh' }"
				);
			}
			if (!services.subscriptionsList) {
				throw new CodedRpcError(
					"server_error",
					"subscriptions.list is not available"
				);
			}
			return await services.subscriptionsList(input);
		}
		case "subscriptions.usage": {
			const input = asSubscriptionUsageArg(args[0]);
			if (!input || args.length !== 1) {
				throw new CodedRpcError(
					"invalid_args",
					"subscriptions.usage requires a { providerId: string, accountId?: string }"
				);
			}
			if (!services.subscriptionsUsage) {
				throw new CodedRpcError(
					"server_error",
					"subscriptions.usage is not available"
				);
			}
			return await services.subscriptionsUsage(input);
		}
		case "chat.list":
			if (args.length !== 0) {
				throw new CodedRpcError("invalid_args", "chat.list takes no arguments");
			}
			if (!services.chatListConversations) {
				throw new CodedRpcError("server_error", "chat.list is not available");
			}
			return chatConversationSummariesSchema.parse(
				await services.chatListConversations()
			);
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
			return chatSendResultSchema.parse(await services.chatSend(input));
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
			return routeRegistrationRecordSchema.parse(
				await services.registerRoute(claim)
			);
		}
		case "tool.call": {
			// args = [toolName, toolArgs]. The host pins the origin server; the frame
			// supplies only the name + arguments. Bad shape → invalid_args (D6).
			const [rawName, toolArgs] = args;
			const name = rpcToolNameSchema.safeParse(rawName);
			if (!name.success) {
				throw new CodedRpcError(
					"invalid_args",
					"tool.call requires a tool name string"
				);
			}
			if (!services.callTool) {
				throw new CodedRpcError("server_error", "tool.call is not available");
			}
			const parsedArgs = rpcJsonResponseSchema.safeParse(toolArgs);
			if (!parsedArgs.success) {
				throw new CodedRpcError(
					"invalid_args",
					"tool.call requires JSON arguments"
				);
			}
			return rpcJsonResponseSchema.parse(
				await services.callTool(name.data, parsedArgs.data)
			);
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
		case "ui.updateModelContext": {
			if (!services.updateModelContext) {
				throw new CodedRpcError("server_error", "Model context is unavailable");
			}
			const { parseModelContext } = await import("./model-context.ts");
			try {
				return await services.updateModelContext(parseModelContext(args[0]));
			} catch (error) {
				throw new CodedRpcError(
					"invalid_args",
					error instanceof Error ? error.message : "Invalid model context"
				);
			}
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
		case "files.read":
		case "files.write": {
			const input = openedFileUriSchema.safeParse(args[0]);
			if (args.length !== 1 || !input.success) {
				throw new CodedRpcError(
					"invalid_args",
					"File requests require a resource URI"
				);
			}
			if (method === "files.read") {
				if (!services.readOpenedFile) {
					throw new CodedRpcError("denied", "No file is open in this panel");
				}
				return await services.readOpenedFile({ uri: input.data.uri });
			}
			const revision = openedFileRevisionSchema.safeParse(args[0]);
			if (!revision.success) {
				throw new CodedRpcError(
					"invalid_args",
					"Saving requires text and the revision read by this editor"
				);
			}
			if (!services.writeOpenedFile) {
				throw new CodedRpcError("denied", "This file is read-only");
			}
			const text = openedFileTextWriteSchema.safeParse(args[0]);
			if (text.success) {
				return await services.writeOpenedFile(text.data);
			}
			const blob = openedFileBlobWriteSchema.safeParse(args[0]);
			if (blob.success) {
				return await services.writeOpenedFile(blob.data);
			}
			throw new CodedRpcError(
				"invalid_args",
				"Saving requires exactly one text or blob representation"
			);
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
			const state = rpcJsonResponseSchema.safeParse(args[0]);
			if (!state.success) {
				throw new CodedRpcError(
					"invalid_args",
					"widget.setState requires JSON state"
				);
			}
			return await services.setWidgetState(state.data);
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
			const { template } = rpcModalArgSchema.parse(args[0]);
			return await services.requestModal({ template });
		}
		case "ui.notifyHeight": {
			const px = rpcHeightSchema.safeParse(args[0]);
			if (!px.success) {
				throw new CodedRpcError(
					"invalid_args",
					"ui.notifyHeight requires a non-negative number"
				);
			}
			services.notifyHeight?.(px.data);
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
			return uploadedFilesSchema.parse(await services.uploadFile(input));
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
					"model.complete requires a { prompt: string } and at most 8 data:image/{png,jpeg,webp} images totalling 1.5 MiB"
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
		case "backups.destinations":
		case "backups.create":
		case "backups.list":
		case "backups.get":
		case "backups.restore": {
			if (!services.backupsRequest) {
				throw new CodedRpcError(
					"server_error",
					"Backups are not available on this host"
				);
			}
			const input = preserveHostResponse(databaseResponseJsonSchema).safeParse(
				args[0] ?? {}
			);
			if (!input.success) {
				throw new CodedRpcError(
					"invalid_args",
					"Backups require JSON snapshot arguments"
				);
			}
			return appBackupResponseSchema(method).parse(
				await services.backupsRequest(method, input.data)
			);
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
		case "spaces.createDatabase": {
			const input = asSpacesCreateArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"spaces.createDatabase requires { space_id: string, title: string }"
				);
			}
			if (!services.spacesCreateDatabase) {
				throw new CodedRpcError(
					"server_error",
					"spaces.createDatabase is not available"
				);
			}
			return await services.spacesCreateDatabase(input);
		}
		case "spaces.listDatabases": {
			const input = asSpacesListArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"spaces.listDatabases requires { space_id: string }"
				);
			}
			if (!services.spacesListDatabases) {
				throw new CodedRpcError(
					"server_error",
					"spaces.listDatabases is not available"
				);
			}
			return await services.spacesListDatabases(input);
		}
		case "spaces.getDatabase": {
			const input = asSpacesDatabaseArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"spaces.getDatabase requires { space_id: string, database_id: string }"
				);
			}
			if (!services.spacesGetDatabase) {
				throw new CodedRpcError(
					"server_error",
					"spaces.getDatabase is not available"
				);
			}
			return await services.spacesGetDatabase(input);
		}
		case "spaces.updateDatabase": {
			const input = asSpacesUpdateDatabaseArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"spaces.updateDatabase requires a database id, source, and expected revision"
				);
			}
			if (!services.spacesUpdateDatabase) {
				throw new CodedRpcError(
					"server_error",
					"spaces.updateDatabase is not available"
				);
			}
			return spaceDocumentWriteResultSchema.parse(
				await services.spacesUpdateDatabase(input)
			);
		}
		case "spaces.queryDatabase": {
			const input = asSpacesQueryDatabaseArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"spaces.queryDatabase requires a database id and one read-only SQL query"
				);
			}
			if (!services.spacesQueryDatabase) {
				throw new CodedRpcError(
					"server_error",
					"spaces.queryDatabase is not available"
				);
			}
			return spaceDatabaseQueryResultSchema.parse(
				await services.spacesQueryDatabase(input)
			);
		}
		case "spaces.deleteDatabase": {
			const input = asSpacesDatabaseArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"spaces.deleteDatabase requires { space_id: string, database_id: string }"
				);
			}
			if (!services.spacesDeleteDatabase) {
				throw new CodedRpcError(
					"server_error",
					"spaces.deleteDatabase is not available"
				);
			}
			return await services.spacesDeleteDatabase(input);
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
					"media.video requires { prompt: string } with at most two data:image frames, data:video/data:audio inputs, and provider_input without routing keys, 40 MiB in total"
				);
			}
			if (!services.generateVideo) {
				throw new CodedRpcError("server_error", "media.video is not available");
			}
			return await services.generateVideo(input);
		}
		case "media.audio": {
			const input = asMediaAudioArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					'media.audio requires { prompt, kind: "music" | "sfx", provider, model } with bounded optional duration_s and provider_input'
				);
			}
			if (!services.generateAudio) {
				throw new CodedRpcError("server_error", "media.audio is not available");
			}
			return await services.generateAudio(input);
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
		case "media.ttsEngines": {
			if (!services.listTtsEngines) {
				throw new CodedRpcError(
					"server_error",
					"media.ttsEngines is not available"
				);
			}
			return await services.listTtsEngines();
		}
		case "media.ttsEngineInstall": {
			const input = asMediaTtsEngineInstallArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"media.ttsEngineInstall requires an { engine } id"
				);
			}
			if (!services.installTtsEngine) {
				throw new CodedRpcError(
					"server_error",
					"media.ttsEngineInstall is not available"
				);
			}
			return voiceEngineInstallRecordSchema.parse(
				await services.installTtsEngine(input)
			);
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
			return rpcJsonResponseSchema.parse(await services.finetuneCapability());
		case "finetune.list":
			if (!services.finetuneList) {
				throw new CodedRpcError(
					"server_error",
					"finetune.list is not available"
				);
			}
			return rpcJsonResponseSchema.parse(await services.finetuneList());
		case "finetune.adapters":
			if (!services.finetuneAdapters) {
				throw new CodedRpcError(
					"server_error",
					"finetune.adapters is not available"
				);
			}
			return rpcJsonResponseSchema.parse(await services.finetuneAdapters());
		case "finetune.start": {
			const input = asFinetuneJobSpecArg(args[0]);
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
			return rpcJsonResponseSchema.parse(await services.finetuneStart(input));
		}
		case "finetune.merge": {
			const input = asFinetuneJobSpecArg(args[0]);
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
			return rpcJsonResponseSchema.parse(await services.finetuneMerge(input));
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
			return rpcJsonResponseSchema.parse(await services.finetuneGet(input));
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
			return rpcJsonResponseSchema.parse(await services.finetuneCancel(input));
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
		case "assets.searchImages": {
			const input = asImageSearchArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"assets.searchImages requires { provider, query }"
				);
			}
			if (!services.searchImages) {
				throw new CapabilityError("assets.searchImages is not available");
			}
			return await services.searchImages(input);
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
			return workflowRecordsSchema.parse(await services.workflowsList());
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
			return workflowRecordSchema.parse(await services.workflowsGet(input));
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
			return workflowRecordSchema.parse(await services.workflowsSave(input));
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
			return workflowVersionRecordsSchema.parse(
				await services.workflowsVersionsList(input)
			);
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
			return workflowDefinitionInputSchema.parse(
				await services.workflowsVersionGet(input)
			);
		}
		case "workflows.versionCreate": {
			const input = asWorkflowVersionCreateArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"workflows.versionCreate requires a { id: string, label?: string, expectedRevision?: string }"
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
			return workflowRecordSchema.parse(
				await services.workflowsVersionRestore(input)
			);
		}
		case "workflows.templatesList":
			if (!services.workflowsTemplatesList) {
				throw new CodedRpcError(
					"server_error",
					"workflows.templatesList is not available"
				);
			}
			return workflowTemplateRecordsSchema.parse(
				await services.workflowsTemplatesList()
			);
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
			return workflowTemplateDetailRecordSchema.parse(
				await services.workflowsTemplateGet(input)
			);
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
			return workflowWebhookRecordSchema.parse(
				await services.workflowsWebhook(input)
			);
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
			return workflowRunRecordSchema.parse(await services.workflowsRun(input));
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
			return workflowRunRecordSchema.parse(
				await services.workflowsRunGet(input)
			);
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
			return workflowRunRecordSchema.parse(
				await services.workflowsResume(input)
			);
		}
		case "workflows.agents":
			if (!services.workflowsAgents) {
				throw new CodedRpcError(
					"server_error",
					"workflows.agents is not available"
				);
			}
			return workflowAgentsRecordsSchema.parse(
				await services.workflowsAgents()
			);
		case "workflows.apps":
			if (!services.workflowsApps) {
				throw new CodedRpcError(
					"server_error",
					"workflows.apps is not available"
				);
			}
			return workflowAppsRecordsSchema.parse(await services.workflowsApps());
		case "workflows.mcp":
			if (!services.workflowsMcp) {
				throw new CodedRpcError(
					"server_error",
					"workflows.mcp is not available"
				);
			}
			return workflowMcpRecordSchema.parse(await services.workflowsMcp());
		case "workflows.skills":
			if (!services.workflowsSkills) {
				throw new CodedRpcError(
					"server_error",
					"workflows.skills is not available"
				);
			}
			return workflowSkillsRecordsSchema.parse(
				await services.workflowsSkills()
			);
		case "workflows.schedules":
			if (!services.workflowsSchedules) {
				throw new CodedRpcError(
					"server_error",
					"workflows.schedules is not available"
				);
			}
			return workflowSchedulesRecordsSchema.parse(
				await services.workflowsSchedules()
			);
		case "workflows.notifyTargets":
			if (!services.workflowsNotifyTargets) {
				throw new CodedRpcError(
					"server_error",
					"workflows.notifyTargets is not available"
				);
			}
			return workflowNotifyTargetsRecordsSchema.parse(
				await services.workflowsNotifyTargets()
			);
		case "workflows.hookEvents":
			if (!services.workflowsHookEvents) {
				throw new CodedRpcError(
					"server_error",
					"workflows.hookEvents is not available"
				);
			}
			return workflowHookEventsRecordsSchema.parse(
				await services.workflowsHookEvents()
			);
		case "workflows.connectBindings": {
			const input = asConnectWorkflowIdArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"A saved workflow id is required"
				);
			}
			if (!services.workflowsConnectBindings) {
				throw new CodedRpcError(
					"server_error",
					"Connect workflow bindings are not available"
				);
			}
			return workflowConnectBindingRecordsSchema.parse(
				await services.workflowsConnectBindings(input)
			);
		}
		case "workflows.bindConnectTrigger": {
			const input = asWorkflowBindingArg(args[0], "connectTriggerId");
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"A workflow id and Connect trigger id are required"
				);
			}
			if (!services.workflowsBindConnectTrigger) {
				throw new CodedRpcError(
					"server_error",
					"Connect workflow binding is not available"
				);
			}
			return workflowConnectBindingRecordSchema.parse(
				await services.workflowsBindConnectTrigger({
					id: input.id,
					connectTriggerId: input.value,
				})
			);
		}
		case "workflows.removeConnectBinding": {
			const input = asWorkflowBindingArg(args[0], "bindingId");
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"A workflow id and binding id are required"
				);
			}
			if (!services.workflowsRemoveConnectBinding) {
				throw new CodedRpcError(
					"server_error",
					"Connect workflow binding removal is not available"
				);
			}
			return await services.workflowsRemoveConnectBinding({
				id: input.id,
				bindingId: input.value,
			});
		}
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
			return workflowComposioResponseSchema(input.kind).parse(
				await services.workflowsComposio(input)
			);
		}
		case "ghost.recipes":
			if (!services.ghostRecipes) {
				throw new CodedRpcError(
					"server_error",
					"ghost.recipes is not available"
				);
			}
			return ghostRecipeSummariesSchema.parse(await services.ghostRecipes());
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
			return ghostRecordingStateSchema.parse(
				await services.ghostRecordStart(input)
			);
		}
		case "ghost.recordStatus":
			if (!services.ghostRecordStatus) {
				throw new CodedRpcError(
					"server_error",
					"ghost.recordStatus is not available"
				);
			}
			return ghostRecordingStateSchema.parse(
				await services.ghostRecordStatus()
			);
		case "ghost.recordStop":
			if (!services.ghostRecordStop) {
				throw new CodedRpcError(
					"server_error",
					"ghost.recordStop is not available"
				);
			}
			return ghostRecordingStopSchema.parse(await services.ghostRecordStop());
		case "webhooks.list":
			if (!services.webhooksList) {
				throw new CodedRpcError(
					"server_error",
					"webhooks.list is not available"
				);
			}
			return webhookRegistryRecordSchema.parse(await services.webhooksList());
		case "webhooks.ingressStatus":
			if (!services.webhooksIngressStatus) {
				throw new CodedRpcError(
					"server_error",
					"webhooks.ingressStatus is not available"
				);
			}
			return webhookIngressStatusRecordSchema.parse(
				await services.webhooksIngressStatus()
			);
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
			return webhookSecretReadSchema.parse(
				await services.webhooksSecretGet(input)
			);
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
			return webhookSecretWriteSchema.parse(
				await services.webhooksSecretSet(input)
			);
		}
		case "quests.list":
			if (!services.questsList) {
				throw new CodedRpcError("server_error", "quests.list is not available");
			}
			return questRecordsSchema.parse(
				await services.questsList(asQuestListArg(args[0]))
			);
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
			return questRecordSchema.parse(await services.questsCapture(input));
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
			return questRecordSchema.parse(
				await services.questsUse({
					...input,
					complete: asOptionalComplete(args[0]),
				})
			);
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
			return questRecordSchema.parse(
				await services.questsPin({
					...input,
					pinned: asOptionalPinned(args[0]),
				})
			);
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
			return questRecordSchema.parse(await services.questsCreate(input));
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
			return questRecordSchema.parse(await services.questsUpdate(input));
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
			return questRecordSchema.parse(await services.questsComplete(input));
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
			return questRecordSchema.parse(await services.questsDismiss(input));
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
			return questRecordSchema.parse(
				await services.questsAcceptSuggestion(input)
			);
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
			return questRecordSchema.parse(
				await services.questsDismissSuggestion(input)
			);
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
			return questJudgeResultSchema.parse(await services.questsJudge(input));
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
			return activityRecordsSchema.parse(await services.activityList(input));
		}
		case "activity.audit": {
			const input = asActivityAuditArg(args[0]);
			if (!services.activityAudit) {
				throw new CodedRpcError(
					"server_error",
					"activity.audit is not available"
				);
			}
			return activityAuditResponseSchema.parse(
				await services.activityAudit(input)
			);
		}
		case "activity.prune":
			if (!services.activityPrune) {
				throw new CodedRpcError(
					"server_error",
					"activity.prune is not available"
				);
			}
			return activityPruneResponseSchema.parse(await services.activityPrune());
		case "activity.score": {
			const input = asActivityScoreArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"activity.score requires a { response: unknown } object"
				);
			}
			if (!services.activityScore) {
				throw new CodedRpcError(
					"server_error",
					"activity.score is not available"
				);
			}
			return activityScoreResponseSchema.parse(
				await services.activityScore(input)
			);
		}
		case "activity.trace": {
			const input = asActivityTraceArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"activity.trace requires a { run_id: string } object"
				);
			}
			if (!services.activityTrace) {
				throw new CodedRpcError(
					"server_error",
					"activity.trace is not available"
				);
			}
			return activityTraceResponseSchema.parse(
				await services.activityTrace(input)
			);
		}
		case "activity.redteam": {
			const input = asActivityRedteamArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"activity.redteam requires a { agent_id: string, model?: string } object"
				);
			}
			if (!services.activityRedteam) {
				throw new CodedRpcError(
					"server_error",
					"activity.redteam is not available"
				);
			}
			return activityRedteamResponseSchema.parse(
				await services.activityRedteam(input)
			);
		}
		case "activity.eval": {
			const input = asActivityRedteamArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"activity.eval requires a { agent_id: string, model?: string } object"
				);
			}
			if (!services.activityEval) {
				throw new CodedRpcError(
					"server_error",
					"activity.eval is not available"
				);
			}
			return activityEvalResponseSchema.parse(
				await services.activityEval(input)
			);
		}
		case "activity.importTrace": {
			const input = asActivityImportTraceArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"activity.importTrace requires a { run_id: string } object"
				);
			}
			if (!services.activityImportTrace) {
				throw new CodedRpcError(
					"server_error",
					"activity.importTrace is not available"
				);
			}
			return activityTraceImportRecordSchema.parse(
				await services.activityImportTrace(input)
			);
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
		case "media.recording": {
			const input = parseMediaRecordingInput(args[0]);
			if (!input) {
				throw new CodedRpcError("invalid_args", "Invalid recording action.");
			}
			if (!services.mediaRecording) {
				return {
					available: false,
					background: false,
					state: "idle",
					message:
						"Microphone capture is unavailable on this surface. Import audio instead.",
				};
			}
			return await services.mediaRecording(input);
		}
		case "timeline.transcripts": {
			const input = parseSpeechHistoryInput(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"Choose a speech history window of up to one day."
				);
			}
			if (!services.timelineTranscripts) {
				throw new CodedRpcError(
					"server_error",
					"Shadow speech history is unavailable on this surface."
				);
			}
			return await services.timelineTranscripts(input);
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
			return timelineEventRecordsSchema.parse(
				await services.timelineList(input)
			);
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
			return timelineJournalRecordSchema
				.nullable()
				.parse(await services.timelineJournal(input));
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
			return mailInboxesSchema.parse(await services.mailList());
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
			return mailMessagesSchema.parse(await services.mailMessages(input));
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
			return mailInboxSchema.parse(await services.mailCreate(input));
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
			return mailMessageSchema.parse(await services.mailSend(input));
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
		case "mail.request": {
			const input = asMailRequestArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"mail.request requires a safe /api/mail/* path and optional method/body"
				);
			}
			if (!services.mailRequest) {
				throw new CodedRpcError(
					"server_error",
					"mail.request is not available"
				);
			}
			return rpcJsonResponseSchema.parse(await services.mailRequest(input));
		}
		case "calendar.jobs":
			if (!services.calendarJobs) {
				throw new CodedRpcError(
					"server_error",
					"calendar.jobs is not available"
				);
			}
			return calendarJobsSchema.parse(await services.calendarJobs());
		case "calendar.workflows":
			if (!services.calendarWorkflows) {
				throw new CodedRpcError(
					"server_error",
					"calendar.workflows is not available"
				);
			}
			return calendarWorkflowsSchema.parse(await services.calendarWorkflows());
		case "calendar.agents":
			if (!services.calendarAgents) {
				throw new CodedRpcError(
					"server_error",
					"calendar.agents is not available"
				);
			}
			return calendarAgentsSchema.parse(await services.calendarAgents());
		case "warmup.detect":
			if (!services.warmupDetect) {
				throw new CodedRpcError(
					"server_error",
					"warmup.detect is not available"
				);
			}
			return warmupDetectionSchema.parse(await services.warmupDetect());
		case "warmup.list":
			if (!services.warmupList) {
				throw new CodedRpcError("server_error", "warmup.list is not available");
			}
			return calendarJobsSchema.parse(await services.warmupList());
		case "warmup.apply": {
			const jobs = asWarmupJobsArg(args[0]);
			if (!jobs) {
				throw new CodedRpcError(
					"invalid_args",
					"warmup.apply expects an array of { name, schedule, target:{type:'agent'|'provider_account',…} }"
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
			return learningConfigSchema.parse(await services.learningConfig());
		case "learning.experience":
			if (!services.learningExperience) {
				throw new CodedRpcError(
					"server_error",
					"learning.experience is not available"
				);
			}
			return learningExperienceListSchema.parse(
				await services.learningExperience()
			);
		case "learning.healing":
			if (!services.learningHealing) {
				throw new CodedRpcError(
					"server_error",
					"learning.healing is not available"
				);
			}
			return learningHealingStatusSchema.parse(
				await services.learningHealing()
			);
		case "approvals.list":
			if (!services.approvalsList) {
				throw new CodedRpcError(
					"server_error",
					"approvals.list is not available"
				);
			}
			return approvalRecordsSchema.parse(await services.approvalsList());
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
			return approvalRecordSchema.parse(await services.approvalsApprove(input));
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
			return approvalRecordSchema.parse(await services.approvalsReject(input));
		}
		case "notifications.list": {
			const input = asNotificationListArg(args[0]);
			if (input === null) {
				throw new CodedRpcError(
					"invalid_args",
					"notifications.list requires an optional boolean archived filter"
				);
			}
			if (!services.notificationsList) {
				throw new CodedRpcError(
					"server_error",
					"notifications.list is not available"
				);
			}
			return notificationRecordsSchema.parse(
				await services.notificationsList(input)
			);
		}
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
			const { appIds } = rpcNotificationAppIconsSchema.parse(args[0]);
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
			return proactiveSuggestionRecordsSchema.parse(
				await services.suggestionsList()
			);
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
			return meetingRecordsSchema.parse(await services.meetingsList());
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
			return meetingTranscriptSchema.parse(
				await services.meetingsTranscript(input)
			);
		}
		case "meetings.start": {
			const input = asMeetingStartArg(args[0]);
			if (!services.meetingsStart) {
				throw new CodedRpcError(
					"server_error",
					"meetings.start is not available"
				);
			}
			return meetingRecordSchema.parse(await services.meetingsStart(input));
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
			return meetingRecordSchema.parse(await services.meetingsFinalize(input));
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
			return meetingRecordSchema.parse(await services.meetingsRename(input));
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
			return meetingRecordSchema.parse(await services.meetingsSetIcon(input));
		}
		case "meetings.import":
			if (!services.meetingsImport) {
				throw new CodedRpcError(
					"server_error",
					"meetings.import is not available"
				);
			}
			return meetingRecordSchema
				.nullable()
				.parse(await services.meetingsImport());
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
			return rpcJsonResponseSchema.parse(await services.socialRequest(input));
		}
		case "app.request": {
			const input = asAppRequestArg(args[0]);
			if (!input) {
				throw new CodedRpcError(
					"invalid_args",
					"app.request requires a relative { path, method?, body?, app? } request"
				);
			}
			if (!services.appRequest) {
				throw new CodedRpcError("server_error", "app.request is not available");
			}
			const readSignal = input.method === "GET" ? signal : undefined;
			throwIfAppRequestAborted(readSignal);
			return rpcJsonResponseSchema.parse(
				await services.appRequest(input, readSignal)
			);
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
			return rpcJsonResponseSchema.parse(
				await services.subtitlesRequest(input)
			);
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
			return rpcJsonResponseSchema.parse(
				await services.reasoningRequest(input)
			);
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
			return rpcJsonResponseSchema.parse(
				await services.safeActionsRequest(input)
			);
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
			return rpcJsonResponseSchema.parse(await services.rlmRequest(input));
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
			return rpcJsonResponseSchema.parse(await services.tuitionRequest(input));
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
			return rpcJsonResponseSchema.parse(await services.newsRequest(input));
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
			return rpcJsonResponseSchema.parse(
				await services.blueprintRequest(input)
			);
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
		case "apps.installBundle": {
			if (args.length !== 1) {
				throw new CodedRpcError(
					"invalid_args",
					"apps.installBundle requires one app bundle"
				);
			}
			if (!services.appsInstallBundle) {
				throw new CodedRpcError(
					"server_error",
					"apps.installBundle is not available"
				);
			}
			return appBundleInstallResultSchema.parse(
				await services.appsInstallBundle(args[0])
			);
		}
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
			return skillSourceRecordSchema.parse(
				await services.skillsGetSource(input)
			);
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
			return skillWriteRecordSchema.parse(await services.skillsCreate(input));
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
			return skillWriteRecordSchema.parse(await services.skillsUpdate(input));
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
			return skillVersionRecordsSchema.parse(
				await services.skillsListVersions(input)
			);
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

const toastIdSchema = z.string().min(1).max(TOAST_LIMITS.idChars);
const toastTitleSchema = z
	.string()
	.min(1)
	.max(TOAST_LIMITS.titleChars)
	.refine((value) => value.trim().length > 0);
const toastDescriptionSchema = z.string().max(TOAST_LIMITS.descriptionChars);
const toastVariantSchema = z.enum([
	"default",
	"success",
	"info",
	"warning",
	"error",
	"loading",
]);
const toastDurationSchema = z
	.number()
	.int()
	.min(TOAST_LIMITS.durationMinMs)
	.max(TOAST_LIMITS.durationMaxMs);
const toastFieldsSchema = {
	description: toastDescriptionSchema.optional(),
	duration: toastDurationSchema.optional(),
	variant: toastVariantSchema.optional(),
};
const toastMutableFields = [
	"description",
	"duration",
	"title",
	"variant",
] as const;
const toastShowSchema = z
	.strictObject({
		...toastFieldsSchema,
		title: toastTitleSchema,
	})
	.transform((input): ToastShowInput => {
		const output: ToastShowInput = { title: input.title };
		if (input.description !== undefined) {
			output.description = input.description;
		}
		if (input.duration !== undefined) {
			output.duration = input.duration;
		}
		if (input.variant !== undefined) {
			output.variant = input.variant;
		}
		return output;
	});
const toastUpdateSchema = z
	.strictObject({
		...toastFieldsSchema,
		id: toastIdSchema,
		title: toastTitleSchema.optional(),
	})
	.refine(
		(input) =>
			toastMutableFields.some((key) => input[key] !== undefined) &&
			toastMutableFields.every(
				(key) => !Object.hasOwn(input, key) || input[key] !== undefined
			)
	);
const toastDismissSchema = z.strictObject({ id: toastIdSchema });

/** Validate a caller-local opaque id bounded by the toast contract. */
export const asToastId = nullableRpcParser(toastIdSchema);
/** Strictly validate show; reject styling fields outside the public contract. */
export const asToastShowArg = nullableRpcParser(toastShowSchema);
/** Require a mutable field; an empty description clears the existing description. */
export const asToastUpdateArg = nullableRpcParser(toastUpdateSchema);
/** Only one caller-local toast id may be dismissed. */
export const asToastDismissArg = nullableRpcParser(toastDismissSchema);

/** Narrow an RPC argument to a `{ prompt: string }`. Returns null for any other
 *  shape so a malformed follow-up never reaches the governed route. */
const promptArgSchema = z.object({ prompt: z.string().min(1) });
export const asPromptArg = nullableRpcParser(promptArgSchema);

/** Validate primitive translation arguments and bound the projected entry count. */
const i18nValuesSchema = z
	.record(z.string(), z.unknown())
	.transform((values) =>
		Object.fromEntries(Object.entries(values).slice(0, 32))
	)
	.pipe(
		z.record(
			z.string().min(1).max(80),
			z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])
		)
	);
const i18nTranslateArgSchema = z
	.object({
		defaultMessage: z
			.string()
			.max(32_000)
			.refine((value) => value.trim().length > 0),
		id: z
			.string()
			.max(200)
			.refine((value) => value.trim().length > 0),
		values: i18nValuesSchema.optional(),
	})
	.transform((input): I18nHostTranslateInput => {
		const output: I18nHostTranslateInput = {
			defaultMessage: input.defaultMessage,
			id: input.id,
		};
		if (input.values !== undefined) {
			output.values = input.values;
		}
		return output;
	});
export const asI18nTranslateArg = nullableRpcParser(i18nTranslateArgSchema);

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

const assistantContextItemSchema = z.object({
	id: z
		.string()
		.min(1)
		.transform((value) => value.slice(0, MAX_LABEL)),
	text: z
		.string()
		.transform((value) => value.slice(0, MAX_CONTEXT_TEXT))
		.catch(""),
	title: z
		.string()
		.min(1)
		.transform((value) => value.slice(0, MAX_LABEL)),
});
const assistantContextArgSchema = z.object({
	items: z.custom<unknown[]>(Array.isArray).transform((items) =>
		items.slice(0, MAX_CONTEXT_ITEMS).flatMap((item) => {
			const parsed = assistantContextItemSchema.safeParse(item);
			return parsed.success ? [parsed.data] : [];
		})
	),
});
/** Drop malformed items and clamp context before it can enter a prompt. */
export const asAssistantContextArg = nullableRpcParser(
	assistantContextArgSchema
);

/** 32-bit FNV-1a, hex — keeps a clamped id distinct from its siblings. */
function shortHash(value: string): string {
	let hash = 0x81_1c_9d_c5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01_00_01_93);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Clamp an identifier to the label cap without merging distinct values: an
 *  over-long id keeps a prefix plus a hash of the whole value. */
function clampIdentifier(value: string): string {
	if (value.length <= MAX_LABEL) {
		return value;
	}
	const hash = shortHash(value);
	return `${value.slice(0, MAX_LABEL - hash.length - 1)}#${hash}`;
}

const assistantStringListSchema = z
	.custom<unknown[]>(Array.isArray)
	.transform((items) => {
		const labelSchema = z.string().refine((value) => value.trim().length > 0);
		const labels = items
			.flatMap((item) => {
				const parsed = labelSchema.safeParse(item);
				return parsed.success ? [parsed.data] : [];
			})
			.slice(0, MAX_LIST_ENTRIES)
			.map((value) => value.slice(0, MAX_LABEL));
		return labels.length > 0 ? labels : undefined;
	})
	.optional()
	.catch(undefined);

interface AssistantSurfaceInput {
	description?: string;
	label: string;
	preamble?: string;
	prompts?: string[];
	thread?: string;
	tools?: string[];
}
const assistantSurfaceArgSchema = z
	.object({
		description: z
			.string()
			.min(1)
			.transform((value) => value.slice(0, MAX_CONTEXT_TEXT))
			.optional()
			.catch(undefined),
		label: z
			.string()
			.refine((value) => value.trim().length > 0)
			.transform((value) => value.slice(0, MAX_LABEL)),
		preamble: z
			.string()
			.min(1)
			.transform((value) => value.slice(0, MAX_PREAMBLE))
			.optional()
			.catch(undefined),
		prompts: assistantStringListSchema,
		thread: z
			.string()
			.refine((value) => value.trim().length > 0)
			.transform(clampIdentifier)
			.optional()
			.catch(undefined),
		tools: assistantStringListSchema,
	})
	.transform((input): AssistantSurfaceInput => {
		const output: AssistantSurfaceInput = { label: input.label };
		for (const key of ["description", "preamble", "thread"] as const) {
			if (input[key] !== undefined) {
				output[key] = input[key];
			}
		}
		for (const key of ["prompts", "tools"] as const) {
			if (input[key] !== undefined) {
				output[key] = input[key];
			}
		}
		return output;
	});
/** A labelled surface keeps ownership visible when an app opens the assistant. */
export const asAssistantSurfaceArg = nullableRpcParser(
	assistantSurfaceArgSchema
);

interface AssistantOpenInput {
	mode?: "floating" | "sidebar";
	prompt?: string;
}
const assistantOpenArgSchema = z
	.preprocess(
		(value) =>
			value == null
				? {}
				: Array.isArray(value)
					? Object.fromEntries(Object.entries(value))
					: value,
		z.object({
			mode: z.enum(["floating", "sidebar"]).optional().catch(undefined),
			prompt: z
				.string()
				.refine((value) => value.trim().length > 0)
				.transform((value) => value.slice(0, MAX_CONTEXT_TEXT))
				.optional()
				.catch(undefined),
		})
	)
	.transform((input): AssistantOpenInput => {
		const output: AssistantOpenInput = {};
		if (input.mode !== undefined) {
			output.mode = input.mode;
		}
		if (input.prompt !== undefined) {
			output.prompt = input.prompt;
		}
		return output;
	});
export const asAssistantOpenArg = nullableRpcParser(assistantOpenArgSchema);

interface ShellOpenTabInput {
	conversationId?: string;
	forceNew?: boolean;
	icon?: unknown;
	initialPrompt?: string;
	path: string;
	title?: string;
}
const shellOpenTabArgSchema = z
	.object({
		conversationId: z.string().optional().catch(undefined),
		forceNew: z.boolean().optional().catch(undefined),
		icon: z.unknown().optional(),
		initialPrompt: z.string().optional().catch(undefined),
		path: z.string().min(1),
		title: z.string().optional().catch(undefined),
	})
	.transform((input): ShellOpenTabInput => {
		const output: ShellOpenTabInput = { path: input.path };
		for (const key of ["conversationId", "initialPrompt", "title"] as const) {
			if (input[key] !== undefined) {
				output[key] = input[key];
			}
		}
		if (input.forceNew !== undefined) {
			output.forceNew = input.forceNew;
		}
		if (Object.hasOwn(input, "icon")) {
			output.icon = input.icon ?? null;
		}
		return output;
	});
/** The host service enforces routes after this parser validates tab options. */
export const asShellOpenTabArg = nullableRpcParser(shellOpenTabArgSchema);

const displayModeSchema = z.enum(["inline", "fullscreen", "pip"]);
const displayModeArgSchema = z.union([
	displayModeSchema,
	z.object({ mode: displayModeSchema }).transform((input) => input.mode),
]);
export const asDisplayModeArg = nullableRpcParser(displayModeArgSchema);

const openExternalArgSchema = z
	.union([
		z.string(),
		z
			.object({ href: z.unknown().optional(), url: z.unknown().optional() })
			.transform((input) => input.href ?? input.url),
	])
	.pipe(z.url({ protocol: /^https?$/ }))
	.transform((href) => ({ href: new URL(href).href }));
/** Only validated HTTP(S) links may reach the privileged external opener. */
export const asOpenExternalArg = nullableRpcParser(openExternalArgSchema);

/** Narrow to optional `{ accept?, multiple? }` for `ui.uploadFile`. */
type UploadFileInput = NonNullable<
	Parameters<NonNullable<HostServices["uploadFile"]>>[0]
>;
const uploadFileArgSchema = z
	.object({
		accept: z.string().trim().min(1).optional().catch(undefined),
		multiple: z.boolean().optional().catch(undefined),
	})
	.transform((value) => {
		const output: UploadFileInput = {};
		if (value.accept !== undefined) {
			output.accept = value.accept;
		}
		if (value.multiple !== undefined) {
			output.multiple = value.multiple;
		}
		return output;
	})
	.catch(() => ({}));
export const asUploadFileArg = uploadFileArgSchema.parse;

/** Narrow an arg to `model.complete` input: `prompt` required non-empty; optional
 *  string fields must be strings if present. Returns null on any bad shape. */
/** A canonical base64 payload, as Core and the Gateway decode it. */
const BASE64_BODY = "[A-Za-z0-9+/]+={0,2}";
/** Images one `model.complete` call may carry, and their combined size. Core's
 *  `host.sideModel` enforces the same bounds so the Gateway chat request stays
 *  under its body limit. */
export const MAX_MODEL_COMPLETE_IMAGES = 8;
export const MAX_MODEL_COMPLETE_IMAGE_CHARS = 1536 * 1024;
const visionImageUriSchema = z
	.string()
	.max(MAX_MODEL_COMPLETE_IMAGE_CHARS)
	.regex(
		new RegExp(`^data:image/(?:png|jpeg|webp);base64,${BASE64_BODY}$`, "u")
	);
const modelCompleteFieldsSchema = z.object({
	effort: z.string().optional(),
	// Inline raster images for a vision-capable model (OpenAI image_url parts).
	images: z
		.unknown()
		.refine(
			(value) =>
				Array.isArray(value) && value.length <= MAX_MODEL_COMPLETE_IMAGES
		)
		.pipe(
			z
				.array(visionImageUriSchema)
				.refine(
					(images) =>
						images.reduce((total, image) => total + image.length, 0) <=
						MAX_MODEL_COMPLETE_IMAGE_CHARS,
					{ message: "model.complete images exceed the 1.5 MiB total limit" }
				)
		)
		.optional(),
	model: z.string().optional(),
	model_pref_key: z.string().optional(),
	prompt: z.string().min(1),
	provider: z.string().optional(),
	system: z.string().optional(),
});
type ModelCompleteInput = z.infer<typeof modelCompleteFieldsSchema>;
const modelCompleteArgSchema = modelCompleteFieldsSchema.transform(
	(input): ModelCompleteInput => {
		const output: ModelCompleteInput = { prompt: input.prompt };
		for (const key of [
			"effort",
			"model",
			"model_pref_key",
			"provider",
			"system",
		] as const) {
			if (input[key] !== undefined) {
				output[key] = input[key];
			}
		}
		if (input.images !== undefined && input.images.length > 0) {
			output.images = input.images;
		}
		return output;
	}
);
export const asModelCompleteArg = nullableRpcParser(modelCompleteArgSchema);

/** Catalog discovery uses the canonical trimmed provider id. */
const catalogModelsArgSchema = z.object({
	providerId: z.string().trim().min(1),
});
export const asCatalogModelsArg = nullableRpcParser(catalogModelsArgSchema);

/** A provider/account id as Core's subscriptions bridge accepts it: 1..=256
 *  characters and not blank. Core re-validates; this rejects early. */
const subscriptionIdSchema = z
	.string()
	.refine(
		(value) => value.trim().length > 0 && [...value].length <= 256,
		"must be 1..=256 non-blank characters"
	);

/** Drop `undefined`-valued keys (a frame may send `{ accountId: undefined }`)
 *  so the args forwarded to Core stay plain JSON. */
function withoutUndefinedKeys<T extends Record<string, unknown>>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined)
	) as T;
}

/** `subscriptions.list` args. Strict: Core denies unknown fields, and `force`
 *  is owner-HTTP only, so it is never accepted here. */
const subscriptionsListArgSchema = z
	.strictObject({
		providerId: subscriptionIdSchema.optional(),
		usage: z.enum(["none", "cached", "refresh"]).optional(),
	})
	.transform(withoutUndefinedKeys);
export const asSubscriptionsListArg = nullableRpcParser(
	subscriptionsListArgSchema
);

/** `subscriptions.usage` args. Omitting `accountId` reads the active account. */
const subscriptionUsageArgSchema = z
	.strictObject({
		providerId: subscriptionIdSchema,
		accountId: subscriptionIdSchema.optional(),
	})
	.transform(withoutUndefinedKeys);
export const asSubscriptionUsageArg = nullableRpcParser(
	subscriptionUsageArgSchema
);

/** Keep oversized frame input off the conversation transport before ACL checks. */
const chatSendArgSchema = z.object({
	conversationId: z.string().max(200).trim().min(1),
	text: z
		.string()
		.max(8000)
		.refine((value) => value.trim().length > 0),
});
export const asChatSendArg = nullableRpcParser(chatSendArgSchema);

/** Agent budgets must be finite and non-negative before dispatch. */
const agentRunFieldsSchema = z.object({
	agent_id: z.string().optional(),
	max_tokens: z.number().nonnegative().optional(),
	preset: z.string().optional(),
	task: z.string().min(1),
	wall_time_secs: z.number().nonnegative().optional(),
});
type AgentRunInput = z.infer<typeof agentRunFieldsSchema>;
export const agentRunArgSchema = agentRunFieldsSchema.transform(
	(input): AgentRunInput => {
		const output: AgentRunInput = { task: input.task };
		for (const key of ["agent_id", "preset"] as const) {
			if (input[key] !== undefined) {
				output[key] = input[key];
			}
		}
		for (const key of ["max_tokens", "wall_time_secs"] as const) {
			if (input[key] !== undefined) {
				output[key] = input[key];
			}
		}
		return output;
	}
);
export const asAgentRunArg = nullableRpcParser(agentRunArgSchema);

const storageKeyFieldsSchema = z.object({
	key: z.string().min(1),
	namespace: z.string().optional(),
});
const storageKeyArgSchema = storageKeyFieldsSchema.transform((input) =>
	input.namespace === undefined
		? { key: input.key }
		: { key: input.key, namespace: input.namespace }
);
export const asStorageKeyArg = nullableRpcParser(storageKeyArgSchema);

/** Storage values are strings because Core reads them with as_str. */
const storageSetArgSchema = storageKeyFieldsSchema
	.extend({ value: z.string() })
	.transform((input) =>
		input.namespace === undefined
			? { key: input.key, value: input.value }
			: { key: input.key, namespace: input.namespace, value: input.value }
	);
export const asStorageSetArg = nullableRpcParser(storageSetArgSchema);

const storageKeysArgSchema = z
	.object({ namespace: z.string().optional().catch(undefined) })
	.transform((input) =>
		input.namespace === undefined ? {} : { namespace: input.namespace }
	)
	.catch(() => ({}));
export const asStorageKeysArg = storageKeysArgSchema.parse;

const storageCompareAndSetFieldsSchema = storageKeyFieldsSchema.extend({
	expected: z.string().nullable().optional(),
	value: z.string().nullable().optional(),
});
type StorageCompareAndSetInput = z.infer<
	typeof storageCompareAndSetFieldsSchema
>;
const storageCompareAndSetArgSchema =
	storageCompareAndSetFieldsSchema.transform(
		(input): StorageCompareAndSetInput => {
			const output: StorageCompareAndSetInput = { key: input.key };
			if (input.namespace !== undefined) {
				output.namespace = input.namespace;
			}
			for (const key of ["expected", "value"] as const) {
				if (input[key] !== undefined) {
					output[key] = input[key];
				}
			}
			return output;
		}
	);
export const asStorageCompareAndSetArg = nullableRpcParser(
	storageCompareAndSetArgSchema
);

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

/** Custody metadata contains no plaintext or key material. */
export const cryptoStatusSchema = z.looseObject({
	key_beside_data: z.boolean(),
	key_file: z.string().nullable().optional(),
	keychain_account: z.string().nullable().optional(),
	keychain_service: z.string().nullable().optional(),
	source: z.string(),
}) satisfies z.ZodType<CryptoStatus>;

/** Sealing takes plaintext; opening takes the serialized sealed value. */
const cryptoValueArgSchema = z.object({ value: z.string() });
export const asCryptoValueArg = nullableRpcParser(cryptoValueArgSchema);

const spacesCreateArgSchema = z.object({
	space_id: z.string().min(1),
	title: z.string(),
});
export const asSpacesCreateArg = nullableRpcParser(spacesCreateArgSchema);

const spacesEnsureArgSchema = z
	.object({
		name: z.string().trim().min(1),
		description: z.string().nullable().optional(),
	})
	.transform((input) =>
		input.description === undefined
			? { name: input.name }
			: { name: input.name, description: input.description }
	);
export const asSpacesEnsureArg = nullableRpcParser(spacesEnsureArgSchema);

const spacesSearchArgSchema = z
	.object({
		limit: z
			.number()
			.min(1)
			.transform((value) => Math.min(50, Math.floor(value)))
			.optional(),
		query: z.string().trim().min(1),
		space_id: z.string().trim().min(1),
	})
	.transform((input) =>
		input.limit === undefined
			? { query: input.query, space_id: input.space_id }
			: { limit: input.limit, query: input.query, space_id: input.space_id }
	);
export const asSpacesSearchArg = nullableRpcParser(spacesSearchArgSchema);

const spacesDocIdArgSchema = z.object({ doc_id: z.string().min(1) });
export const asSpacesDocIdArg = nullableRpcParser(spacesDocIdArgSchema);

const spacesUpdateArgSchema = z
	.object({
		doc_id: z.string().min(1),
		source: z.string(),
		title: z.string().optional(),
	})
	.transform((input) =>
		input.title === undefined
			? { doc_id: input.doc_id, source: input.source }
			: { doc_id: input.doc_id, source: input.source, title: input.title }
	);
export const asSpacesUpdateArg = nullableRpcParser(spacesUpdateArgSchema);

const spacesListArgSchema = z.object({ space_id: z.string().min(1) });
export const asSpacesListArg = nullableRpcParser(spacesListArgSchema);

const spacesDatabaseArgSchema = z.object({
	database_id: z.string().max(100).trim().min(1),
	space_id: z.string().max(100).trim().min(1),
});
export const asSpacesDatabaseArg = nullableRpcParser(spacesDatabaseArgSchema);

const spacesUpdateDatabaseFieldsSchema = spacesDatabaseArgSchema.extend({
	expected_revision: z.number().int().nonnegative(),
	source: z.string().max(1_500_000),
	title: z.string().max(100).trim().min(1).optional(),
});
type SpacesUpdateDatabaseInput = z.infer<
	typeof spacesUpdateDatabaseFieldsSchema
>;
const spacesUpdateDatabaseArgSchema =
	spacesUpdateDatabaseFieldsSchema.transform(
		(input): SpacesUpdateDatabaseInput => {
			const output: SpacesUpdateDatabaseInput = {
				database_id: input.database_id,
				expected_revision: input.expected_revision,
				source: input.source,
				space_id: input.space_id,
			};
			if (input.title !== undefined) {
				output.title = input.title;
			}
			return output;
		}
	);
export const asSpacesUpdateDatabaseArg = nullableRpcParser(
	spacesUpdateDatabaseArgSchema
);

/** Match the native database's JSON limits, including depth before descending. */
function boundedRyuJsonSchema(depth = 0): z.ZodType<RyuJsonValue> {
	const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
	if (depth >= 16) {
		return scalar;
	}
	const child = boundedRyuJsonSchema(depth + 1);
	return z.union([
		scalar,
		z
			.unknown()
			.refine((value) => Array.isArray(value) && value.length <= 10_000)
			.pipe(z.array(child)),
		z.record(z.string(), child),
	]);
}
const spacesQueryDatabaseFieldsSchema = spacesDatabaseArgSchema.extend({
	parameters: z
		.unknown()
		.refine((value) => Array.isArray(value) && value.length <= 64)
		.pipe(z.array(boundedRyuJsonSchema()))
		.optional(),
	query: z.string().max(8000).trim().min(1),
});
type SpacesQueryDatabaseInput = z.infer<typeof spacesQueryDatabaseFieldsSchema>;
const spacesQueryDatabaseArgSchema = spacesQueryDatabaseFieldsSchema.transform(
	(input): SpacesQueryDatabaseInput => {
		const output: SpacesQueryDatabaseInput = {
			database_id: input.database_id,
			query: input.query,
			space_id: input.space_id,
		};
		if (input.parameters !== undefined) {
			output.parameters = input.parameters;
		}
		return output;
	}
);
export const asSpacesQueryDatabaseArg = nullableRpcParser(
	spacesQueryDatabaseArgSchema
);

/** Combined size of one video or audio job's inline inputs (frames, clip,
 *  audio track and `provider_input`), counted in characters of their wire JSON.
 *  Core's and the Gateway's video/audio job routes take 64 MiB bodies; 40 MiB
 *  leaves room for base64 padding and the rest of the request, so a valid
 *  bridge call is never refused upstream for size alone. */
export const MAX_MEDIA_INPUT_CHARS = 40 * 1024 * 1024;
/** The same budget for `media.image`. Core's and the Gateway's image
 *  generation routes take 24 MiB bodies, so image requests get their own,
 *  smaller budget; 22 MiB leaves envelope headroom under that limit. */
export const MAX_MEDIA_IMAGE_INPUT_CHARS = 22 * 1024 * 1024;
/** Reference frames a video job takes: the first and, optionally, the last. */
export const MAX_MEDIA_VIDEO_FRAMES = 2;
/** `provider_input` keys an app may never set. They choose the route, carry the
 *  prompt, correlate the request, or are the canonical inputs themselves, so a
 *  model-specific mapping can never re-route a job or smuggle a second prompt.
 *  Mirrors Core's `RESERVED_PROVIDER_INPUT_KEYS`, plus the image-edit mask. */
export const RESERVED_PROVIDER_INPUT_KEYS: ReadonlySet<string> = new Set([
	"model",
	"provider",
	"prompt",
	"request_id",
	"n",
	"project_id",
	"input_images",
	"input_video",
	"input_audio",
	"input_mask",
	"provider_input",
	"duration_s",
	"kind",
]);
/** Inline media URI of one family. Only `data:` URIs: the sandboxed frame has no
 *  network, and the host must never fetch a plugin-chosen URL for it. */
function inlineMediaUriSchema(family: RegExp, label: string) {
	return z
		.string()
		.max(MAX_MEDIA_INPUT_CHARS)
		.refine((value) => family.test(value), {
			message: `must be a base64 data:${label} URI`,
		});
}
const videoFrameUriSchema = inlineMediaUriSchema(
	new RegExp(`^data:image/(?:png|jpeg|jpg|webp);base64,${BASE64_BODY}$`, "u"),
	"image/{png,jpeg,webp}"
);
const videoClipUriSchema = inlineMediaUriSchema(
	new RegExp(
		`^data:video/[a-z0-9][a-z0-9.+-]{0,63};base64,${BASE64_BODY}$`,
		"u"
	),
	"video/*"
);
const audioTrackUriSchema = inlineMediaUriSchema(
	new RegExp(
		`^data:audio/[a-z0-9][a-z0-9.+-]{0,63};base64,${BASE64_BODY}$`,
		"u"
	),
	"audio/*"
);
/** Keys a record parse would silently drop or treat specially. They are
 *  refused so the bridge never forwards a different object than the app sent. */
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);
/** A model-specific JSON object merged into the cloud provider body by Core.
 *  Values may reference canonical inputs (`"$input_video"`), which Core
 *  resolves; routing and canonical keys are refused here, before transport. */
const providerInputSchema = z
	.unknown()
	.refine(
		(value) =>
			typeof value !== "object" ||
			value === null ||
			!Object.keys(value).some((key) => PROTOTYPE_KEYS.has(key)),
		{ message: "provider_input cannot use prototype keys" }
	)
	.pipe(z.record(z.string().min(1).max(128), boundedRyuJsonSchema()))
	.refine((value) => Object.keys(value).length <= 64, {
		message: "provider_input takes at most 64 fields",
	})
	.refine(
		(value) =>
			!Object.keys(value).some((key) => RESERVED_PROVIDER_INPUT_KEYS.has(key)),
		{
			message:
				"provider_input cannot set routing, prompt or canonical input fields",
		}
	);
/** Seconds of generated media; Core accepts (0, 600]. */
const mediaDurationSchema = z.number().finite().positive().max(600);

/** Characters of a request's inline inputs, as they will appear on the wire. */
function mediaInputChars(input: {
	input_audio?: string;
	input_images?: readonly string[];
	input_video?: string;
	provider_input?: Record<string, RyuJsonValue>;
}): number {
	let total = input.input_video?.length ?? 0;
	total += input.input_audio?.length ?? 0;
	for (const image of input.input_images ?? []) {
		total += image.length;
	}
	if (input.provider_input !== undefined) {
		total += JSON.stringify(input.provider_input).length;
	}
	return total;
}
const withinMediaInputBudget = {
	check: (input: Parameters<typeof mediaInputChars>[0]) =>
		mediaInputChars(input) <= MAX_MEDIA_INPUT_CHARS,
	message: "media inputs exceed the 40 MiB total limit",
};
const withinMediaImageInputBudget = {
	check: (input: Parameters<typeof mediaInputChars>[0]) =>
		mediaInputChars(input) <= MAX_MEDIA_IMAGE_INPUT_CHARS,
	message: "image inputs exceed the 22 MiB total limit",
};

const mediaImageFieldsSchema = z
	.object({
		model: z.string().optional(),
		provider: z.string().optional(),
		request_id: z.string().optional(),
		prompt: z.string().min(1),
		count: z.number().nonnegative().optional(),
		size: z.string().optional(),
		input_images: z
			.unknown()
			.refine((value) => Array.isArray(value) && value.length <= 16)
			.pipe(
				z.array(
					z
						.string()
						.min(1)
						.max(16 * 1024 * 1024)
				)
			)
			.optional(),
		provider_input: providerInputSchema.optional(),
	})
	.refine(withinMediaImageInputBudget.check, {
		message: withinMediaImageInputBudget.message,
	});
type MediaImageInput = z.infer<typeof mediaImageFieldsSchema>;
const mediaImageArgSchema = mediaImageFieldsSchema.transform(
	(input): MediaImageInput => {
		const output: MediaImageInput = { prompt: input.prompt };
		for (const key of ["model", "provider", "request_id", "size"] as const) {
			if (input[key] !== undefined) {
				output[key] = input[key];
			}
		}
		if (input.count !== undefined) {
			output.count = input.count;
		}
		if (input.input_images !== undefined) {
			output.input_images = input.input_images;
		}
		if (input.provider_input !== undefined) {
			output.provider_input = input.provider_input;
		}
		return output;
	}
);
export const asMediaImageArg = nullableRpcParser(mediaImageArgSchema);

const mediaVideoFieldsSchema = z
	.object({
		model: z.string().optional(),
		provider: z.string().optional(),
		request_id: z.string().optional(),
		prompt: z.string().min(1),
		// `[first, last?]` reference frames (image-to-video, first/last-frame).
		input_images: z
			.unknown()
			.refine(
				(value) =>
					Array.isArray(value) && value.length <= MAX_MEDIA_VIDEO_FRAMES
			)
			.pipe(z.array(videoFrameUriSchema))
			.optional(),
		// A source clip (video-to-video, lip-sync, matting).
		input_video: videoClipUriSchema.optional(),
		// An audio track (lip-sync, talking avatars).
		input_audio: audioTrackUriSchema.optional(),
		duration_s: mediaDurationSchema.optional(),
		provider_input: providerInputSchema.optional(),
	})
	.refine(withinMediaInputBudget.check, {
		message: withinMediaInputBudget.message,
	});
type MediaVideoInput = z.infer<typeof mediaVideoFieldsSchema>;
const mediaVideoArgSchema = mediaVideoFieldsSchema.transform(
	(input): MediaVideoInput => {
		const output: MediaVideoInput = { prompt: input.prompt };
		for (const key of [
			"model",
			"provider",
			"request_id",
			"input_video",
			"input_audio",
		] as const) {
			if (input[key] !== undefined) {
				output[key] = input[key];
			}
		}
		if (input.input_images !== undefined && input.input_images.length > 0) {
			output.input_images = input.input_images;
		}
		if (input.duration_s !== undefined) {
			output.duration_s = input.duration_s;
		}
		if (input.provider_input !== undefined) {
			output.provider_input = input.provider_input;
		}
		return output;
	}
);
export const asMediaVideoArg = nullableRpcParser(mediaVideoArgSchema);

/** Music or sound-effect generation. Core has no local audio engine, so a
 *  cloud `provider` and its `model` are required rather than defaulted. */
const mediaAudioFieldsSchema = z
	.object({
		prompt: z.string().trim().min(1).max(8000),
		kind: z.enum(["music", "sfx"]),
		duration_s: mediaDurationSchema.optional(),
		provider: z.string().trim().min(1).max(64),
		model: z.string().trim().min(1).max(256),
		provider_input: providerInputSchema.optional(),
		request_id: z.string().max(256).optional(),
	})
	.refine(withinMediaInputBudget.check, {
		message: withinMediaInputBudget.message,
	});
export type MediaAudioInput = z.infer<typeof mediaAudioFieldsSchema>;
const mediaAudioArgSchema = mediaAudioFieldsSchema.transform(
	(input): MediaAudioInput => {
		const output: MediaAudioInput = {
			kind: input.kind,
			model: input.model,
			prompt: input.prompt,
			provider: input.provider,
		};
		if (input.duration_s !== undefined) {
			output.duration_s = input.duration_s;
		}
		if (input.provider_input !== undefined) {
			output.provider_input = input.provider_input;
		}
		if (input.request_id !== undefined) {
			output.request_id = input.request_id;
		}
		return output;
	}
);
export const asMediaAudioArg = nullableRpcParser(mediaAudioArgSchema);

// One post-synthesis effect. `params` keys are short snake_case knobs whose
// meaning the voice sidecar owns; Core re-checks the same bounds.
const mediaTtsEffectSchema = z
	.object({
		type: z.enum(SPEAK_EFFECT_TYPES),
		params: z
			.record(z.string().regex(/^[a-z0-9_]{1,40}$/u), z.number().finite())
			.refine((params) => Object.keys(params).length <= 16)
			.optional(),
	})
	.strict();
const mediaTtsFieldsSchema = z.object({
	engine: z.string().optional(),
	language: z.string().optional(),
	request_id: z.string().optional(),
	voice: z.string().optional(),
	text: z.string().min(1).max(SPEAK_TEXT_MAX_CHARS),
	speed: z.number().nonnegative().optional(),
	reference_audio_data_url: z
		.string()
		.max(700_000)
		.regex(/^data:audio\/wav;base64,[A-Za-z0-9+/]+={0,2}$/u)
		.optional(),
	seed: z.number().int().min(0).max(SPEAK_SEED_MAX).optional(),
	instruct: z.string().max(SPEAK_INSTRUCT_MAX_CHARS).optional(),
	reference_text: z.string().max(SPEAK_REFERENCE_TEXT_MAX_CHARS).optional(),
	effects: z.array(mediaTtsEffectSchema).max(SPEAK_MAX_EFFECTS).optional(),
	normalize: z.enum(SPEAK_NORMALIZE_MODES).optional(),
	format: z.enum(SPEAK_FORMATS).optional(),
});
type MediaTtsInput = z.infer<typeof mediaTtsFieldsSchema>;
const mediaTtsArgSchema = mediaTtsFieldsSchema.transform(
	(input): MediaTtsInput => {
		const output: MediaTtsInput = { text: input.text };
		for (const key of [
			"engine",
			"language",
			"request_id",
			"voice",
			"reference_audio_data_url",
			"instruct",
			"reference_text",
		] as const) {
			if (input[key] !== undefined) {
				output[key] = input[key];
			}
		}
		if (input.speed !== undefined) {
			output.speed = input.speed;
		}
		if (input.normalize !== undefined) {
			output.normalize = input.normalize;
		}
		if (input.format !== undefined) {
			output.format = input.format;
		}
		if (input.seed !== undefined) {
			output.seed = input.seed;
		}
		if (input.effects !== undefined) {
			// Rebuild each effect so only the declared keys cross the bridge.
			output.effects = input.effects.map((effect) =>
				effect.params === undefined
					? { type: effect.type }
					: { type: effect.type, params: { ...effect.params } }
			);
		}
		return output;
	}
);
export const asMediaTtsArg = nullableRpcParser(mediaTtsArgSchema);

const mediaTtsEngineInstallArgSchema = z.object({
	engine: z.string().regex(/^[a-z0-9_-]{1,80}$/u),
});
export const asMediaTtsEngineInstallArg = nullableRpcParser(
	mediaTtsEngineInstallArgSchema
);

const mediaTranscribeFieldsSchema = z.object({
	audio: z.string().min(1),
	detailed: z.boolean().optional(),
	filename: z.string().optional(),
	// `auto` or a BCP-47 tag; anything else is dropped rather than forwarded.
	language: z
		.string()
		.trim()
		.max(35)
		.regex(/^(?:auto|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/)
		.optional()
		.catch(undefined),
});
type MediaTranscribeInput = z.infer<typeof mediaTranscribeFieldsSchema>;
const mediaTranscribeArgSchema = mediaTranscribeFieldsSchema.transform(
	(input): MediaTranscribeInput => {
		const output: MediaTranscribeInput = { audio: input.audio };
		if (input.detailed !== undefined) {
			output.detailed = input.detailed;
		}
		if (input.filename !== undefined) {
			output.filename = input.filename;
		}
		if (input.language !== undefined) {
			output.language = input.language;
		}
		return output;
	}
);
export const asMediaTranscribeArg = nullableRpcParser(mediaTranscribeArgSchema);

const assetQueryArgSchema = z.object({ query: z.string() });
export const asAssetQueryArg = nullableRpcParser(assetQueryArgSchema);

const imageSearchArgSchema = z.object({
	provider: z.enum(["openverse", "unsplash"]),
	query: z.string(),
});
export const asImageSearchArg = nullableRpcParser(imageSearchArgSchema);

/** Narrow an arg to `{ id: string }` (finetune.get / cancel / stream). */
const finetuneIdArgSchema = z.object({ id: z.string().min(1) });
export const asFinetuneIdArg = nullableRpcParser(finetuneIdArgSchema);

/** Decode an extensible workflow definition without enforcing Core's DAG rules.
 * Preserve the original JSON object so future node options reach Core unchanged. */
export function asRecordArg(
	data: Parameters<typeof workflowDefinitionInputSchema.safeParse>[0]
): WorkflowDefinitionInput | null {
	const parsed = workflowDefinitionInputSchema.safeParse(data);
	return parsed.success ? parsed.data : null;
}

/** Narrow an arg to `{ id: string }` (monitors get/delete/run). */
const monitorIdArgSchema = z.object({ id: z.string().min(1) });
export const asMonitorIdArg = nullableRpcParser(monitorIdArgSchema);

// Preserve the monitor vocabulary's existing numeric passthrough; Core owns
// the final check-specific policy for optional status/threshold fields.
const monitorPassthroughNumberSchema = z.union([
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
const monitorCheckSchema = z.discriminatedUnion("type", [
	z.looseObject({
		type: z.literal("uptime"),
		expect_status: z.array(monitorPassthroughNumberSchema).optional(),
	}),
	z.looseObject({
		type: z.literal("keyword"),
		pattern: z.string(),
		is_regex: z.boolean().optional(),
		case_sensitive: z.boolean().optional(),
		alert_when_present: z.boolean().optional(),
	}),
	z.looseObject({
		type: z.literal("content_diff"),
		region_regex: z.string().nullable().optional(),
	}),
	z.looseObject({
		type: z.literal("price"),
		extract_regex: z.string(),
		comparator: z
			.enum([
				"changed",
				"less_than",
				"greater_than",
				"drops_by_pct",
				"rises_by_pct",
			])
			.optional(),
		threshold: monitorPassthroughNumberSchema.nullable().optional(),
	}),
	z.looseObject({
		type: z.literal("stock"),
		in_stock_pattern: z.string(),
		is_regex: z.boolean().optional(),
		alert_when_in_stock: z.boolean().optional(),
	}),
	z.looseObject({
		type: z.literal("provider_usage_reset"),
		provider_id: z.string(),
		// Absent/null follows the provider's active account.
		account_id: z.string().min(1).max(256).nullish(),
		target_ids: z.array(z.string()),
		minimum_drop_percent: z.number(),
	}),
]) satisfies z.ZodType<MonitorCheckType>;
const monitorNotifySchema = z.discriminatedUnion("kind", [
	z.looseObject({ kind: z.literal("webhook"), url: z.string() }),
	z.looseObject({
		kind: z.literal("telegram"),
		bot_token: z.string(),
		chat_id: z.string(),
	}),
	z.looseObject({ kind: z.literal("expo_push"), token: z.string() }),
	z.looseObject({ kind: z.literal("email"), to: z.string() }),
]) satisfies z.ZodType<MonitorNotifyTarget>;
const monitorInputSchema = z.looseObject({
	backend: z.enum(["http", "spider", "agentbrowser"]),
	check: monitorCheckSchema,
	enabled: z.boolean(),
	interval: z.string(),
	name: z.string(),
	notify: z.array(monitorNotifySchema),
	url: z.string(),
}) satisfies z.ZodType<MonitorInputPayload>;
function isMonitorInput<T>(value: T): value is T & MonitorInputPayload {
	return monitorInputSchema.safeParse(value).success;
}
// Keep unknown server-owned fields and object identity when forwarding a
// validated monitor, rather than projecting the payload to today's UI model.
const monitorInputBoundarySchema =
	z.custom<MonitorInputPayload>(isMonitorInput);
export const asMonitorInputArg = nullableRpcParser(monitorInputBoundarySchema);
const monitorUpdateArgSchema = z.object({
	id: z.string().min(1),
	input: monitorInputBoundarySchema,
});
export const asMonitorUpdateArg = nullableRpcParser(monitorUpdateArgSchema);

/** Narrow an arg to `{ id: string, limit?: number }` (monitors snapshots/alerts).
 *  `limit`, when present, must be a finite non-negative number. */
const monitorListLimitArgSchema = z
	.object({ id: z.string().min(1), limit: z.number().nonnegative().optional() })
	.transform((input) =>
		input.limit === undefined
			? { id: input.id }
			: { id: input.id, limit: input.limit }
	);
export const asMonitorListLimitArg = nullableRpcParser(
	monitorListLimitArgSchema
);

/** Narrow an arg to `{ id: string }` (quests complete/dismiss/delete/judge +
 *  suggestion accept/dismiss). */
const questIdArgSchema = z.object({ id: z.string().min(1) });
export const asQuestIdArg = nullableRpcParser(questIdArgSchema);

/** Narrow an explicit-recipient Inbox notification payload. Core applies the
 *  authoritative length and membership bounds after the host gate. */
/** Optional notification archive filter; invalid filters never reach Core. */
const notificationListInputSchema = z
	.object({ archived: z.boolean().optional() })
	.optional();
export const asNotificationListArg = nullableRpcParser(
	notificationListInputSchema
);

const notificationSendArgSchema = z
	.object({
		target_user_id: z.string().min(1),
		title: z.string().min(1),
		body: z.string().optional(),
	})
	.transform(({ target_user_id, title, body }) =>
		body === undefined
			? { target_user_id, title }
			: { target_user_id, title, body }
	);
export const asNotificationSendArg = nullableRpcParser(
	notificationSendArgSchema
);

/** Optional task state remains absent unless the incoming field is a real boolean. */
const optionalCompleteSchema = z
	.object({ complete: z.boolean().optional().catch(undefined) })
	.catch(() => ({}))
	.transform(({ complete }) => complete);
const optionalPinnedSchema = z
	.object({ pinned: z.boolean().optional().catch(undefined) })
	.catch(() => ({}))
	.transform(({ pinned }) => pinned);
const asOptionalComplete = optionalCompleteSchema.parse;
const asOptionalPinned = optionalPinnedSchema.parse;

/** Narrow an optional `{ kind?: string }` for `quests.list`. A missing or blank
 *  kind means "every kind", which is what the board asks for. */
const questListArgSchema = z
	.object({
		kind: z
			.string()
			.refine((kind) => kind.trim().length > 0)
			.optional()
			.catch(undefined),
	})
	.transform(({ kind }) => (kind === undefined ? {} : { kind }))
	.catch(() => ({}));
export const asQuestListArg = questListArgSchema.parse;

/** Narrow a `quests.capture` arg. Only `body` is required; `kind`/`title` are
 *  inferred server-side when absent, and a source with no usable field is dropped
 *  rather than forwarded as an empty object. */
const questCaptureSourceFieldsSchema = z.object({
	app: z.string().min(1).optional().catch(undefined),
	title: z.string().min(1).optional().catch(undefined),
	url: z.string().min(1).optional().catch(undefined),
});
const questCaptureSourceSchema = questCaptureSourceFieldsSchema
	.transform((value) => {
		const source: z.output<typeof questCaptureSourceFieldsSchema> = {};
		for (const key of ["app", "title", "url"] as const) {
			if (value[key] !== undefined) {
				source[key] = value[key];
			}
		}
		return Object.keys(source).length > 0 ? source : undefined;
	})
	.optional()
	.catch(undefined);
const questCaptureFieldsSchema = z.object({
	body: z.string().refine((body) => body.trim().length > 0),
	kind: z.string().min(1).optional().catch(undefined),
	title: z.string().min(1).optional().catch(undefined),
	source: questCaptureSourceSchema,
});
const questCaptureArgSchema = questCaptureFieldsSchema.transform((value) => {
	const output: z.output<typeof questCaptureFieldsSchema> = {
		body: value.body,
	};
	if (value.kind !== undefined) {
		output.kind = value.kind;
	}
	if (value.title !== undefined) {
		output.title = value.title;
	}
	if (value.source !== undefined) {
		output.source = value.source;
	}
	return output;
});
export const asQuestCaptureArg = nullableRpcParser(questCaptureArgSchema);

/** Narrow a `quests.setScratchpad` arg to its text. An empty string is VALID
 *  (that is how the buffer is cleared), so this returns `null` only when the
 *  argument is not a `{ text: string }` at all. */
const questScratchpadArgSchema = z
	.object({ text: z.string() })
	.transform(({ text }) => text);
export const asQuestScratchpadArg = nullableRpcParser(questScratchpadArgSchema);

/** Narrow an optional `{ limit?: number }` for `activity.list`. Missing/invalid
 *  limit is dropped (Core applies its own default cap), so this always returns a
 *  well-formed object — the read has no required argument. */
const activityListArgSchema = z
	.object({ limit: z.number().optional().catch(undefined) })
	.transform(({ limit }) => (limit === undefined ? {} : { limit }))
	.catch(() => ({}));
export const asActivityListArg = activityListArgSchema.parse;

/** Narrow the read-only Gateway audit filters used by `activity.audit`. */
const activityAuditFieldsSchema = z.object({
	agent_id: z.string().trim().min(1).optional().catch(undefined),
	event_type: z.string().trim().min(1).optional().catch(undefined),
	model: z.string().trim().min(1).optional().catch(undefined),
	provider: z.string().trim().min(1).optional().catch(undefined),
	widget_instance_id: z.string().trim().min(1).optional().catch(undefined),
	from: z.string().max(64).optional().catch(undefined),
	until: z.string().max(64).optional().catch(undefined),
	errors_only: z.boolean().optional().catch(undefined),
	limit: z
		.number()
		.refine(Number.isInteger)
		.positive()
		.transform((limit) => Math.min(limit, 1000))
		.optional()
		.catch(undefined),
});
const activityAuditArgSchema = activityAuditFieldsSchema
	.transform((value): ActivityAuditInput => {
		const result: ActivityAuditInput = {};
		for (const key of [
			"agent_id",
			"event_type",
			"model",
			"provider",
			"widget_instance_id",
			"from",
			"until",
		] as const) {
			if (value[key] !== undefined) {
				result[key] = value[key];
			}
		}
		if (value.errors_only !== undefined) {
			result.errors_only = value.errors_only;
		}
		if (value.limit !== undefined) {
			result.limit = value.limit;
		}
		return result;
	})
	.catch(() => ({}));
export const asActivityAuditArg = activityAuditArgSchema.parse;

/** Bound expanded work before validation or serialization of frame-owned JSON. */
const activityCompletedResponseSchema = z
	.unknown()
	.refine(isBoundedActivityJson)
	.pipe(preserveHostResponse(databaseResponseJsonSchema));
const activityOptionalJsonSchema = z.unknown().refine(isBoundedActivityJson);
const activityScoreTextSchema = z
	.string()
	.max(4096)
	.trim()
	.min(1)
	.optional()
	.catch(undefined);
const activityScoreEvaluatorsSchema = z
	.array(z.unknown())
	.max(100)
	.transform((values) =>
		values.flatMap((value) => {
			const evaluator = z.string().max(256).safeParse(value);
			return evaluator.success ? [evaluator.data] : [];
		})
	)
	.optional()
	.catch(undefined);
const activityScoreFieldsSchema = z.object({
	response: activityCompletedResponseSchema,
	agent_id: activityScoreTextSchema,
	description: activityScoreTextSchema,
	expected: activityScoreTextSchema,
	id: activityScoreTextSchema,
	model: activityScoreTextSchema,
	prompt: activityScoreTextSchema,
	cost_micro_usd: z.number().nonnegative().optional().catch(undefined),
	latency_ms: z.number().nonnegative().optional().catch(undefined),
	threshold: z.number().min(0).max(1).optional().catch(undefined),
	assertions: activityOptionalJsonSchema
		.pipe(preserveHostResponse(z.array(databaseResponseJsonSchema).max(100)))
		.optional()
		.catch(undefined),
	evaluators: activityScoreEvaluatorsSchema,
	metadata: activityOptionalJsonSchema
		.pipe(preserveHostResponse(jsonResponseDocumentSchema))
		.optional()
		.catch(undefined),
	vars: activityOptionalJsonSchema
		.pipe(preserveHostResponse(jsonResponseDocumentSchema))
		.optional()
		.catch(undefined),
	context: activityOptionalJsonSchema
		.pipe(
			preserveHostResponse(
				z.union([
					jsonResponseDocumentSchema,
					z.array(databaseResponseJsonSchema),
				])
			)
		)
		.optional()
		.catch(undefined),
});
/** Keep JSON projections intact while omitting malformed optional selectors and limits. */
export const activityScoreInputSchema = activityScoreFieldsSchema.transform(
	(input) => {
		const output: z.output<typeof activityScoreFieldsSchema> = {
			response: input.response,
		};
		for (const key of [
			"agent_id",
			"description",
			"expected",
			"id",
			"model",
			"prompt",
		] as const) {
			if (input[key] !== undefined) {
				output[key] = input[key];
			}
		}
		for (const key of ["cost_micro_usd", "latency_ms", "threshold"] as const) {
			if (input[key] !== undefined) {
				output[key] = input[key];
			}
		}
		if (input.assertions !== undefined) {
			output.assertions = input.assertions;
		}
		if (input.evaluators !== undefined) {
			output.evaluators = input.evaluators;
		}
		if (input.metadata !== undefined) {
			output.metadata = input.metadata;
		}
		if (input.vars !== undefined) {
			output.vars = input.vars;
		}
		if (input.context !== undefined) {
			output.context = input.context;
		}
		return output;
	}
);
export const asActivityScoreArg = nullableRpcParser(activityScoreInputSchema);

/** Narrow a run id for both trace inspection and trace-to-test import. */
const activityTraceArgSchema = z.object({ run_id: z.string().trim().min(1) });
export const asActivityTraceArg = nullableRpcParser(activityTraceArgSchema);

/** Narrow the trace-import target and optional agent/suite selectors. */
type ActivityImportTraceInput = NonNullable<
	Parameters<NonNullable<HostServices["activityImportTrace"]>>[0]
>;
const activityImportTraceArgSchema = activityTraceArgSchema
	.extend({
		agent_id: z.string().trim().min(1).optional().catch(undefined),
		suite_id: z.string().trim().min(1).optional().catch(undefined),
	})
	.transform((value) => {
		const result: ActivityImportTraceInput = {
			run_id: value.run_id,
		};
		if (value.agent_id !== undefined) {
			result.agent_id = value.agent_id;
		}
		if (value.suite_id !== undefined) {
			result.suite_id = value.suite_id;
		}
		return result;
	});
export const asActivityImportTraceArg = nullableRpcParser(
	activityImportTraceArgSchema
);

/** Narrow the provider-backed security sweep input. */
const activityRedteamArgSchema = z
	.object({
		agent_id: z.string().trim().min(1),
		model: z
			.string()
			.trim()
			.min(1)
			.transform((model) => model.slice(0, 256))
			.optional()
			.catch(undefined),
	})
	.transform(({ agent_id, model }) =>
		model === undefined ? { agent_id } : { agent_id, model }
	);
export const asActivityRedteamArg = nullableRpcParser(activityRedteamArgSchema);

/** Narrow an optional background-process list arg. Core applies the running-only
 * default; invalid optional fields are dropped rather than widening the read. */
type BackgroundListInput = NonNullable<
	Parameters<NonNullable<HostServices["backgroundList"]>>[0]
>;
const backgroundListArgSchema = z
	.object({
		producer: z.string().trim().min(1).optional().catch(undefined),
		running_only: z.boolean().optional().catch(undefined),
	})
	.transform((value) => {
		const result: BackgroundListInput = {};
		if (value.producer !== undefined) {
			result.producer = value.producer;
		}
		if (value.running_only !== undefined) {
			result.running_only = value.running_only;
		}
		return result;
	})
	.catch(() => ({}));
export const asBackgroundListArg = backgroundListArgSchema.parse;

/** Narrow a background stop arg so an empty id never reaches the Core queue. */
const backgroundStopArgSchema = z.object({
	process_id: z.string().trim().min(1),
});
export const asBackgroundStopArg = nullableRpcParser(backgroundStopArgSchema);

/** Narrow an RPC argument to a `{ session_id: string }` for `activity.openSession`.
 *  Returns null for any other shape so a malformed nav call never opens a tab. */
const activitySessionArgSchema = z.object({ session_id: z.string().min(1) });
export const asActivitySessionArg = nullableRpcParser(activitySessionArgSchema);

/** Narrow an RPC argument to a `{ rangeMinutes: number }` for `timeline.list`.
 *  Returns null for any other shape so a malformed read never reaches Shadow. */
const timelineRangeArgSchema = z.object({ rangeMinutes: z.number() });
export const asTimelineRangeArg = nullableRpcParser(timelineRangeArgSchema);

/** Narrow an RPC argument to `{ rangeMinutes: number, narrate?: boolean }` for
 *  `timeline.journal`. A present non-boolean `narrate` is dropped (defaults off);
 *  a missing/invalid `rangeMinutes` rejects (null). */
const timelineJournalArgSchema = z
	.object({
		rangeMinutes: z.number(),
		narrate: z.boolean().optional().catch(undefined),
	})
	.transform((input) =>
		input.narrate === undefined
			? { rangeMinutes: input.rangeMinutes }
			: { rangeMinutes: input.rangeMinutes, narrate: input.narrate }
	);
export const asTimelineJournalArg = nullableRpcParser(timelineJournalArgSchema);

/** Narrow an RPC argument to a `{ tsMicros: number }` for `timeline.frame`.
 *  Returns null for any other shape so a malformed keyframe read is rejected. */
const timelineFrameArgSchema = z.object({ tsMicros: z.number() });
export const asTimelineFrameArg = nullableRpcParser(timelineFrameArgSchema);

/** Parse an approval decide payload (`{ id, note? }`). The note is optional; a
 *  present non-string is dropped (never forwarded as a bad shape). */
const approvalDecideArgSchema = z
	.object({
		id: z.string().min(1),
		note: z.string().optional().catch(undefined),
	})
	.transform((input) =>
		input.note === undefined
			? { id: input.id }
			: { id: input.id, note: input.note }
	);
export const asApprovalDecideArg = nullableRpcParser(approvalDecideArgSchema);

const SUGGESTION_FEEDBACK_KINDS = z.enum([
	"thumbs_up",
	"thumbs_down",
	"dismiss",
]);

/** Parse a Shadow feedback payload (`{ kind, suggestion_type }`). */
const suggestionFeedbackArgSchema = z.object({
	kind: SUGGESTION_FEEDBACK_KINDS,
	suggestion_type: z.string(),
});
export const asSuggestionFeedbackArg = nullableRpcParser(
	suggestionFeedbackArgSchema
);

/** Parse a chat-open navigation payload (`{ prompt: string }`). */
const openInChatArgSchema = z.object({ prompt: z.string() });
export const asOpenInChatArg = nullableRpcParser(openInChatArgSchema);

/** Narrow an arg to `{ id: string }` (mail delete / rotate-secret). */
const mailIdArgSchema = z.object({ id: z.string().min(1) });
export const asMailIdArg = nullableRpcParser(mailIdArgSchema);

/** Narrow an arg to `{ inboxId: string }` (mail messages / inbound URL). */
const mailInboxRefArgSchema = z.object({ inboxId: z.string().min(1) });
export const asMailInboxRefArg = nullableRpcParser(mailInboxRefArgSchema);

/** Parse every endpoint-owned inbox and send field before privileged mail I/O. */
export const asMailCreateArg = nullableRpcParser(mailCreateInputSchema);
export const asMailSendArg = nullableRpcParser(mailSendInputSchema);
export const asMailRequestArg = nullableRpcParser(mailRequestInputSchema);

/** Narrow an RPC argument to a `{ id: string }` for `meetings.transcript`/`finalize`/
 *  `delete`. Returns null for any other shape so a malformed call never reaches Core. */
const meetingIdArgSchema = z.object({ id: z.string().min(1) });
export const asMeetingIdArg = nullableRpcParser(meetingIdArgSchema);

/** Narrow an optional `{ source?, app?, title? }` for `meetings.start`. Missing/invalid
 *  fields are dropped (Core applies its own defaults), so this always returns a
 *  well-formed object — the start has no required argument. */
const meetingStartArgSchema = z
	.object({
		source: z.string().optional().catch(undefined),
		app: z.string().optional().catch(undefined),
		title: z.string().optional().catch(undefined),
	})
	.transform((value): MeetingStartPayload => {
		const output: MeetingStartPayload = {};
		for (const key of ["source", "app", "title"] as const) {
			if (value[key] !== undefined) {
				output[key] = value[key];
			}
		}
		return output;
	})
	.catch(() => ({}));
export const asMeetingStartArg = meetingStartArgSchema.parse;

/** Methods `social.request` will forward. A closed set, so the frame cannot reach the
 *  sidecar with a verb its router does not serve (PUT, HEAD, or an arbitrary string). */
const SOCIAL_METHODS = z.enum(["GET", "POST", "PATCH", "DELETE"]);
const APP_METHODS = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

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

interface MountedRequestInput<Method extends string> {
	body?: RyuJsonValue;
	method: Method;
	path: string;
}

function mountedRequestSchema<Method extends string>(
	mount: string,
	methodSchema: z.ZodType<Method>,
	policy: { rejectQueryAndFragment?: boolean } = {}
) {
	const pathSchema = z
		.string()
		.refine(
			(path) =>
				path.startsWith("/") &&
				!path.startsWith("//") &&
				!path.includes("\\") &&
				!(
					policy.rejectQueryAndFragment &&
					(path.includes("?") || path.includes("#"))
				)
		)
		.transform((path, context) => {
			const resolved = resolveMountedRequestPath(mount, path);
			if (resolved === null) {
				context.addIssue({
					code: "custom",
					message: "Path must remain within the granted application mount",
				});
				return z.NEVER;
			}
			return resolved;
		});
	return z
		.object({
			body: preserveHostResponse(databaseResponseJsonSchema).optional(),
			method: methodSchema,
			path: pathSchema,
		})
		.transform((input): MountedRequestInput<Method> => {
			const output: MountedRequestInput<Method> = {
				method: input.method,
				path: input.path,
			};
			if (input.body !== undefined) {
				output.body = input.body;
			}
			return output;
		});
}

/** Validate the relative half of an own-app request. A synthetic fixed mount lets
 * the same WHATWG containment check catch encoded dot segments before the trusted
 * host attaches credentials and the real owning plugin id. */
const appRequestArgSchema = mountedRequestSchema(
	"/api/ext/app",
	z.preprocess((value) => value ?? "GET", APP_METHODS)
);
/** The optional target app: a concrete scoped id, never a pattern. */
const appRequestTargetSchema = z.object({
	app: z.string().refine(isScopedAppId).optional(),
});
export const asAppRequestArg = nullableRpcParser(
	z
		.intersection(appRequestTargetSchema, appRequestArgSchema)
		.transform(({ app, ...request }) =>
			app === undefined ? request : { ...request, app }
		)
);

const realtimeConnectArgSchema = z.object({
	room_id: z.string().max(512).trim().min(1),
});
export const asRealtimeConnectArg = nullableRpcParser(realtimeConnectArgSchema);
const realtimeConnectionArgSchema = z.object({
	connection_id: z
		.string()
		.max(128)
		.refine((value) => value.trim().length > 0),
});
export const asRealtimeConnectionArg = nullableRpcParser(
	realtimeConnectionArgSchema
);
const realtimePublishArgSchema = realtimeConnectionArgSchema
	.extend({ event: z.string().max(128).trim().min(1), data: z.unknown() })
	.transform(
		(input): RealtimePublishPayload => ({
			connection_id: input.connection_id,
			data: input.data,
			event: input.event,
		})
	);
export const asRealtimePublishArg = nullableRpcParser(realtimePublishArgSchema);
const realtimePresenceArgSchema = realtimeConnectionArgSchema
	.extend({ data: z.unknown() })
	.transform(
		(input): RealtimePresencePayload => ({
			connection_id: input.connection_id,
			data: input.data,
		})
	);
export const asRealtimePresenceArg = nullableRpcParser(
	realtimePresenceArgSchema
);

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
 *    {@link resolveMountedRequestPath}. The returned `path` is the normalized one, not
 *    the frame's raw string, so nothing downstream can re-derive a different target.
 *
 * `method` falls back to `"GET"`; anything outside {@link SOCIAL_METHODS} is refused
 * rather than silently downgraded. `body` must be JSON and retains its original
 * identity; endpoint-specific fields are validated by the owning sidecar.
 */
const socialRequestArgSchema = mountedRequestSchema(
	SOCIAL_MOUNT,
	SOCIAL_METHODS.default("GET")
);
export const asSocialRequestArg = nullableRpcParser(socialRequestArgSchema);

/** Methods `reasoning.request` will forward. `PUT` instead of Outpost's `PATCH`,
 *  matching the sidecar's policy-update route; a verb outside this set is refused
 *  rather than downgraded to GET. */
const REASONING_METHODS = z.enum(["GET", "POST", "PUT", "DELETE"]);

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
const reasoningRequestArgSchema = mountedRequestSchema(
	REASONING_MOUNT,
	REASONING_METHODS.default("GET")
);
export const asReasoningRequestArg = nullableRpcParser(
	reasoningRequestArgSchema
);

const SAFE_ACTIONS_METHODS = z.enum(["GET", "POST", "PUT", "DELETE"]);
const SAFE_ACTIONS_MOUNT = "/api/tools/plans";

/** Validate a frame-chosen Safe Actions sub-path with the same URL-parser
 * containment rule used by the other fixed-mount companion bridges. */
const safeActionsRequestArgSchema = mountedRequestSchema(
	SAFE_ACTIONS_MOUNT,
	SAFE_ACTIONS_METHODS.default("GET"),
	{ rejectQueryAndFragment: true }
);
export const asSafeActionsRequestArg = nullableRpcParser(
	safeActionsRequestArgSchema
);

/** Methods `rlm.request` will forward. The companion creates contexts (POST),
 *  reads them (GET) and deletes them (DELETE); nothing is edited in place, because a
 *  context is immutable by construction — but PUT is accepted so a future route does
 *  not need a change here. A verb outside this set is refused rather than downgraded
 *  to GET. */
const RLM_METHODS = z.enum(["GET", "POST", "PUT", "DELETE"]);

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
const rlmRequestArgSchema = mountedRequestSchema(
	RLM_MOUNT,
	RLM_METHODS.default("GET")
);
export const asRlmRequestArg = nullableRpcParser(rlmRequestArgSchema);

/** Methods `tuition.request` and `news.request` will forward. Both surfaces patch in
 *  place (a skill's name, a source's title) and replace whole documents (settings), so
 *  both verbs are here. A verb outside the set is refused rather than downgraded to
 *  GET, so a frame asking for one gets an error instead of silently reading where it
 *  meant to write. */
const APP_CRUD_METHODS = z.enum(["DELETE", "GET", "PATCH", "POST", "PUT"]);

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
const tuitionRequestArgSchema = mountedRequestSchema(
	TUITION_MOUNT,
	APP_CRUD_METHODS.default("GET")
);
export const asTuitionRequestArg = nullableRpcParser(tuitionRequestArgSchema);

/** Narrow an RPC argument to a `news.request` payload, or null. Same boundary and the
 *  same shared resolver as {@link asTuitionRequestArg}. */
const newsRequestArgSchema = mountedRequestSchema(
	NEWS_MOUNT,
	APP_CRUD_METHODS.default("GET")
);
export const asNewsRequestArg = nullableRpcParser(newsRequestArgSchema);

/** The mount Core serves the `ryu-subtitles` sidecar on. Mirrors `SUBTITLES_MOUNT` in
 *  `apps/desktop/src/lib/api/subtitles.ts`, which is the layer that actually builds
 *  the URL — this one validates the same string one hop earlier. */
const SUBTITLES_MOUNT = "/api/subtitles";

/** Methods `subtitles.request` will forward. No PATCH: nothing in this app edits a
 *  field in place, and a verb outside this set is refused rather than downgraded to
 *  GET, so a frame asking for one gets an error instead of silently reading where it
 *  meant to write. */
const SUBTITLES_METHODS = z.enum(["GET", "POST", "PUT", "DELETE"]);

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
const subtitlesRequestArgSchema = mountedRequestSchema(
	SUBTITLES_MOUNT,
	SUBTITLES_METHODS.default("GET")
);
export const asSubtitlesRequestArg = nullableRpcParser(
	subtitlesRequestArgSchema
);

/** The shared body of the two validators above. Shared between THEM only — not with
 *  the reasoning or social validators, whose method unions differ — so that widening
 *  one app's verbs cannot silently widen another's. */

/** Methods `blueprint.request` will forward — three, not four: the plan-review
 *  surface never edits in place (see {@link BlueprintRequestPayload}), so there is no
 *  PUT and no PATCH to accept. A verb outside this set is refused rather than
 *  downgraded to GET, so a frame asking for one gets an error instead of silently
 *  reading where it meant to write. */
const BLUEPRINT_METHODS = z.enum(["GET", "POST", "DELETE"]);

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
const blueprintRequestArgSchema = mountedRequestSchema(
	BLUEPRINT_MOUNT,
	BLUEPRINT_METHODS.default("GET")
);
export const asBlueprintRequestArg = nullableRpcParser(
	blueprintRequestArgSchema
);

/** Narrow an RPC argument to a `social.open` payload. Total rather than nullable: both
 *  fields are optional (no id opens the Outpost tab itself), so there is no shape a
 *  navigation verb should refuse — a bad field is simply dropped.
 *
 *  Deliberately only `postId` and `title`. The frame ALSO reads
 *  `window.ryu.context.section`, but that arrives through the mount context, not
 *  through this verb — accepting a `section` here would be an argument the host silently
 *  drops, which is how a verb becomes decorative. */
type SocialOpenInput = NonNullable<
	Parameters<NonNullable<HostServices["socialOpen"]>>[0]
>;
const socialOpenArgSchema = z
	.object({
		postId: z.string().min(1).optional().catch(undefined),
		title: z.string().optional().catch(undefined),
	})
	.transform((value) => {
		const output: SocialOpenInput = {};
		if (value.postId !== undefined) {
			output.postId = value.postId;
		}
		if (value.title !== undefined) {
			output.title = value.title;
		}
		return output;
	})
	.catch(() => ({}));
export const asSocialOpenArg = socialOpenArgSchema.parse;

/** Narrow an RPC argument to `{ id: string, title: string }` for `meetings.rename`.
 *  Returns null for any other shape so a malformed rename never reaches Core. */
const meetingRenameArgSchema = z.object({
	id: z.string().min(1),
	title: z.string(),
});
export const asMeetingRenameArg = nullableRpcParser(meetingRenameArgSchema);

/** Narrow an RPC argument to `{ id: string, icon: unknown | null }` for
 *  `meetings.setIcon`. `icon` may be null (clear) or any JSON glyph object. */
const meetingSetIconArgSchema = z
	.object({ id: z.string().min(1), icon: z.unknown() })
	.refine((value) => "icon" in value)
	.transform(({ id, icon }) => ({ id, icon: icon ?? null }));
export const asMeetingSetIconArg = nullableRpcParser(meetingSetIconArgSchema);

/** Narrow an RPC argument to `{ id: string, title? }` for the `meetings.open`
 *  shell-navigation verb. Returns null for any other shape so a malformed nav call
 *  never opens a tab. */
const meetingOpenArgSchema = z
	.object({
		id: z.string().min(1),
		title: z.string().optional().catch(undefined),
	})
	.transform(({ id, title }) => (title === undefined ? { id } : { id, title }));
export const asMeetingOpenArg = nullableRpcParser(meetingOpenArgSchema);

/** Narrow an RPC argument to `{ spaceId, docId, title? }` for the `meetings.openNotes`
 *  shell-navigation verb. Returns null for any other shape so a malformed nav call
 *  never opens a tab. */
const meetingOpenNotesArgSchema = z
	.object({
		spaceId: z.string().min(1),
		docId: z.string().min(1),
		title: z.string().optional().catch(undefined),
	})
	.transform(({ spaceId, docId, title }) =>
		title === undefined ? { spaceId, docId } : { spaceId, docId, title }
	);
export const asMeetingOpenNotesArg = nullableRpcParser(
	meetingOpenNotesArgSchema
);

/** Narrow an RPC argument to a `{ id: string }` for skill reads/distribution.
 *  Returns null for any other shape so a malformed read never reaches Core. */
const skillIdArgSchema = z.object({ id: z.string().min(1) });
export const asSkillIdArg = nullableRpcParser(skillIdArgSchema);

/** Narrow the shared skill-draft fields (`name` + `body` required; `description`/
 *  `allowedTools`/`alwaysOn` optional, invalid-typed ones dropped). Returns null when
 *  a required field is missing so a malformed write never reaches Core. */
const skillDraftArgSchema = z.object({
	name: z.string().min(1),
	body: z.string(),
	description: z.string().nullable().optional().catch(undefined),
	allowedTools: z.array(z.string()).optional().catch(undefined),
	alwaysOn: z.boolean().optional().catch(undefined),
});
function canonicalSkillDraft(
	value: z.output<typeof skillDraftArgSchema>
): SkillDraftPayload {
	const draft: SkillDraftPayload = { name: value.name, body: value.body };
	if (value.description !== undefined) {
		draft.description = value.description;
	}
	if (value.allowedTools !== undefined) {
		draft.allowedTools = value.allowedTools;
	}
	if (value.alwaysOn !== undefined) {
		draft.alwaysOn = value.alwaysOn;
	}
	return draft;
}
export const asSkillDraftArg = nullableRpcParser(
	skillDraftArgSchema.transform(canonicalSkillDraft)
);
const skillUpdateArgSchema = skillDraftArgSchema
	.extend({ id: z.string().min(1) })
	.transform((value) => ({ id: value.id, ...canonicalSkillDraft(value) }));
export const asSkillUpdateArg = nullableRpcParser(skillUpdateArgSchema);

/** Narrow an RPC argument to `{ id, versionId }` for `skills.versionSource`/`restore`. */
const skillVersionRefArgSchema = z.object({
	id: z.string().min(1),
	versionId: z.string().min(1),
});
export const asSkillVersionRefArg = nullableRpcParser(skillVersionRefArgSchema);

/** Narrow a `skills.snapshot` payload (`{ id, label? }`; a non-string label dropped). */
const skillSnapshotArgSchema = z
	.object({
		id: z.string().min(1),
		label: z.string().optional().catch(undefined),
	})
	.transform(({ id, label }) => (label === undefined ? { id } : { id, label }));
export const asSkillSnapshotArg = nullableRpcParser(skillSnapshotArgSchema);

/** Narrow a `skills.setTitle` payload (`{ title: string }`). Returns null for any
 *  other shape so a malformed nav call never renames the tab. */
const skillTitleArgSchema = z.object({ title: z.string().min(1) });
export const asSkillTitleArg = nullableRpcParser(skillTitleArgSchema);

/** Narrow a calendar New-automation payload `{ agentId, agentName,
 *  conversationId?, schedule, requireApproval? }`. The `schedule` must be a tagged `{ kind: "cron", expr }` or
 *  `{ kind: "every", interval }`; Core validates the cron/interval server-side. Any
 *  other shape returns null so a malformed call never reaches the composite. */
const calendarScheduleSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("cron"), expr: z.string() }),
	z.object({ kind: z.literal("every"), interval: z.string() }),
]);
const calendarCreateAutomationArgSchema = z
	.object({
		agentId: z.string().min(1),
		agentName: z.string(),
		conversationId: z.string().min(1).nullable().optional(),
		requireApproval: z.boolean().optional(),
		schedule: calendarScheduleSchema,
	})
	.transform((value): CalendarCreateAutomationPayload => {
		const output: CalendarCreateAutomationPayload = {
			agentId: value.agentId,
			agentName: value.agentName,
			schedule: value.schedule,
		};
		if (value.conversationId !== undefined) {
			output.conversationId = value.conversationId;
		}
		if (value.requireApproval !== undefined) {
			output.requireApproval = value.requireApproval;
		}
		return output;
	});
export const asCalendarCreateAutomationArg = nullableRpcParser(
	calendarCreateAutomationArgSchema
);

/**
 * Narrow the job list `warmup.apply` replaces this app's schedule with.
 *
 * Deliberately reconstructs each entry field by field rather than forwarding the
 * object: the frame must not be able to widen this capability past what it is
 * for. `target` is pinned to `agent` or `provider_account` (a workflow or
 * monitor target would let a warmup grant schedule arbitrary work), and the owning app id is NOT read from
 * the input at all — the host stamps it, so the frame cannot claim ownership of
 * another app's jobs and have the same call delete them.
 *
 * Cron expressions, intervals and zone names are left to Core, which already
 * validates all three and answers 400 with a message the app surfaces.
 */
const warmupCronScheduleSchema = z
	.object({
		kind: z.literal("cron"),
		expr: z.string(),
		tz: z.string().min(1).optional().catch(undefined),
	})
	.transform(({ kind, expr, tz }) =>
		tz === undefined ? { kind, expr } : { kind, expr, tz }
	);
const warmupScheduleSchema = z.union([
	warmupCronScheduleSchema,
	z.object({ kind: z.literal("every"), interval: z.string() }),
]);
const warmupAgentTargetSchema = z
	.object({
		type: z.literal("agent"),
		agentId: z.string().min(1),
		prompt: z.string(),
		model: z.string().min(1).optional().catch(undefined),
	})
	.transform(({ type, agentId, prompt, model }) =>
		model === undefined
			? { type, agentId, prompt }
			: { type, agentId, prompt, model }
	);
// One saved login of a provider pool. Core checks the provider supports
// per-account pings and that the account is saved before accepting the job.
const warmupProviderAccountTargetSchema = z
	.object({
		type: z.literal("provider_account"),
		providerId: z.string().min(1),
		accountId: z.string().min(1),
		prompt: z.string(),
		model: z.string().min(1),
	})
	.transform(({ type, providerId, accountId, prompt, model }) => ({
		type,
		providerId,
		accountId,
		prompt,
		model,
	}));
const warmupTargetSchema = z.union([
	warmupAgentTargetSchema,
	warmupProviderAccountTargetSchema,
]);
const warmupJobsArgSchema = z.array(
	z.object({
		name: z.string().min(1),
		schedule: warmupScheduleSchema,
		target: warmupTargetSchema,
	})
);
export const asWarmupJobsArg = nullableRpcParser(warmupJobsArgSchema);

/**
 * Narrow the one-off `warmup.runNow` payload.
 *
 * It names an existing job rather than describing a turn, so what the button
 * proves is what the schedule will actually do — and so the capability cannot be
 * used to run an arbitrary prompt on an arbitrary agent. The host additionally
 * refuses a job this app does not own.
 */
const warmupRunNowArgSchema = z.object({ jobId: z.string().min(1) });
export const asWarmupRunNowArg = nullableRpcParser(warmupRunNowArgSchema);

/** Narrow a quest create payload. Only the shape (`title`+`completion_condition`
 *  strings) is checked — Core validates server-side — and the whole object is
 *  forwarded verbatim so unknown fields survive. */
const questInputFieldsSchema = z.object({
	title: z.string(),
	completion_condition: z.string(),
});
function isQuestInput<T>(value: T): value is T & QuestInputPayload {
	return questInputFieldsSchema.safeParse(value).success;
}
const questInputBoundarySchema = z.custom<QuestInputPayload>(isQuestInput);
export const asQuestInputArg = nullableRpcParser(questInputBoundarySchema);

/** Narrow a quest update arg `{ id, input }`. The nested `input` is validated with
 *  {@link asQuestInputArg}. */
const questUpdateArgSchema = z.object({
	id: z.string().min(1),
	input: questInputBoundarySchema,
});
export const asQuestUpdateArg = nullableRpcParser(questUpdateArgSchema);

/** Narrow an arg to `{ id: string }` (workflows get/delete/versionsList/webhook/
 *  templateGet). */
const workflowIdArgSchema = z.object({ id: z.string().min(1) });
export const asWorkflowIdArg = nullableRpcParser(workflowIdArgSchema);

const workflowBindingIdentifierSchema = z
	.string()
	.min(1)
	.max(256)
	.refine((value) => !/\s/.test(value));
const workflowConnectBindingSchema = z
	.strictObject({
		id: workflowBindingIdentifierSchema,
		connectTriggerId: workflowBindingIdentifierSchema,
	})
	.transform(({ id, connectTriggerId }) => ({ id, value: connectTriggerId }));
const workflowTriggerBindingSchema = z
	.strictObject({
		id: workflowBindingIdentifierSchema,
		bindingId: workflowBindingIdentifierSchema,
	})
	.transform(({ id, bindingId }) => ({ id, value: bindingId }));
export function asWorkflowBindingArg(
	data: Parameters<typeof workflowConnectBindingSchema.safeParse>[0],
	field: "connectTriggerId" | "bindingId"
) {
	return nullableRpcParser(
		field === "connectTriggerId"
			? workflowConnectBindingSchema
			: workflowTriggerBindingSchema
	)(data);
}

/** Strict selector used by the Connect binding read; identity fields are never ignored. */
const connectWorkflowIdArgSchema = z.strictObject({
	id: z
		.string()
		.min(1)
		.max(256)
		.refine((id) => !/\s/.test(id)),
});
export const asConnectWorkflowIdArg = nullableRpcParser(
	connectWorkflowIdArgSchema
);

/** Narrow an explicit Webhooks secret read to `{ id: string }`. */
const webhookSecretIdArgSchema = z.object({
	id: z.string().refine((id) => id.trim().length > 0),
});
export const asWebhookSecretIdArg = nullableRpcParser(webhookSecretIdArgSchema);

/** Narrow a Webhooks secret write to `{ id: string, secret?: string }`. */
const webhookSecretSetArgSchema = webhookSecretIdArgSchema
	.extend({ secret: z.string().optional() })
	.transform(({ id, secret }) =>
		secret === undefined ? { id } : { id, secret }
	);
export const asWebhookSecretSetArg = nullableRpcParser(
	webhookSecretSetArgSchema
);

/** Narrow an arg to `{ id: string, versionId: string }` (workflows versionGet/
 *  versionRestore). */
const workflowVersionGetArgSchema = z.object({
	id: z.string().min(1),
	versionId: z.string().min(1),
});
export const asWorkflowVersionGetArg = nullableRpcParser(
	workflowVersionGetArgSchema
);

/** Narrow an arg to `{ id: string, label?: string; expectedRevision?: string }` (workflows.versionCreate). */
type WorkflowVersionCreateInput = NonNullable<
	Parameters<NonNullable<HostServices["workflowsVersionCreate"]>>[0]
>;
const workflowVersionCreateArgSchema = z
	.object({
		id: z.string().min(1),
		label: z.string().optional(),
		expectedRevision: z.string().optional(),
	})
	.transform((value) => {
		const output: WorkflowVersionCreateInput = {
			id: value.id,
		};
		if (value.label !== undefined) {
			output.label = value.label;
		}
		if (value.expectedRevision !== undefined) {
			output.expectedRevision = value.expectedRevision;
		}
		return output;
	});
export const asWorkflowVersionCreateArg = nullableRpcParser(
	workflowVersionCreateArgSchema
);

/** Narrow an arg to `{ templateId: string }` (workflows.templateInstall). */
const templateInstallArgSchema = z.object({ templateId: z.string().min(1) });
export const asTemplateInstallArg = nullableRpcParser(templateInstallArgSchema);

/** Narrow an arg to `{ id: string, input?: Record<string,string>, dryRun?: boolean }` (workflows.run).
 *  `input` is an optional string→string map (the initial run inputs); a present-but-
 *  malformed value rejects the whole arg. `dryRun` is an optional boolean that
 *  requests Core's transient read-only execution mode. */
const workflowRunInputsSchema = z.record(z.string(), z.string());
type WorkflowRunInput = NonNullable<
	Parameters<NonNullable<HostServices["workflowsRun"]>>[0]
>;
const workflowRunArgSchema = z
	.object({
		id: z.string().min(1),
		dryRun: z.boolean().optional(),
		input: workflowRunInputsSchema.optional(),
	})
	.transform((value) => {
		const output: WorkflowRunInput = { id: value.id };
		if (value.dryRun !== undefined) {
			output.dryRun = value.dryRun;
		}
		if (value.input !== undefined) {
			output.input = value.input;
		}
		return output;
	});
export const asWorkflowRunArg = nullableRpcParser(workflowRunArgSchema);

/** Narrow an arg to `{ runId: string }` (workflows.runGet). */
const workflowRunIdArgSchema = z.object({ runId: z.string().min(1) });
export const asWorkflowRunIdArg = nullableRpcParser(workflowRunIdArgSchema);

/** Narrow an arg to `{ runId: string, payload: string }` (workflows.resume). */
const workflowResumeArgSchema = z.object({
	runId: z.string().min(1),
	payload: z.string(),
});
export const asWorkflowResumeArg = nullableRpcParser(workflowResumeArgSchema);

/** Narrow an arg to the composio catalog request (workflows.composio): a `kind`
 *  from the closed set + an optional `toolkit` slug. */
const composioArgSchema = z
	.object({
		kind: workflowComposioKindSchema,
		toolkit: z.string().optional(),
	})
	.transform((input) =>
		input.toolkit === undefined
			? { kind: input.kind }
			: { kind: input.kind, toolkit: input.toolkit }
	);
export const asComposioArg = nullableRpcParser(composioArgSchema);

/** Narrow an arg to `{ task: string }` (ghost.recordStart). */
const recordStartArgSchema = z.object({ task: z.string() });
export const asRecordStartArg = nullableRpcParser(recordStartArgSchema);

/** Narrow an unknown postMessage payload to a valid {@link RpcRequest}. Rejects
 *  anything not shaped like our envelope so stray messages never reach dispatch. */
const rpcRequestSchema = z.object({
	args: z.custom<unknown[]>(
		(value) => Array.isArray(value) && value.length <= 16
	),
	id: z
		.number()
		.int()
		.min(0)
		.max(2 ** 31 - 1),
	kind: z.literal("ryu-plugin-rpc"),
	method: z.string().min(1).max(128),
}) satisfies z.ZodType<RpcRequest>;
export const asRpcRequest = nullableRpcParser(rpcRequestSchema);

/** Route shape validation shares its owner with the route allowlist. */
export const asRouteClaim = nullableRpcParser(routeClaimSchema);
