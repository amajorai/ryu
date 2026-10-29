// packages/services/test/tool-output-cases.ts
//
// The stubbed replies every registry tool runs against in the outputSchema
// conformance tests: one success case per tool (CASES) plus the result
// variants a body can answer (VARIANTS). The replies are what the SDK's own
// response contracts accept (packages/client *-contracts.ts), recorded
// fixtures where the repo has them, and the snake_case shapes a self-hosted
// server sends.
//
// Shared by packages/services/src/tools/output.test.ts and, exported as JSON
// by bindings/python/tests/fixtures/services_tools.ts (`output-cases`), by the
// Python port's bindings/python/tests/test_services_tools_output.py, so both
// ports run every tool body against the same replies. Everything here is
// plain JSON: a route is `[pattern, reply]`, where `pattern` is a regular
// expression (JavaScript and Python `re` alike) searched in `METHOD /path`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** What a stubbed route answers. */
export type StubReply =
	/** 200 with this JSON body. */
	| { readonly json: unknown }
	/** 200 with this text body. */
	| { readonly text: string }
	/** 204 with no body. */
	| { readonly empty: true };

/** `[pattern, reply]`: the first route whose pattern is found in `METHOD /path` answers. */
export type StubRoute = readonly [string, StubReply];

export interface ToolOutputCase {
	readonly input: Record<string, unknown>;
	readonly routes: readonly StubRoute[];
}

export interface ToolOutputVariant extends ToolOutputCase {
	/** What the variant covers. */
	readonly label: string;
	readonly tool: string;
}

const NOW = "2026-10-21T12:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

function fixtureBody(path: string): Record<string, unknown> {
	return (
		JSON.parse(
			readFileSync(resolve(import.meta.dir, "fixtures", path), "utf8")
		) as { body: Record<string, unknown> }
	).body;
}

const json = (body: unknown): StubReply => ({ json: body });

/** The environment the cases run in (every service on its own example host). */
export const TOOL_OUTPUT_ENV = {
	RYU_API_KEY: "ryu_test_key",
	RYU_ORGANIZATION_ID: "org_1",
	RYU_MAIL_URL: "https://mail.example.com",
	RYU_MAIL_API_KEY: "mail-key",
	RYU_NOTIFY_URL: "https://notify.example.com",
	RYU_NOTIFY_API_KEY: "notify-key",
	RYU_BOX_URL: "https://box.example.com",
	RYU_BOX_API_KEY: "box-key",
	RYU_GATEWAY_URL: "https://gateway.example.com",
	RYU_GATEWAY_TOKEN: "gateway-token",
	RYU_PASSPORT_URL: "https://passport.example.com",
	RYU_PASSPORT_API_KEY: "passport-key",
	RYU_SITES_URL: "https://sites.example.com",
	RYU_SITES_API_KEY: "sites-key",
} as const;

// Recorded replies.
const BOX = fixtureBody("box/create-201.json").box;
const EXEC = fixtureBody("box/exec-200.json");
const PUBLISHED = fixtureBody("notify/publish-created.json");
const EVENTS_PAGE = fixtureBody("notify/events-page-1.json");
const SITE = fixtureBody("sites/deployed.json");
const SITES_STATUS = fixtureBody("sites/status.json");

const NOTIFY_EVENT = PUBLISHED.event as Record<string, unknown>;
const approvalEvent = (response: Record<string, unknown>) => ({
	...NOTIFY_EVENT,
	response: {
		callbackUrl: null,
		expiresAt: FUTURE,
		prompt: "Ship build 184?",
		respondedAt: NOW,
		status: "approved",
		type: "approval",
		value: null,
		...response,
	},
});
const APPROVED_EVENT = approvalEvent({});

// Contract-shaped replies (packages/client *-contracts.ts).
const INBOX = {
	id: "inbox_1",
	address: "agent@acme.example",
	name: "Agent",
	provider: "webhook",
	metadata: {},
	createdAt: NOW,
	updatedAt: NOW,
};
const MAIL_MESSAGE = {
	id: "msg_1",
	inbox_id: "inbox_1",
	direction: "outbound",
	status: "sent",
	from: "agent@acme.example",
	to: ["p@example.com"],
	subject: "Hi",
	text: "Hello",
	attachments: [
		{ id: "att_1", filename: "a.txt", contentType: "text/plain", size: 5 },
	],
	createdAt: NOW,
};
// What a self-hosted Mail server sends (apps-store/mail/backend: PublicInbox
// and EmailMessage serialize snake_case).
const SELF_HOSTED_INBOX = {
	address: "agent@acme.example",
	client_id: "client_1",
	created_at: NOW,
	id: "inbox_1",
	metadata: { team: "ops" },
	name: "Agent",
	pod_id: "pod_1",
	provider: "imap",
	require_timestamp: false,
	updated_at: NOW,
};
const SELF_HOSTED_MESSAGE = {
	id: "msg_2",
	inbox_id: "inbox_1",
	direction: "inbound",
	message_id: "<m2@acme.example>",
	in_reply_to: "<m1@acme.example>",
	from_addr: "p@example.com",
	to_addrs: ["agent@acme.example"],
	cc_addrs: ["cc@example.com"],
	bcc_addrs: [],
	reply_to_addrs: [],
	references: ["<m1@acme.example>"],
	thread_id: "thr_1",
	subject: "Re: Hi",
	text: "Thanks",
	headers: { "x-priority": "1" },
	labels: ["inbox"],
	attachments: [
		{
			id: "att_2",
			filename: "logo.png",
			content_type: "image/png",
			content_id: "logo",
			inline: true,
			size: 42,
		},
	],
	status: "received",
	created_at: NOW,
	updated_at: NOW,
};
const SMS = {
	id: "smsg_1",
	organizationId: "org_1",
	channel: "sms",
	direction: "outbound",
	status: "accepted",
	from: "+15550000000",
	to: "+6591234567",
	isoCountryCode: "SG",
	numberId: "num_1",
	whatsappSenderId: null,
	body: "Hello",
	bodyType: "text",
	encoding: "GSM",
	segments: 1,
	template: null,
	hasMedia: false,
	providerMessageId: null,
	providerStatus: null,
	providerStatusDescription: null,
	heldMicroUsd: 9000,
	priceMicroUsd: null,
	chargedMicroUsd: 0,
	absorbedMicroUsd: 0,
	chargeState: "held",
	estimated: false,
	ttlSeconds: null,
	metadata: { order: "42" },
	error: null,
	createdAt: NOW,
	updatedAt: NOW,
};
const NUMBER = {
	id: "num_1",
	organizationId: "org_1",
	phoneNumber: "+15550000000",
	isoCountryCode: "US",
	numberType: "TOLL_FREE",
	capabilities: ["SMS"],
	messageType: "TRANSACTIONAL",
	status: "active",
	label: null,
	twoWayEnabled: true,
	registrationId: "reg_1",
	monthlyLeaseMicroUsd: 2_000_000,
	leasePeriod: 1,
	currentPeriodEndsAt: FUTURE,
	suspendedAt: null,
	graceEndsAt: null,
	releasedAt: null,
	error: null,
	createdAt: NOW,
	updatedAt: NOW,
};
const USAGE = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadInputTokens: 0,
	cacheWriteInputTokens: 0,
	reasoningTokens: 0,
	webSearchRequests: 0,
	activeSeconds: 0,
	listCostMicroUsd: null,
};
const AGENT = {
	id: "magt_1",
	name: "Support",
	description: null,
	model: "claude-sonnet-4-5",
	instructions: null,
	tools: [],
	mcpServers: [],
	reasoningEffort: null,
	metadata: {},
	version: 1,
	archivedAt: null,
	createdAt: NOW,
	updatedAt: NOW,
};
const ENVIRONMENT = {
	id: "menv_1",
	name: "default",
	description: null,
	backend: "anthropic",
	credential: { source: "platform" },
	config: { networking: { type: "unrestricted" } },
	revision: 1,
	archivedAt: null,
	createdAt: NOW,
	updatedAt: NOW,
};
/** A Managed Agents session stopped on a tool approval. */
export const MA_SESSION = {
	id: "msess_1",
	agentId: "magt_1",
	agentVersion: 1,
	environmentId: "menv_1",
	environmentRevision: 1,
	backend: "anthropic",
	title: null,
	metadata: {},
	status: "idle",
	stopReason: "requires_action",
	pendingToolUseIds: ["mtool_c"],
	lastError: null,
	headSeq: 4,
	usage: USAGE,
	billedMicroUsd: 0,
	budget: null,
	closing: null,
	createdAt: NOW,
	updatedAt: NOW,
	startedAt: NOW,
	endedAt: null,
};
const envelope = (seq: number) => ({
	id: `mevt_${seq}`,
	sessionId: "msess_1",
	seq,
	createdAt: NOW,
});
/** A turn that stops on a tool approval. */
export const MA_LOG = [
	{
		...envelope(1),
		type: "user.message",
		content: [{ type: "text", text: "Hi" }],
	},
	{
		...envelope(2),
		type: "agent.tool_use",
		toolUseId: "mtool_c",
		name: "bash",
		input: { command: "ls" },
		inputTruncated: false,
		source: "builtin",
		server: null,
	},
	{
		...envelope(3),
		type: "agent.tool_approval_request",
		toolUseId: "mtool_c",
		name: "bash",
		source: "builtin",
		server: null,
		expiresAt: FUTURE,
	},
	{
		...envelope(4),
		type: "session.status",
		status: "idle",
		stopReason: "requires_action",
		pendingToolUseIds: ["mtool_c"],
		detail: null,
		inputSeq: 1,
	},
];
const APPROVAL_ANSWER = {
	...envelope(5),
	type: "user.tool_approval",
	toolUseId: "mtool_c",
	decision: "allow",
	message: null,
};
const PASSPORT_CONNECTION = {
	id: "conn_1",
	profile_id: "prof_1",
	domain: "api.github.com",
	status: "AUTHENTICATED",
	flow_status: "DONE",
	source: "manual",
	created_at: 1_760_000_000,
	updated_at: 1_760_000_000,
	last_checked: 0,
};
const COMPLETION = {
	id: "chatcmpl_1",
	object: "chat.completion",
	created: 1_760_000_000,
	model: "openai/gpt-4o-mini",
	choices: [
		{
			index: 0,
			finish_reason: "stop",
			message: { role: "assistant", content: "Hello" },
		},
	],
	usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

const SITE_ROUTES: readonly StubRoute[] = [
	["^GET /api/sites/status$", json(SITES_STATUS)],
	["^GET /api/sites/projects$", json([SITE])],
	["^POST /api/sites/projects/[^/]+/deploy$", json(SITE)],
	["^POST /api/sites/projects$", json(SITE)],
	["^PUT /api/sites/projects/[^/]+/settings$", json(SITE)],
	["^GET /api/sites/projects/[^/]+$", json(SITE)],
];
const SITE_ID = String(SITE.id);
/** {@link SITE} remixed from another Site, with every optional record filled in. */
const REMIXED_SITE = {
	...SITE,
	domains: [
		{
			host: "launch.example.com",
			status: "pending_tls",
			verification: "ryu-site-verify=abc123",
			checkedAt: NOW,
		},
	],
	connections: [
		{
			id: "crm",
			label: "CRM",
			description: "Look up a customer.",
			toolId: "crm.lookup",
			agentId: "ryu",
			readOnly: true,
			revision: 1,
			updatedAt: NOW,
			updatedBy: "node-owner",
		},
	],
	remixedFrom: {
		siteId: "site_source",
		versionId: "ver_source",
		name: "Launch template",
	},
	versions: (SITE.versions as Record<string, unknown>[]).map((version) => ({
		...version,
		extensions: {
			mcp: true,
			ui: false,
			tools: [
				{
					name: "list_notes",
					description: "Lists the saved notes.",
					operation: "records.list",
					collection: "notes",
				},
			],
			connections: ["crm"],
		},
	})),
};
const SITE_VERSION = String(
	(SITE.versions as { id: string }[]).at(-1)?.id ?? ""
);
const MA_PAGE = { data: MA_LOG, hasMore: false, nextAfter: 4, headSeq: 4 };
const APPROVAL_INPUT = { title: "Ship?", prompt: "Ship build 184?", waitMs: 0 };

/** One success case per registry tool. */
export const TOOL_OUTPUT_CASES: Readonly<Record<string, ToolOutputCase>> = {
	managed_agents_list_agents: {
		input: {},
		routes: [["agents$", json({ data: [AGENT], nextCursor: null })]],
	},
	managed_agents_list_environments: {
		input: {},
		routes: [
			["environments$", json({ data: [ENVIRONMENT], nextCursor: "c2" })],
		],
	},
	managed_agents_create_session: {
		input: { agentId: "magt_1", environmentId: "menv_1", message: "Hi" },
		routes: [["^POST .*/sessions$", json(MA_SESSION)]],
	},
	managed_agents_send_message: {
		input: { sessionId: "msess_1", text: "Hi" },
		routes: [
			["^POST .*/sessions/msess_1/events$", json({ data: [MA_LOG[0]] })],
		],
	},
	managed_agents_get_session: {
		input: { sessionId: "msess_1" },
		routes: [["sessions/msess_1$", json(MA_SESSION)]],
	},
	managed_agents_list_pending_approvals: {
		input: { sessionId: "msess_1" },
		routes: [
			["sessions/msess_1/events$", json(MA_PAGE)],
			["sessions/msess_1$", json(MA_SESSION)],
		],
	},
	managed_agents_answer_approval: {
		input: { sessionId: "msess_1", toolUseId: "mtool_c", decision: "allow" },
		routes: [["^POST .*/events$", json({ data: [APPROVAL_ANSWER] })]],
	},
	managed_agents_list_events: {
		input: { sessionId: "msess_1" },
		routes: [["sessions/msess_1/events$", json(MA_PAGE)]],
	},
	messaging_status: {
		input: {},
		routes: [
			[
				"/status$",
				json({
					apiVersion: "v1",
					configured: true,
					channels: { sms: true, mms: false, voice: false, whatsapp: false },
				}),
			],
		],
	},
	messaging_quote: {
		input: { to: "+6591234567", body: "Hello" },
		routes: [
			[
				"/quote$",
				json({
					channel: "sms",
					credit: { availableMicroUsd: 5_000_000, heldMicroUsd: 0 },
					quote: {
						ceilingMicroUsd: 9000,
						encoding: "GSM",
						isoCountryCode: "SG",
						segments: 1,
					},
				}),
			],
		],
	},
	messaging_send_sms: {
		input: {
			from: "num_1",
			to: "+6591234567",
			body: "Hello",
			idempotencyKey: "sms-key-0001",
		},
		routes: [["^POST .*/sms$", json({ message: SMS })]],
	},
	messaging_list_messages: {
		input: {},
		routes: [["/messages$", json({ messages: [SMS], nextCursor: null })]],
	},
	messaging_get_message: {
		input: { messageId: "smsg_1" },
		routes: [["/messages/smsg_1$", json({ message: SMS })]],
	},
	messaging_list_numbers: {
		input: {},
		routes: [["/numbers$", json({ numbers: [NUMBER] })]],
	},
	mail_status: {
		input: {},
		routes: [
			[
				"/api/mail/status$",
				json({
					apiVersion: "v1",
					configured: true,
					domainMode: "byo",
					inbound: "webhook",
					inboxCount: 1,
					sendConfigured: true,
				}),
			],
		],
	},
	mail_list_inboxes: {
		input: {},
		routes: [["/api/mail/inboxes$", json({ inboxes: [INBOX] })]],
	},
	mail_list_messages: {
		input: { inboxId: "inbox_1" },
		routes: [
			[
				"/api/mail/inboxes/inbox_1/messages$",
				json({ messages: [MAIL_MESSAGE] }),
			],
		],
	},
	mail_get_message: {
		input: { messageId: "msg_1" },
		routes: [["/api/mail/messages/msg_1$", json(MAIL_MESSAGE)]],
	},
	mail_create_inbox: {
		input: { name: "Agent", clientId: "client_1" },
		routes: [
			["^POST /api/mail/inboxes$", json({ ...INBOX, clientId: "client_1" })],
		],
	},
	mail_send: {
		input: {
			from: "inbox_1",
			to: ["p@example.com"],
			subject: "Hi",
			text: "Hello",
			idempotencyKey: "welcome-42",
		},
		routes: [["^POST /api/mail/inboxes/inbox_1/send$", json(MAIL_MESSAGE)]],
	},
	notify_publish: {
		input: { title: "Deploy finished", level: "success" },
		routes: [["^POST /v1/events$", json(PUBLISHED)]],
	},
	notify_request_approval: {
		input: APPROVAL_INPUT,
		routes: [
			["^POST /v1/events$", json({ ...PUBLISHED, event: APPROVED_EVENT })],
			["^GET /v1/events/[^/]+$", json({ event: APPROVED_EVENT })],
		],
	},
	notify_list_events: {
		input: {},
		routes: [["^GET /v1/events$", json(EVENTS_PAGE)]],
	},
	notify_get_event: {
		input: { eventId: String(NOTIFY_EVENT.id) },
		routes: [["^GET /v1/events/[^/]+$", json({ event: NOTIFY_EVENT })]],
	},
	notify_ack_event: {
		input: { eventId: String(NOTIFY_EVENT.id) },
		routes: [
			[
				"/v1/events/[^/]+/ack",
				json({ event: { ...NOTIFY_EVENT, acknowledgedAt: NOW } }),
			],
		],
	},
	notify_usage: {
		input: {},
		routes: [
			[
				"^GET /v1/usage$",
				json({
					from: "2026-10-20T12:00:00.000Z",
					to: NOW,
					meters: { events: 3 },
				}),
			],
		],
	},
	box_list: {
		input: {},
		routes: [["^GET /v1/boxes$", json({ boxes: [BOX] })]],
	},
	box_get: {
		input: { boxId: "bx_1" },
		routes: [["^GET /v1/boxes/bx_1$", json({ box: BOX })]],
	},
	box_create: {
		input: { name: "conformance" },
		routes: [["^POST /v1/boxes$", json(fixtureBody("box/create-201.json"))]],
	},
	box_exec: {
		input: { boxId: "bx_1", command: "echo hi" },
		routes: [["/commands$", json(EXEC)]],
	},
	box_read_file: {
		input: { boxId: "bx_1", path: "notes.txt", maxChars: 3 },
		routes: [["/files/content$", { text: "hello" }]],
	},
	box_write_file: {
		input: { boxId: "bx_1", path: "notes.txt", content: "hello" },
		routes: [["/files/content$", { empty: true }]],
	},
	box_stop: {
		input: { boxId: "bx_1" },
		routes: [["/stop$", json({ ok: true })]],
	},
	box_resume: {
		input: { boxId: "bx_1" },
		routes: [["/resume$", json({ box: BOX })]],
	},
	box_delete: {
		input: { boxId: "bx_1" },
		routes: [["^DELETE /v1/boxes/bx_1$", json({ ok: true })]],
	},
	gateway_list_models: {
		input: {},
		routes: [
			[
				"/v1/models$",
				json({
					object: "list",
					data: [{ id: "openai/gpt-4o-mini", object: "model" }],
				}),
			],
		],
	},
	gateway_chat: {
		input: { model: "openai/gpt-4o-mini", prompt: "Hi" },
		routes: [["/v1/chat/completions$", json(COMPLETION)]],
	},
	passport_list_profiles: {
		input: {},
		routes: [
			[
				"/v1/profiles$",
				json({
					profiles: [
						{ profile_id: "prof_1", connections: [PASSPORT_CONNECTION] },
					],
				}),
			],
		],
	},
	passport_list_connections: {
		input: {},
		routes: [
			["/v1/connections$", json({ connections: [PASSPORT_CONNECTION] })],
		],
	},
	passport_fetch: {
		input: { connectionId: "conn_1", url: "https://api.github.com/user" },
		routes: [
			[
				"/v1/connections/conn_1/fetch$",
				json({
					status: 200,
					authenticated: true,
					content: "{}",
					truncated: false,
				}),
			],
		],
	},
	sites_list: { input: {}, routes: SITE_ROUTES },
	sites_get: { input: { siteId: SITE_ID }, routes: SITE_ROUTES },
	sites_create: {
		input: { name: "Launch notes", slug: "launch-notes" },
		routes: SITE_ROUTES,
	},
	sites_deploy: {
		input: {
			siteId: SITE_ID,
			versionId: SITE_VERSION,
			expectedRevision: Number(SITE.revision),
		},
		routes: SITE_ROUTES,
	},
	sites_update_settings: {
		input: {
			siteId: SITE_ID,
			allowRemix: true,
			expectedRevision: Number(SITE.revision),
		},
		routes: SITE_ROUTES,
	},
};

const PENDING_EVENT = approvalEvent({ respondedAt: null, status: "pending" });

/** Result variants a body answers besides its CASES path. */
export const TOOL_OUTPUT_VARIANTS: readonly ToolOutputVariant[] = [
	{
		tool: "notify_request_approval",
		label: "still pending when waitMs runs out",
		input: APPROVAL_INPUT,
		routes: [
			["^POST /v1/events$", json({ ...PUBLISHED, event: PENDING_EVENT })],
			["^GET /v1/events/[^/]+$", json({ event: PENDING_EVENT })],
		],
	},
	{
		tool: "notify_request_approval",
		label: "expired (timedOut true)",
		input: APPROVAL_INPUT,
		routes: [
			[
				"^POST /v1/events$",
				json({
					...PUBLISHED,
					event: approvalEvent({ respondedAt: null, status: "expired" }),
				}),
			],
		],
	},
	{
		tool: "notify_request_approval",
		label: "answered with a value",
		input: APPROVAL_INPUT,
		routes: [
			[
				"^POST /v1/events$",
				json({ ...PUBLISHED, event: approvalEvent({ value: "after 5pm" }) }),
			],
		],
	},
	{
		tool: "sites_list",
		label: "scope owned",
		input: { scope: "owned" },
		routes: SITE_ROUTES,
	},
	{
		tool: "sites_list",
		label: "scope shared",
		input: { scope: "shared" },
		routes: SITE_ROUTES,
	},
	{
		tool: "mail_list_inboxes",
		label: "a self-hosted server's snake_case inbox",
		input: {},
		routes: [["/api/mail/inboxes$", json({ inboxes: [SELF_HOSTED_INBOX] })]],
	},
	{
		tool: "mail_list_inboxes",
		label:
			"hosted inboxes with createdWith (set, legacy null, partial, malformed)",
		input: {},
		routes: [
			[
				"/api/mail/inboxes$",
				json({
					inboxes: [
						{
							...INBOX,
							createdWith: {
								apiKeyId: "key_1",
								gatewayCredentialId: null,
								oauthClientId: null,
								serviceAccountId: "sa_1",
								via: "api_key",
							},
						},
						{ ...INBOX, id: "inbox_2", createdWith: null },
						{
							...INBOX,
							id: "inbox_3",
							createdWith: { via: "oauth", oauthClientId: "app_1", extra: 1 },
						},
						{ ...INBOX, id: "inbox_4", createdWith: { apiKeyId: "key_1" } },
						{
							...INBOX,
							id: "inbox_5",
							createdWith: { via: "api_key", apiKeyId: 7 },
						},
					],
				}),
			],
		],
	},
	{
		tool: "mail_create_inbox",
		label: "a self-hosted server's wrapped snake_case inbox",
		input: {
			name: "Agent",
			clientId: "client_1",
			address: "agent@acme.example",
			podId: "pod_1",
		},
		routes: [["^POST /api/mail/inboxes$", json({ inbox: SELF_HOSTED_INBOX })]],
	},
	{
		tool: "mail_get_message",
		label: "a self-hosted server's snake_case message",
		input: { messageId: "msg_2" },
		routes: [["/api/mail/messages/msg_2$", json(SELF_HOSTED_MESSAGE)]],
	},
	{
		tool: "mail_list_messages",
		label: "a self-hosted server's snake_case messages",
		input: { inboxId: "inbox_1" },
		routes: [
			[
				"/api/mail/inboxes/inbox_1/messages$",
				json({ messages: [SELF_HOSTED_MESSAGE] }),
			],
		],
	},
	{
		tool: "mail_status",
		label: "a sparse snake_case status (defaults filled in)",
		input: {},
		routes: [["/api/mail/status$", json({ configured: true, inbox_count: 2 })]],
	},
	{
		tool: "mail_status",
		label: "hosted Mail's status with its domain",
		input: {},
		routes: [
			[
				"/api/mail/status$",
				json({
					apiVersion: "v1",
					configured: true,
					domain: "agents.example.com",
					domainMode: "managed",
					inbound: "sns",
					sendConfigured: true,
				}),
			],
		],
	},
	{
		tool: "mail_status",
		label: "a count as prefixed integer text (`Number()` reads 0x/0b/0o)",
		input: {},
		routes: [
			["/api/mail/status$", json({ configured: true, inboxCount: " 0x10 " })],
		],
	},
	{
		tool: "mail_get_message",
		label: "attachment sizes as prefixed integer text",
		input: { messageId: "msg_2" },
		routes: [
			[
				"/api/mail/messages/msg_2$",
				json({
					...SELF_HOSTED_MESSAGE,
					attachments: [
						{ ...SELF_HOSTED_MESSAGE.attachments[0], size: "0b11" },
						{
							...SELF_HOSTED_MESSAGE.attachments[0],
							id: "att_3",
							size: "0O17",
						},
						{
							...SELF_HOSTED_MESSAGE.attachments[0],
							id: "att_4",
							size: ["0X1f"],
						},
					],
				}),
			],
		],
	},
	{
		tool: "sites_get",
		label: "a remixed Site with a custom domain, a connection and a Site tool",
		input: { siteId: SITE_ID },
		routes: [["^GET /api/sites/projects/[^/]+$", json(REMIXED_SITE)]],
	},
];
