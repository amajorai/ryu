import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { DEFAULT_SECTION_ORDER } from "../src/components/layout/sidebar-sections.ts";
import type { ChannelInput } from "../src/lib/api/channels.ts";
import type { Connection, Profile } from "../src/lib/api/identities.ts";
import {
	type SidebarFixtureSpace,
	type SidebarProofJson,
	type SidebarProofState,
	sidebarChannelRequestSchema,
	sidebarCloneFolderSchema,
	sidebarCreateSpaceSchema,
	sidebarIconRequestSchema,
	sidebarIdentityRequestSchema,
	sidebarImportRunSchema,
	sidebarImportScanSchema,
	sidebarNewFolderSchema,
	sidebarPersistedConversationIds,
	sidebarProofJsonSchema,
	sidebarSpaceVisibilitySchema,
	sidebarStringsSchema,
	sidebarTabSnapshotSchema,
	sidebarThreadImportSchema,
} from "./app-sidebar-interactions-proof.contracts.ts";

const STORY_URL = "/app-sidebar-interactions-proof.html";
const EXPECTED_OPTIONAL_RESOURCE_URLS = new Set([
	"http://127.0.0.1:7989/control",
	"https://api.svgl.app/",
]);
const unexpectedBrowserErrors = new WeakMap<Page, string[]>();
const nativeRequestLedger = new WeakMap<
	Page,
	Array<{ command: string; args: unknown }>
>();
const unexpectedHttpRequests = new WeakMap<Page, RecordedRequest[]>();
const EVIDENCE_DIRECTORY = fileURLToPath(
	new URL(
		"../../../docs/proof/test-coverage-sweep-20260924/evidence/app-sidebar-interactions/",
		import.meta.url
	)
);
const PROJECT_PATH = "/Users/proof/Project Alpha";
const DEFAULT_PROOF_HIDDEN_SECTIONS = [
	"channels",
	"integrations",
	"identities",
	"skills",
	"mcp",
	"tools",
	"engines",
	"plugins",
];
const DEFAULT_PROOF_HIDDEN_CHROME: string[] = [];

interface RecordedRequest {
	body: SidebarProofJson;
	method: string;
	path: string;
}

interface ApiFixture {
	calendarEnabled: boolean;
	channels: ReturnType<typeof channelConfig>[];
	failChannelCreateOnce: boolean;
	failFolderCloneOnce: boolean;
	failFolderCreateOnce: boolean;
	failSkillReadCount: number;
	failSpaceCreateOnce: boolean;
	identities: Profile[];
	requests: RecordedRequest[];
	spaces: SidebarFixtureSpace[];
}

interface ProofWindow extends Window {
	__APP_SIDEBAR_PROOF__?: SidebarProofState;
	__SIDEBAR_NATIVE_LEDGER__?: (call: {
		command: string;
		args: unknown;
	}) => Promise<void>;
}
declare global {
	interface Window {
		__APP_SIDEBAR_PROOF__?: SidebarProofState;
	}
}

const fixtures = new WeakMap<Page, ApiFixture>();

function jsonResponse<FixturePayload>(data: FixturePayload, status = 200) {
	return {
		body: JSON.stringify(data),
		contentType: "application/json",
		status,
	};
}

const EMPTY_CONTRIBUTIONS = {
	agent_edit_panels: [],
	channels: [],
	chat_features: [],
	companions: [],
	composer_controls: [],
	context_menu_items: [
		{
			anchor: "agent",
			args: { source: "sidebar" },
			capability: "proof.inspect-agent",
			id: "inspect-agent",
			label: "Inspect agent",
			order: 1,
			plugin: "proof-app",
		},
		{
			anchor: "record",
			args: { source: "sidebar" },
			capability: "proof.inspect-record",
			id: "inspect-record",
			label: "Inspect record",
			order: 1,
			plugin: "proof-app",
		},
	],
	create_actions: [],
	dock_panels: [],
	hook_events: [],
	live_activities: [],
	message_actions: [],
	output_styles: [],
	selection_actions: [],
	settings_tabs: [],
	sidebar_buttons: [
		{
			context: { collection: "proof" },
			icon: "lucide:library",
			id: "proof-home",
			order: 1,
			plugin: "proof-app",
			target: "/proof/home",
			title: "Proof home",
		},
	],
	sidebar_modes: [
		{
			default_section: "plugin:proof-app:proof-records",
			id: "proof-mode",
			order: 10,
			plugin: "proof-app",
			sections: ["plugin:proof-app:proof-records"],
			title: "Proof mode",
		},
	],
	sidebar_sections: [
		{
			approved_grants: ["ui:declarative-http"],
			http_policy: "core",
			id: "proof-records",
			order: 1,
			plugin: "proof-app",
			title: "Proof records",
			spec: {
				create: {
					http: {
						body: { name: "Created proof record" },
						method: "POST",
						path: "/api/proof/records",
					},
					label: "Create proof record",
					targetFrom: "id",
				},
				entity: { anchor: "record", idKey: "record_id" },
				itemActions: [
					{
						http: {
							body: { record_id: "{{item.id}}" },
							method: "POST",
							path: "/api/proof/records/{{item.id}}/archive",
						},
						id: "archive-record",
						label: "Archive proof record",
					},
				],
				itemTarget: "/proof/records/{{item.id}}",
				source: {
					http: { path: "/api/proof/records" },
					items: "records",
					map: { id: "id", subtitle: "summary", title: "name" },
				},
			},
		},
	],
	slash_commands: [],
	store_tabs: [],
	themes: [],
	turn_hooks: [],
	views: [],
	widget_apps: [],
};

function channelConfig(
	id: string,
	name: string,
	input: Partial<ChannelInput> = {}
) {
	return {
		agentId: null,
		channelType: "telegram",
		createdAt: "2026-01-01T00:00:00.000Z",
		createdBy: "proof-user",
		credentialSource: "customer",
		enabled: true,
		groupAllowlist: [],
		groupPolicy: "allowlist",
		groupReplyMode: "mentions",
		groupUserAllowlist: [],
		id,
		lifecycleReactions: false,
		managedBotId: null,
		managedBotUsername: null,
		managedProvisioningState: null,
		model: null,
		name,
		organizationId: null,
		proactiveOpening: false,
		proactiveTarget: null,
		profileDescription: null,
		profileName: null,
		profileShortBio: null,
		provisionedServerId: null,
		publishCommands: false,
		reactionLearning: undefined,
		richText: true,
		secrets: { bot_token: "***" },
		sendReadReceipts: false,
		streaming: false,
		systemPrompt: null,
		teamId: null,
		threadReplies: false,
		typingIndicator: false,
		updatedAt: "2026-01-01T00:00:00.000Z",
		voiceReply: "never",
		...input,
	};
}

async function installLocalApiFixture(
	page: Page,
	options?: { failChannelCreateOnce?: boolean }
): Promise<ApiFixture> {
	const fixture: ApiFixture = {
		calendarEnabled: false,
		channels: [channelConfig("channel-proof", "Proof Telegram")],
		identities: [{ connections: [], profile_id: "proof-profile" }],
		spaces: [
			{
				created_at: 1_700_000_000_000,
				description: "Local sidebar proof space",
				document_count: 1,
				icon: null,
				id: "space-proof",
				name: "Proof space",
				retrieval_mode: "vector",
				system: false,
				updated_at: 1_700_000_000_000,
				visibility: "private",
			},
		],
		failChannelCreateOnce: options?.failChannelCreateOnce ?? false,
		failSpaceCreateOnce: false,
		failSkillReadCount: 0,
		failFolderCreateOnce: false,
		failFolderCloneOnce: false,
		requests: [],
	};
	await page.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.pathname.startsWith("/api/")) {
			let body: SidebarProofJson = null;
			try {
				body = sidebarProofJsonSchema.parse(request.postDataJSON());
			} catch {
				body = null;
			}
			fixture.requests.push({
				body,
				method: request.method(),
				path: url.pathname,
			});

			// Better Auth's signed-out response is null, never an empty session object.
			if (
				url.pathname === "/api/auth/get-session" &&
				request.method() === "GET"
			) {
				if (
					request.headers().authorization !==
					"Bearer local-app-sidebar-proof-token"
				) {
					return await route.fulfill(jsonResponse(null));
				}
				return await route.fulfill(
					jsonResponse({
						session: {
							id: "sidebar-proof-session",
							token: "local-app-sidebar-proof-token",
							userId: "sidebar-proof-user",
							expiresAt: "2050-01-01T00:00:00.000Z",
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:00.000Z",
						},
						user: {
							id: "sidebar-proof-user",
							email: "sidebar-proof@example.test",
							name: "Sidebar proof",
							image: null,
							emailVerified: true,
							isAnonymous: false,
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:00.000Z",
						},
					})
				);
			}

			if (url.pathname === "/api/control-plane/orgs") {
				return await route.fulfill(jsonResponse({ organizations: [] }));
			}

			if (url.pathname === "/api/conversations" && request.method() === "GET") {
				return await route.fulfill(
					jsonResponse({
						conversations: [
							{
								agent_id: null,
								branch: null,
								created_at: 1_700_000_000_000,
								folder_path: null,
								id: "chat-loose",
								last_message: "Latest proof update",
								last_message_at: 1_700_000_000_100,
								last_message_role: "assistant",
								message_count: 2,
								participants: [],
								run_status: "idle",
								title: "Proof chat",
								updated_at: 1_700_000_000_100,
								worktree_path: null,
							},
							{
								agent_id: "agent-alpha",
								branch: null,
								created_at: 1_700_000_000_000,
								folder_path: null,
								id: "chat-agent-alpha",
								last_message: "Agent thread preview",
								last_message_at: 1_700_000_000_200,
								last_message_role: "assistant",
								message_count: 1,
								participants: [],
								run_status: "idle",
								title: "Agent chat",
								updated_at: 1_700_000_000_200,
								worktree_path: null,
							},
							{
								agent_id: null,
								branch: null,
								created_at: 1_700_000_000_000,
								folder_path: null,
								id: "chat-group-alpha",
								last_message: "Group conversation update",
								last_message_at: 1_700_000_000_300,
								last_message_role: "assistant",
								message_count: 1,
								participants: ["agent-alpha", "agent-beta"],
								run_status: "idle",
								title: "Group proof chat",
								updated_at: 1_700_000_000_300,
								worktree_path: null,
							},
						],
					})
				);
			}
			if (url.pathname === "/api/plugins/contributions") {
				return await route.fulfill(jsonResponse(EMPTY_CONTRIBUTIONS));
			}
			if (url.pathname === "/api/plugins") {
				const apps = [
					{
						accentColor: null,
						approvedGrants: [],
						builtIn: true,
						category: null,
						channel: "stable",
						companion: null,
						description: "Spaces sidebar proof capability",
						enabled: true,
						external: false,
						icon: "lucide:library",
						iconBackground: null,
						iconDither: null,
						iconPadding: null,
						iconUrl: null,
						id: "@ryu/spaces",
						installed: true,
						installedVersion: "1.0.0",
						layers: [],
						localOnly: true,
						mandatory: true,
						mcpOAuthServers: [],
						name: "Spaces",
						permissionGrants: [],
						requires: null,
						runnables: [],
						sidecarName: null,
						stability: "stable",
						suppressedBySafeMode: false,
						surfaceSupport: [],
						tagline: "Spaces local fixture",
						targets: [],
						tier: "core",
						version: "1.0.0",
						windowsFirst: false,
					},
					{
						accentColor: null,
						approvedGrants: [],
						builtIn: false,
						category: "Proof",
						channel: "stable",
						companion: null,
						description: "Local proof plugin",
						enabled: true,
						external: false,
						icon: "lucide:plug",
						iconBackground: null,
						iconDither: null,
						iconPadding: null,
						iconUrl: null,
						id: "proof-plugin",
						installed: true,
						installedVersion: "1.0.0",
						layers: [],
						localOnly: true,
						mandatory: false,
						mcpOAuthServers: [],
						name: "Proof Plugin",
						permissionGrants: [],
						requires: null,
						runnables: [],
						sidecarName: null,
						stability: "stable",
						suppressedBySafeMode: false,
						surfaceSupport: [],
						tagline: "Plugin route fixture",
						targets: [],
						tier: "third_party",
						version: "1.0.0",
						windowsFirst: false,
					},
				];
				if (fixture.calendarEnabled) {
					apps.push({
						accentColor: null,
						approvedGrants: [],
						builtIn: true,
						category: null,
						channel: "stable",
						companion: null,
						description: "Local scheduling proof capability",
						enabled: true,
						external: false,
						icon: "lucide:calendar",
						iconBackground: null,
						iconDither: null,
						iconPadding: null,
						iconUrl: null,
						id: "@ryu/calendar",
						installed: true,
						installedVersion: "1.0.0",
						layers: [],
						localOnly: true,
						mandatory: true,
						mcpOAuthServers: [],
						name: "Calendar",
						permissionGrants: [],
						requires: null,
						runnables: [],
						sidecarName: null,
						stability: "stable",
						suppressedBySafeMode: false,
						surfaceSupport: [],
						tagline: "Scheduling fixture",
						targets: [],
						tier: "core",
						version: "1.0.0",
						windowsFirst: false,
					});
				}
				return await route.fulfill(jsonResponse({ apps }));
			}
			if (url.pathname === "/api/agents") {
				return await route.fulfill(
					jsonResponse({
						agents: [
							{ id: "agent-alpha", name: "Agent Alpha", title: "Researcher" },
							{ id: "agent-beta", name: "Agent Beta", title: "Writer" },
						],
					})
				);
			}
			if (
				url.pathname === "/api/agents/agent-alpha/threads" &&
				request.method() === "GET"
			) {
				return await route.fulfill(
					jsonResponse({
						engine: "claude-code",
						supported: true,
						threads: [
							{
								cwd: "/Users/proof/Project Alpha",
								engine: "claude-code",
								git_branch: "proof/import-thread",
								id: "native-thread-proof",
								message_count: 3,
								title: "Imported proof thread",
								updated_at: 1_700_000_000_500,
							},
						],
					})
				);
			}
			if (
				url.pathname === "/api/agents/agent-alpha/threads/import" &&
				request.method() === "POST"
			) {
				return await route.fulfill(
					jsonResponse(
						{
							already_imported: false,
							conversation_id: "conversation-imported-proof",
							cwd: "/Users/proof/Project Alpha",
							dry_run: false,
							message_count: 3,
							messages_added: 3,
							title: "Imported proof thread",
							truncated: false,
							would_create: true,
						},
						201
					)
				);
			}
			if (url.pathname === "/api/catalog") {
				return await route.fulfill(
					jsonResponse({
						sidecars: [
							{
								category: "provider",
								display_name: "Proof Engine",
								install_state: "installed",
								name: "proof-engine",
								platforms: [],
								supported: true,
								installed_version: "1.0.0",
								latest_version: "1.0.0",
							},
							{
								category: "voice",
								display_name: "Proof Voice",
								install_state: "installed",
								name: "proof-voice",
								platforms: [],
								supported: true,
								installed_version: "1.0.0",
								latest_version: "1.0.0",
							},
						],
					})
				);
			}
			if (url.pathname === "/api/engine/active") {
				return await route.fulfill(
					jsonResponse({
						active: "proof-engine",
						available: ["proof-engine"],
						running: true,
					})
				);
			}
			if (url.pathname === "/api/sidecar/status") {
				return await route.fulfill(
					jsonResponse({ sidecars: [{ name: "proof-voice", running: true }] })
				);
			}
			if (url.pathname === "/api/mcp/servers") {
				return await route.fulfill(
					jsonResponse({ servers: [{ name: "Proof MCP", enabled: true }] })
				);
			}
			if (url.pathname === "/api/mcp/tools") {
				return await route.fulfill(
					jsonResponse({
						tools: [
							{
								description: "Search fixture documents",
								id: "proof-search",
								input_schema: { type: "object" },
								name: "proof_search",
								server: "Proof MCP",
							},
						],
					})
				);
			}
			if (url.pathname === "/api/identities" && request.method() === "GET") {
				return await route.fulfill(
					jsonResponse({ profiles: fixture.identities })
				);
			}
			if (
				url.pathname === "/api/identities/connections" &&
				request.method() === "POST"
			) {
				const value = sidebarIdentityRequestSchema.parse(body ?? {});
				const connection = {
					created_at: 1_700_000_000_000,
					domain: value.domain ?? "",
					flow_status: "IDLE",
					id: "connection-proof-created",
					last_checked: 1_700_000_000_000,
					profile_id: value.profile_id ?? "",
					source: "manual",
					status: "NEEDS_AUTH",
					updated_at: 1_700_000_000_000,
				} satisfies Connection;
				fixture.identities = [
					...fixture.identities.filter(
						(profile) => profile.profile_id !== connection.profile_id
					),
					{ connections: [connection], profile_id: connection.profile_id },
				];
				return await route.fulfill(jsonResponse({ connection }));
			}
			if (url.pathname === "/api/channels" && request.method() === "GET") {
				return await route.fulfill(
					jsonResponse({ channels: fixture.channels })
				);
			}
			if (url.pathname === "/api/channels" && request.method() === "POST") {
				if (fixture.failChannelCreateOnce) {
					fixture.failChannelCreateOnce = false;
					return await route.fulfill(
						jsonResponse({ message: "Fixture channel create failed" }, 503)
					);
				}
				const value = sidebarChannelRequestSchema.parse(body ?? {});
				const created = channelConfig(
					"channel-proof-created",
					value.name ?? "Created channel",
					sidebarChannelRequestSchema.parse(body)
				);
				created.secrets = { bot_token: "***" };
				fixture.channels = [...fixture.channels, created];
				return await route.fulfill(jsonResponse(created, 201));
			}
			if (url.pathname === "/api/spaces" && request.method() === "GET") {
				return await route.fulfill(jsonResponse({ spaces: fixture.spaces }));
			}
			if (url.pathname === "/api/spaces" && request.method() === "POST") {
				if (fixture.failSpaceCreateOnce) {
					fixture.failSpaceCreateOnce = false;
					return await route.fulfill(
						jsonResponse({ error: "Fixture space create failed" }, 503)
					);
				}
				const created = {
					created_at: 1_700_000_000_400,
					description:
						sidebarCreateSpaceSchema.parse(body)?.description ?? null,
					document_count: 0,
					icon: null,
					id: "space-proof-created",
					name:
						sidebarCreateSpaceSchema.parse(body)?.name ?? "Created proof space",
					retrieval_mode:
						sidebarCreateSpaceSchema.parse(body)?.retrieval_mode ?? "vector",
					system: false,
					updated_at: 1_700_000_000_400,
					visibility:
						sidebarCreateSpaceSchema.parse(body)?.visibility ?? "private",
				};
				fixture.spaces = [...fixture.spaces, created];
				return await route.fulfill(
					jsonResponse(
						{ id: created.id, retrieval_mode: created.retrieval_mode },
						201
					)
				);
			}
			if (
				url.pathname === "/api/spaces/space-proof/visibility" &&
				request.method() === "POST"
			) {
				const visibility =
					sidebarSpaceVisibilitySchema.parse(body)?.visibility ?? "private";
				fixture.spaces = fixture.spaces.map((space) =>
					space.id === "space-proof" ? { ...space, visibility } : space
				);
				return await route.fulfill({ body: "", status: 204 });
			}
			if (url.pathname === "/api/spaces/space-proof/documents") {
				return await route.fulfill(
					jsonResponse({
						documents: [
							{
								chunk_count: 2,
								created_at: 1_700_000_000_100,
								id: "doc-proof-page",
								kind: "page",
								space_id: "space-proof",
								title: "Proof page",
								updated_at: 1_700_000_000_200,
							},
						],
					})
				);
			}
			if (
				url.pathname === "/api/spaces/space-proof/documents/doc-proof-page/icon"
			) {
				return await route.fulfill(
					jsonResponse({ icon: sidebarIconRequestSchema.parse(body)?.icon })
				);
			}
			if (url.pathname === "/api/workspace/list") {
				const requested = url.searchParams.get("path");
				if (requested === "::this-pc") {
					return await route.fulfill(
						jsonResponse({ error: "This node is not Windows" }, 404)
					);
				}
				const path = requested ?? "/Users/proof";
				return await route.fulfill(
					jsonResponse({
						entries:
							path === "/Users/proof"
								? [{ name: "Documents", path: "/Users/proof/Documents" }]
								: path === "/Users/proof/Documents"
									? [{ name: "Ryu", path: "/Users/proof/Documents/Ryu" }]
									: [],
						home: "/Users/proof",
						parent: path === "/Users/proof" ? null : "/Users/proof",
						path,
					})
				);
			}
			if (
				url.pathname === "/api/workspace/new-folder" &&
				request.method() === "POST"
			) {
				if (fixture.failFolderCreateOnce) {
					fixture.failFolderCreateOnce = false;
					return await route.fulfill(
						jsonResponse({ error: "Fixture project folder collision" }, 409)
					);
				}
				const name =
					sidebarNewFolderSchema.parse(body)?.name ?? "Proof project";
				return await route.fulfill(
					jsonResponse({ path: `/Users/proof/Documents/Ryu/${name}` }, 201)
				);
			}
			if (
				url.pathname === "/api/workspace/clone" &&
				request.method() === "POST"
			) {
				if (fixture.failFolderCloneOnce) {
					fixture.failFolderCloneOnce = false;
					return await route.fulfill(
						jsonResponse({ error: "Fixture clone failed" }, 503)
					);
				}
				const value = sidebarCloneFolderSchema.parse(body ?? {});
				const name = value.name || "proof-repo";
				return await route.fulfill(
					jsonResponse(
						{ name, path: `/Users/proof/Documents/Ryu/${name}` },
						201
					)
				);
			}
			if (url.pathname === "/api/import/scan" && request.method() === "POST") {
				return await route.fulfill(
					jsonResponse({
						items: [
							{
								already_exists: false,
								detail: "CLAUDE.md",
								id: "proof-instructions",
								kind: "instructions",
								title: "Proof instructions",
							},
							{
								already_exists: false,
								id: "proof-skill-import",
								kind: "skill",
								title: "Proof imported skill",
							},
						],
						root:
							sidebarImportScanSchema.parse(body)?.path ??
							"/Users/proof/.claude",
						warnings: [],
					})
				);
			}
			if (url.pathname === "/api/import/run" && request.method() === "POST") {
				return await route.fulfill(
					jsonResponse({
						results: [
							{
								already_exists: false,
								folder_path: "/Users/proof/Imported instructions",
								id: "proof-instructions",
								kind: "instructions",
								status: "imported",
								title: "Proof instructions",
							},
						],
						root:
							sidebarImportRunSchema.parse(body)?.path ??
							"/Users/proof/.claude",
					})
				);
			}
			if (url.pathname === "/api/composio/status") {
				return await route.fulfill(jsonResponse({ configured: true }));
			}
			if (url.pathname === "/api/composio/connections") {
				return await route.fulfill(
					jsonResponse({
						data: [
							{
								active: true,
								id: "integration-proof",
								status: "ACTIVE",
								toolkit: "proof-mail",
							},
						],
					})
				);
			}
			if (url.pathname === "/api/composio/toolkits") {
				return await route.fulfill(
					jsonResponse({
						data: [{ logo: null, name: "Proof Mail", slug: "proof-mail" }],
					})
				);
			}
			if (url.pathname === "/api/skills") {
				if (fixture.failSkillReadCount > 0) {
					fixture.failSkillReadCount -= 1;
					return await route.fulfill(
						jsonResponse({ message: "Fixture skill read failed" }, 503)
					);
				}
				return await route.fulfill(
					jsonResponse({
						skills: [{ enabled: true, id: "proof-skill", name: "Proof skill" }],
					})
				);
			}
			if (url.pathname === "/api/proof/records" && request.method() === "GET") {
				return await route.fulfill(
					jsonResponse({
						records: [
							{
								id: "proof-record-a",
								name: "Proof record A",
								summary: "First fixture record",
							},
							{
								id: "proof-record-b",
								name: "Proof record B",
								summary: "Second fixture record",
							},
						],
					})
				);
			}
			if (
				url.pathname === "/api/proof/records" &&
				request.method() === "POST"
			) {
				return await route.fulfill(
					jsonResponse(
						{ id: "proof-record-created", name: "Created proof record" },
						201
					)
				);
			}
			if (url.pathname === "/api/proof/records/proof-record-a/archive") {
				return await route.fulfill(jsonResponse({ archived: true }));
			}
			return await route.fulfill(jsonResponse({}));
		}
		if (url.hostname === "api.iconify.design") {
			if (url.pathname.endsWith("/search")) {
				return await route.fulfill(jsonResponse({ icons: ["lucide:folder"] }));
			}
			if (url.pathname.endsWith("/collection")) {
				return await route.fulfill(jsonResponse({ uncategorized: ["folder"] }));
			}
			return await route.fulfill({
				body: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
				contentType: "image/svg+xml",
				status: 200,
			});
		}
		const harnessOrigin = new URL(
			process.env.RYU_SIDEBAR_PROOF_ORIGIN ??
				test.info().project.use.baseURL ??
				"http://127.0.0.1:5452"
		).origin;
		if (url.origin === harnessOrigin) {
			return await route.continue();
		}
		return await route.abort();
	});
	return fixture;
}

function fixtureFor(page: Page): ApiFixture {
	const fixture = fixtures.get(page);
	if (!fixture) {
		throw new Error("AppSidebar API fixture was not installed");
	}
	return fixture;
}

function tabs(page: Page) {
	return page
		.getByTestId("tab-state")
		.evaluate((element) => JSON.parse(element.textContent ?? "{}"))
		.then(sidebarTabSnapshotSchema.parse);
}

async function activeTabPath(page: Page): Promise<string | undefined> {
	const state = await tabs(page);
	return state.tabs.find((tab) => tab.id === state.activeTabId)?.path;
}

async function openGlobalContextMenu(page: Page) {
	// The real ContextMenuTrigger wraps SidebarContent. Right-click a rendered
	// section header inside it so the event bubbles through the production wrapper.
	const preferredTarget = page.locator("#sidebar-sec-agents");
	const fallbackTarget = page.locator("[data-sidebar='group']").first();
	await expect(preferredTarget.or(fallbackTarget).first()).toBeVisible();
	let target = preferredTarget;
	if ((await target.count()) === 0) {
		target = fallbackTarget;
	}
	if ((await target.count()) === 0) {
		const rendered = await page.evaluate(() =>
			Array.from(
				document.querySelectorAll("[data-sidebar='group']"),
				(element) => ({
					id: element.id,
					rect: element.getBoundingClientRect().toJSON(),
					text: element.textContent?.slice(0, 80),
				})
			)
		);
		throw new Error(
			`No visible sidebar section for global menu: ${JSON.stringify(rendered)}`
		);
	}
	await target.scrollIntoViewIfNeeded();
	const bounds = await target.boundingBox();
	if (!bounds) {
		throw new Error("The production sidebar section surface did not render");
	}
	await page.mouse.click(bounds.x + 10, bounds.y + 10, {
		button: "right",
	});
	const menus = page.locator('[data-slot="context-menu-content"]:visible');
	await expect(menus.last()).toBeVisible();
	return menus.last();
}

async function openRowContextMenu(page: Page, rowName: string) {
	const row = page.getByRole("button", { name: rowName }).first();
	await row.click({ button: "right", force: true });
	const menus = page.locator('[data-slot="context-menu-content"]:visible');
	await expect(menus.last()).toBeVisible();
	return menus.last();
}

async function openSectionRowContextMenu(
	page: Page,
	sectionKey: string,
	rowName: string
) {
	const row = page
		.locator(`#sidebar-sec-${sectionKey}`)
		.getByRole("button", { name: rowName })
		.last();
	await row.click({ button: "right", force: true });
	const menus = page.locator('[data-slot="context-menu-content"]:visible');
	await expect(menus.last()).toBeVisible();
	return menus.last();
}

async function openChromeContextMenu(page: Page, buttonName: string) {
	const button = page
		.getByTestId("sidebar-header-actions")
		.getByRole("button", { name: buttonName, exact: true })
		.last();
	await expect(button).toBeVisible();
	await button.click({ button: "right", force: true });
	const menus = page.locator('[data-slot="context-menu-content"]:visible');
	await expect(menus.last()).toBeVisible();
	return menus.last();
}

async function storageValue(page: Page, key: string) {
	return page.evaluate((storageKey) => localStorage.getItem(storageKey), key);
}

test.beforeEach(async ({ page }) => {
	const unexpectedErrors: string[] = [];
	unexpectedBrowserErrors.set(page, unexpectedErrors);
	const nativeCalls: Array<{ command: string; args: unknown }> = [];
	nativeRequestLedger.set(page, nativeCalls);
	unexpectedHttpRequests.set(page, []);
	await page.exposeBinding(
		"__SIDEBAR_NATIVE_LEDGER__",
		(_source, call: { command: string; args: unknown }) => {
			nativeCalls.push(call);
		}
	);
	await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
	await page.setViewportSize({ width: 1440, height: 1000 });
	page.on("pageerror", (error) => {
		unexpectedErrors.push(error.message);
		console.error("AppSidebar proof page error:", error);
	});
	page.on("console", (message) => {
		if (message.type() === "error") {
			if (
				!EXPECTED_OPTIONAL_RESOURCE_URLS.has(message.location().url) ||
				message.text() !== "Failed to load resource: net::ERR_FAILED"
			) {
				unexpectedErrors.push(`${message.location().url}: ${message.text()}`);
			}
			console.error(
				"AppSidebar proof browser error:",
				message.text(),
				JSON.stringify(message.location())
			);
		}
	});
	page.on("requestfailed", (request) => {
		if (
			!EXPECTED_OPTIONAL_RESOURCE_URLS.has(request.url()) ||
			request.failure()?.errorText !== "net::ERR_FAILED"
		) {
			unexpectedErrors.push(
				`${request.url()}: ${request.failure()?.errorText}`
			);
		}
		console.error(
			"AppSidebar proof failed resource:",
			request.method(),
			request.url(),
			request.failure()?.errorText
		);
	});
	await page.addInitScript(() => {
		if (location.protocol === "about:") {
			return;
		}
		const search = new URLSearchParams(location.search);
		const bootKey = "proof:app-sidebar-interactions-booted";
		const bootSeed = location.pathname + location.search;
		if (sessionStorage.getItem(bootKey) !== bootSeed) {
			localStorage.clear();
			const sections = [
				"tabs",
				"agents",
				"spaces",
				"channels",
				"integrations",
				"identities",
				"skills",
				"mcp",
				"tools",
				"plugins",
				"companions",
				"engines",
				"pinned",
				"projects",
				"chats",
				"archived",
			];
			const focus = search.get("focus");
			const visible = new Set(
				focus === null ? sections : focus === "none" ? [] : focus.split(",")
			);
			const defaultHiddenSections = [
				"channels",
				"integrations",
				"identities",
				"skills",
				"mcp",
				"tools",
				"engines",
				"plugins",
			];
			localStorage.setItem(
				"ryu:sidebar-hidden-seeded",
				JSON.stringify(defaultHiddenSections)
			);
			localStorage.setItem("ryu:sidebar-hidden-chrome-seeded", "[]");
			localStorage.setItem(
				"ryu:sidebar-hidden-sections",
				JSON.stringify(sections.filter((section) => !visible.has(section)))
			);
			localStorage.setItem(
				"ryu:sidebar-hidden-chrome",
				JSON.stringify(["node-selector", "logo"])
			);
			localStorage.setItem(
				"ryu:sidebar-mode",
				search.get("mode") ?? "sections"
			);
			if (search.get("session") === "main") {
				localStorage.setItem("ryu_startup_behavior", "restore");
			}
			localStorage.setItem("ryu:product-mode", "console");
			localStorage.setItem("ryu:interface-level", "expert");
			localStorage.setItem("ryu_tab_layout", "vertical");
			localStorage.setItem("ryu:notification-layout", "unified");
			localStorage.setItem("ryu:agent-row-style", "compact");
			if (search.get("auth") !== "off") {
				localStorage.setItem(
					"ryu_session_token",
					"local-app-sidebar-proof-token"
				);
			}
			localStorage.setItem("ryu:sidebar-overflow-popover", "false");
			localStorage.setItem(
				"ryu_tab_open_behavior",
				search.get("behavior") === "current" ? "current" : "new"
			);
			localStorage.setItem(
				"ryu:sidebar-grouped-nav",
				search.get("grouped") === "off" ? "false" : "true"
			);
			localStorage.setItem(
				"ryu:sidebar-section-page-sizes",
				JSON.stringify({ channels: 10, identities: 10, skills: 10 })
			);
			sessionStorage.setItem(bootKey, bootSeed);
		}

		const proofWindow = window;
		const proofState: SidebarProofState = {
			callbackId: 0,
			nativeCalls: [],
			quickPreviewId: null,
			quickReplyId: null,
		};
		proofWindow.__APP_SIDEBAR_PROOF__ = proofState;
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: {
				invoke: async (command: string, args?: InvokeArgs) => {
					proofState.nativeCalls.push({ args: args ?? null, command });
					await (window as ProofWindow).__SIDEBAR_NATIVE_LEDGER__?.({
						args: args ?? null,
						command,
					});
					if (command === "plugin:app|version") {
						if (
							args !== undefined &&
							(args === null ||
								typeof args !== "object" ||
								Array.isArray(args) ||
								Object.keys(args).length !== 0)
						) {
							throw new Error("Unexpected app version native arguments");
						}
						return "0.0.0";
					}
					if (command === "plugin:event|listen") {
						return 1;
					}
					if (command === "plugin:event|unlisten") {
						return undefined;
					}
					if (command === "open_tab_window") {
						return { accepted: true };
					}
					return undefined;
				},
				transformCallback: () => {
					proofState.callbackId += 1;
					return proofState.callbackId;
				},
			},
		});
	});
	fixtures.set(page, await installLocalApiFixture(page));
});

test.afterEach(async ({ page }, testInfo) => {
	const ledgerPath = testInfo.outputPath(
		"sidebar-request-and-error-ledgers.json"
	);
	await writeFile(
		ledgerPath,
		JSON.stringify(
			{
				http: fixtures.get(page)?.requests ?? [],
				unexpectedHttp: unexpectedHttpRequests.get(page) ?? [],
				native: nativeRequestLedger.get(page) ?? [],
				browserErrors: unexpectedBrowserErrors.get(page) ?? [],
			},
			null,
			2
		),
		"utf8"
	);
	await testInfo.attach("sidebar-request-and-error-ledgers", {
		path: ledgerPath,
		contentType: "application/json",
	});
});

test("mounts the production AppSidebar with stateful local Core fixtures", async ({
	page,
}) => {
	const channelRead = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === "/api/channels" &&
			response.request().method() === "GET" &&
			response.ok()
	);
	await page.goto(
		`${STORY_URL}?focus=channels,agents,chats,integrations,identities,skills,mcp,tools,plugins,engines&seed=${Date.now()}`
	);
	await channelRead;
	try {
		await expect(page.getByTestId("tab-state")).toBeVisible();
	} catch (error) {
		throw new Error(
			"AppSidebar proof did not mount: " +
				(await page.locator("body").innerText()),
			{ cause: error }
		);
	}

	await expect(page.getByTestId("chat-state")).toContainText("chat-loose");
	await expect(page.getByText("Proof Telegram", { exact: true })).toBeVisible();
	const sidebarText = await page.getByTestId("app-sidebar-mount").innerText();
	if (!sidebarText.includes("Proof Telegram")) {
		const storage = await page.evaluate(() => ({
			hiddenChrome: localStorage.getItem("ryu:sidebar-hidden-chrome"),
			hiddenSections: localStorage.getItem("ryu:sidebar-hidden-sections"),
			mode: localStorage.getItem("ryu:sidebar-mode"),
			productMode: localStorage.getItem("ryu:product-mode"),
		}));
		throw new Error(
			"Channel fixture did not render: " +
				JSON.stringify({
					requests: fixtureFor(page).requests.map((request) => ({
						method: request.method,
						path: request.path,
					})),
					storage,
					sidebarText,
				})
		);
	}
	await expect(page.getByText("Proof Telegram", { exact: true })).toBeVisible();
	await expect(page.getByText("Proof skill", { exact: true })).toBeVisible();
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-populated-sections.png`,
		animations: "disabled",
	});
	expect(fixtureFor(page).requests.length).toBeGreaterThan(0);
});

test("production sidebar proof fixture is reachable", async ({ page }) => {
	await page.goto(`${STORY_URL}?seed=${Date.now()}`);
	await expect(page.getByTestId("tab-state")).toBeVisible();
});

test("sidebar-wide mode, appearance, tab view, and collapse actions persist through real context menu", async ({
	page,
}) => {
	const channelRead = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === "/api/channels" &&
			response.request().method() === "GET" &&
			response.ok()
	);
	await page.goto(
		`${STORY_URL}?focus=tabs,agents,chats,channels,skills,plugin:proof-app:proof-records&seed=${Date.now()}`
	);
	await channelRead;
	await expect(page.getByText("Proof Telegram", { exact: true })).toBeVisible();

	const initialTabs = await tabs(page);
	await page.getByRole("button", { name: "New tab", exact: true }).click();
	await expect
		.poll(async () => (await tabs(page)).tabs.length)
		.toBe(initialTabs.tabs.length + 1);
	await expect.poll(() => activeTabPath(page)).toBe("/chat");

	let menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitem", { name: "Tabbed sidebar" }).click();
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-mode"))
		.toBe("tabbed");
	const sectionTabs = page.getByRole("tablist", { name: "Sidebar sections" });
	await expect(sectionTabs).toBeVisible();
	await sectionTabs.getByRole("tab", { name: "Channels", exact: true }).click();
	await expect(page.getByText("Proof Telegram", { exact: true })).toBeVisible();
	await expect(
		sectionTabs.getByRole("tab", { name: "Channels", exact: true })
	).toHaveAttribute("aria-selected", "true");

	menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitem", { name: "Agents view" }).click();
	await expect.poll(() => storageValue(page, "ryu:sidebar-mode")).toBe("agent");
	await expect(page.getByText("Agent Alpha", { exact: true })).toBeVisible();
	await expect(
		page.getByTestId("agent-chat-preview-agent-alpha")
	).toBeVisible();

	menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitem", { name: "Floating" }).click();
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-variant"))
		.toBe("floating");
	menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitem", { name: "Inset" }).click();
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-variant"))
		.toBe("inset");

	menu = await openGlobalContextMenu(page);
	await menu
		.getByRole("menuitemcheckbox", { name: "Group lists by date" })
		.click();
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-group-chats-by-date"))
		.toBe("true");
	menu = await openGlobalContextMenu(page);
	await menu
		.getByRole("menuitemcheckbox", { name: "Projects & Spaces as pickers" })
		.click();
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-grouped-nav"))
		.toBe("false");
	menu = await openGlobalContextMenu(page);
	await menu
		.getByRole("menuitemcheckbox", { name: "Show latest message / tool state" })
		.click();
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-chat-preview"))
		.toBe("true");
	menu = await openGlobalContextMenu(page);
	await menu
		.getByRole("menuitemcheckbox", {
			name: "Search section overflow in a popover",
		})
		.click();
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-overflow-popover"))
		.toBe("true");

	menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitemradio", { name: "Infinite canvas" }).click();
	await expect.poll(() => storageValue(page, "ryu_tab_layout")).toBe("canvas");
	menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitemradio", { name: "Vertical tabs" }).click();
	await expect
		.poll(() => storageValue(page, "ryu_tab_layout"))
		.toBe("vertical");

	menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitem", { name: "Sections", exact: true }).click();
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-mode"))
		.toBe("sections");

	const sectionOrderBefore = sidebarStringsSchema.parse(
		await page.evaluate(() =>
			JSON.parse(localStorage.getItem("ryu:sidebar-section-order") ?? "[]")
		)
	);
	await page
		.locator("#sidebar-sec-tabs")
		.getByRole("button", { name: "Tabs", exact: true })
		.dragTo(page.locator("#sidebar-sec-channels"));
	const sectionOrderAfter = sidebarStringsSchema.parse(
		await page.evaluate(() =>
			JSON.parse(localStorage.getItem("ryu:sidebar-section-order") ?? "[]")
		)
	);
	expect(sectionOrderAfter.indexOf("tabs")).toBeGreaterThan(
		sectionOrderBefore.indexOf("tabs")
	);
	expect(sectionOrderAfter.indexOf("tabs")).toBeGreaterThan(
		sectionOrderAfter.indexOf("channels")
	);

	await page
		.locator("#sidebar-sec-channels")
		.getByRole("button", { name: "Channels", exact: true })
		.click();
	await expect(page.getByText("Proof Telegram", { exact: true })).toBeHidden();
	menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitem", { name: "Expand all sections" }).click();
	await expect(page.getByText("Proof Telegram", { exact: true })).toBeVisible();
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-expanded-sections.png`,
		animations: "disabled",
	});

	menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitem", { name: "Collapse all sections" }).click();
	await expect(page.getByText("Proof Telegram", { exact: true })).toBeHidden();
	menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitem", { name: "Customize sidebar" }).click();
	const customize = page.getByRole("dialog", { name: "Customize sidebar" });
	await expect(customize).toBeVisible();
	const agentVisibility = customize
		.getByText("Agents", { exact: true })
		.locator("xpath=../..");
	await agentVisibility.getByRole("button", { name: "Hide section" }).click();
	await expect
		.poll(async () => {
			const hidden = await storageValue(page, "ryu:sidebar-hidden-sections");
			return sidebarStringsSchema.parse(JSON.parse(hidden ?? "[]"));
		})
		.toContain("agents");
	await expect(
		agentVisibility.getByRole("button", { name: "Show section" })
	).toBeVisible();
	await agentVisibility.getByRole("button", { name: "Show section" }).click();
	await expect
		.poll(async () => {
			const hidden = await storageValue(page, "ryu:sidebar-hidden-sections");
			return sidebarStringsSchema.parse(JSON.parse(hidden ?? "[]"));
		})
		.not.toContain("agents");
	await customize.getByRole("button", { name: "Done" }).click();

	await page.reload();
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-mode"))
		.toBe("sections");
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-variant"))
		.toBe("inset");
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-group-chats-by-date"))
		.toBe("true");
	await expect(page.getByTestId("tab-state")).toContainText("/chat");
});

test("sidebar-wide Reset restores the default order, visibility, and section controls", async ({
	page,
}) => {
	await page.goto(`${STORY_URL}?focus=tabs,chats,agents&seed=${Date.now()}`);
	await expect(
		page.getByTestId("sidebar-header-actions").getByRole("button", {
			name: "Proof home",
			exact: true,
		})
	).toBeVisible();
	const headerLabels = async () =>
		(
			await page
				.getByTestId("sidebar-header-actions")
				.locator("button")
				.allTextContents()
		).map((label) => label.trim());
	const defaultHeaderLabels = await headerLabels();
	await page.evaluate(
		({ defaultSectionOrder }) => {
			localStorage.setItem(
				"ryu:sidebar-section-order",
				JSON.stringify([...defaultSectionOrder].reverse())
			);
			localStorage.setItem(
				"ryu:sidebar-chrome-order",
				JSON.stringify(["store", "share", "compute", "library", "new-chat"])
			);
			localStorage.setItem("ryu:sidebar-hidden-sections", '["channels"]');
			localStorage.setItem(
				"ryu:sidebar-hidden-chrome",
				'["new-chat","library"]'
			);
			localStorage.setItem("ryu:sidebar-section-page-sizes", '{"chats":5}');
			localStorage.setItem("ryu:sidebar-section-sorts", '{"chats":"name-asc"}');
		},
		{ defaultSectionOrder: DEFAULT_SECTION_ORDER }
	);
	await page.reload();
	await expect(
		page.getByTestId("sidebar-header-actions").getByRole("button", {
			name: "New chat",
			exact: true,
		})
	).toHaveCount(0);

	const menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitem", { name: "Reset sidebar layout" }).click();
	await expect
		.poll(async () =>
			JSON.parse(
				(await storageValue(page, "ryu:sidebar-section-order")) ?? "[]"
			)
		)
		.toEqual(DEFAULT_SECTION_ORDER);
	await expect
		.poll(async () =>
			JSON.parse(
				(await storageValue(page, "ryu:sidebar-hidden-sections")) ?? "[]"
			)
		)
		.toEqual(DEFAULT_PROOF_HIDDEN_SECTIONS);
	await expect
		.poll(async () =>
			JSON.parse(
				(await storageValue(page, "ryu:sidebar-hidden-chrome")) ?? "[]"
			)
		)
		.toEqual(DEFAULT_PROOF_HIDDEN_CHROME);
	await expect
		.poll(async () =>
			JSON.parse(
				(await storageValue(page, "ryu:sidebar-section-page-sizes")) ?? "{}"
			)
		)
		.toEqual({});
	await expect
		.poll(async () =>
			JSON.parse(
				(await storageValue(page, "ryu:sidebar-section-sorts")) ?? "{}"
			)
		)
		.toEqual({});
	await expect(
		page.getByTestId("sidebar-header-actions").getByRole("button", {
			name: "New chat",
			exact: true,
		})
	).toBeVisible();
	await expect(
		page.getByTestId("sidebar-header-actions").getByRole("button", {
			name: "Library",
			exact: true,
		})
	).toBeVisible();
	await expect.poll(headerLabels).toEqual(defaultHeaderLabels);
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-reset-layout.png`,
		animations: "disabled",
	});
});

test("header navigation context menus open routes and windows, reorder and hide buttons, and restore visibility", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=tabs,channels&auth=off&mode=sections&seed=${Date.now()}`
	);
	const libraryButton = page
		.getByTestId("sidebar-header-actions")
		.getByRole("button", { name: "Library", exact: true });
	await expect(libraryButton).toBeVisible();
	await page.getByRole("button", { name: "Library", exact: true }).click();
	await expect.poll(() => activeTabPath(page)).toBe("/library");

	let menu = await openChromeContextMenu(page, "Library");
	await menu
		.getByRole("menuitem", { name: "Open in new tab", exact: true })
		.click();
	await expect
		.poll(async () => {
			const state = await tabs(page);
			return state.tabs.filter((tab) => tab.path === "/library").length;
		})
		.toBe(2);

	menu = await openChromeContextMenu(page, "Library");
	await menu
		.getByRole("menuitem", { name: "Open in new window", exact: true })
		.click();
	let nativeCalls = await page.evaluate(
		() =>
			/* SAFETY: app-sidebar-interactions-proof.spec.ts installs __APP_SIDEBAR_PROOF__ before this proof page is evaluated. */ window
				.__APP_SIDEBAR_PROOF__?.nativeCalls ?? []
	);
	expect(nativeCalls).toContainEqual({
		args: {
			conversationId: null,
			entityKey: null,
			node: null,
			path: "/library",
			title: "Library",
		},
		command: "open_tab_window",
	});

	menu = await openChromeContextMenu(page, "Library");
	await menu.getByRole("menuitem", { name: "Move up", exact: true }).click();
	const chromeOrder = sidebarStringsSchema.parse(
		await page.evaluate(() =>
			JSON.parse(localStorage.getItem("ryu:sidebar-chrome-order") ?? "[]")
		)
	);
	expect(chromeOrder.indexOf("library")).toBeGreaterThan(0);
	expect(chromeOrder.indexOf("library")).toBeLessThan(
		chromeOrder.indexOf("store")
	);

	const headerActions = page.getByTestId("sidebar-header-actions");
	const newChatShell = headerActions
		.getByRole("button", { name: "New chat", exact: true })
		.locator("xpath=../..");
	const computeShell = headerActions
		.getByRole("button", { name: "Compute", exact: true })
		.locator("xpath=../..");
	await expect(newChatShell).toHaveAttribute("draggable", "true");
	await newChatShell.dragTo(computeShell);
	const draggedChromeOrder = sidebarStringsSchema.parse(
		await page.evaluate(() =>
			JSON.parse(localStorage.getItem("ryu:sidebar-chrome-order") ?? "[]")
		)
	);
	expect(draggedChromeOrder.indexOf("new-chat")).toBe(
		draggedChromeOrder.indexOf("compute") + 1
	);

	menu = await openChromeContextMenu(page, "Library");
	await menu
		.getByRole("menuitem", { name: "Hide Library", exact: true })
		.click();
	await expect
		.poll(async () => {
			const hidden = await storageValue(page, "ryu:sidebar-hidden-chrome");
			return sidebarStringsSchema.parse(JSON.parse(hidden ?? "[]"));
		})
		.toContain("library");
	await expect(
		page.getByTestId("sidebar-header-actions").getByRole("button", {
			name: "Library",
			exact: true,
		})
	).toHaveCount(0);

	menu = await openGlobalContextMenu(page);
	await menu
		.getByRole("menuitem", { name: "Customize sidebar", exact: true })
		.click();
	const customize = page.getByRole("dialog", { name: "Customize sidebar" });
	await expect(customize).toBeVisible();
	const libraryRow = customize
		.getByText("Library", { exact: true })
		.locator("xpath=../..");
	await libraryRow.getByRole("button", { name: "Show button" }).click();
	await expect
		.poll(async () => {
			const hidden = await storageValue(page, "ryu:sidebar-hidden-chrome");
			return sidebarStringsSchema.parse(JSON.parse(hidden ?? "[]"));
		})
		.not.toContain("library");
	await customize.getByRole("button", { name: "Done", exact: true }).click();
	await expect(libraryButton).toBeVisible();

	await page
		.getByTestId("sidebar-header-actions")
		.getByRole("button", { name: "New chat", exact: true })
		.click();
	await expect(page.getByTestId("chat-state")).toContainText("sidebar-new-");
	await expect.poll(() => activeTabPath(page)).toBe("/chat");
	nativeCalls = await page.evaluate(
		() =>
			/* SAFETY: app-sidebar-interactions-proof.spec.ts installs __APP_SIDEBAR_PROOF__ before this proof page is evaluated. */ window
				.__APP_SIDEBAR_PROOF__?.nativeCalls ?? []
	);
	expect(
		nativeCalls.filter((call) => call.command === "open_tab_window")
	).toHaveLength(1);
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-header-navigation.png`,
		animations: "disabled",
	});
});

test("all remaining built-in header destinations open exact routes, tabs, and native requests", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=tabs&auth=off&mode=sections&seed=${Date.now()}`
	);
	const routes = [
		["Compute", "/compute"],
		["Share", "/share"],
		["Customize", "/store"],
	] as const;
	for (const [title, path] of routes) {
		const button = page
			.getByTestId("sidebar-header-actions")
			.getByRole("button", { name: title, exact: true });
		await expect(button).toBeVisible();
		await button.click();
		await expect.poll(() => activeTabPath(page)).toBe(path);

		const menu = await openChromeContextMenu(page, title);
		await expect(
			menu.getByRole("menuitem", { name: "Move down", exact: true })
		).toBeVisible();
		if (title === "Compute") {
			const before = (
				await page
					.getByTestId("sidebar-header-actions")
					.locator("button")
					.allTextContents()
			).map((label) => label.trim());
			await menu
				.getByRole("menuitem", { name: "Move down", exact: true })
				.click();
			const after = (
				await page
					.getByTestId("sidebar-header-actions")
					.locator("button")
					.allTextContents()
			).map((label) => label.trim());
			expect(after.indexOf(title), JSON.stringify({ before, after })).toBe(
				before.indexOf(title) + 1
			);
		}
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();

		const newTabMenu = await openChromeContextMenu(page, title);
		const beforeTabs = await tabs(page);
		const beforeCount = beforeTabs.tabs.filter(
			(tab) => tab.path === path
		).length;
		await newTabMenu
			.getByRole("menuitem", { name: "Open in new tab", exact: true })
			.click();
		await expect
			.poll(
				async () =>
					(await tabs(page)).tabs.filter((tab) => tab.path === path).length
			)
			.toBe(beforeCount + 1);
		const newWindowMenu = await openChromeContextMenu(page, title);
		await newWindowMenu
			.getByRole("menuitem", { name: "Open in new window", exact: true })
			.click();
		const nativeCalls = await page.evaluate(
			() =>
				/* SAFETY: app-sidebar-interactions-proof.spec.ts installs __APP_SIDEBAR_PROOF__ before this proof page is evaluated. */ window
					.__APP_SIDEBAR_PROOF__?.nativeCalls ?? []
		);
		expect(nativeCalls).toContainEqual({
			args: {
				conversationId: null,
				entityKey: null,
				node: null,
				path,
				title,
			},
			command: "open_tab_window",
		});
	}

	const newChatMenu = await openChromeContextMenu(page, "New chat");
	await expect(
		newChatMenu.getByRole("menuitem", { name: "Hide New chat", exact: true })
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(newChatMenu).toBeHidden();
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-header-nav-targets.png`,
		animations: "disabled",
	});
});

test("contributed sidebar row, declarative create/action, mode, button route, and native request use exact local fixtures", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=plugin:proof-app:proof-records&auth=off&seed=${Date.now()}`
	);
	await expect(page.getByText("Proof record A", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: /Proof record A/ }).click();
	await expect
		.poll(async () => (await tabs(page)).tabs.at(-1)?.path)
		.toBe("/proof/records/proof-record-a");
	await expect
		.poll(async () => (await tabs(page)).tabs.at(-1)?.title)
		.toBe("Proof record A");
	const recordRow = page
		.getByRole("button", { name: /Proof record A/ })
		.first();
	await recordRow.focus();
	await recordRow.press("Enter");
	await expect
		.poll(() => activeTabPath(page))
		.toBe("/proof/records/proof-record-a");

	const recordMenu = await openRowContextMenu(page, "Proof record A");
	await recordMenu
		.getByRole("menuitem", { name: "Archive proof record", exact: true })
		.click();
	await expect
		.poll(() =>
			fixtureFor(page).requests.some(
				(request) =>
					request.method === "POST" &&
					request.path === "/api/proof/records/proof-record-a/archive" &&
					JSON.stringify(request.body) ===
						JSON.stringify({ record_id: "proof-record-a" })
			)
		)
		.toBe(true);

	const recordPath = "/proof/records/proof-record-a";
	const tabsBeforeNewRecord = await tabs(page);
	const newTabMenu = await openRowContextMenu(page, "Proof record A");
	await newTabMenu
		.getByRole("menuitem", { name: "Open in new tab", exact: true })
		.click();
	await expect
		.poll(
			async () =>
				(await tabs(page)).tabs.filter((tab) => tab.path === recordPath).length
		)
		.toBe(
			tabsBeforeNewRecord.tabs.filter((tab) => tab.path === recordPath).length +
				1
		);
	const newWindowMenu = await openRowContextMenu(page, "Proof record A");
	await newWindowMenu
		.getByRole("menuitem", { name: "Open in new window", exact: true })
		.click();
	const recordNativeCalls = await page.evaluate(
		() =>
			/* SAFETY: app-sidebar-interactions-proof.spec.ts installs __APP_SIDEBAR_PROOF__ before this proof page is evaluated. */ window
				.__APP_SIDEBAR_PROOF__?.nativeCalls ?? []
	);
	expect(recordNativeCalls).toContainEqual({
		args: {
			conversationId: null,
			entityKey: null,
			node: null,
			path: recordPath,
			title: "Proof record A",
		},
		command: "open_tab_window",
	});
	const inspectMenu = await openRowContextMenu(page, "Proof record A");
	await inspectMenu
		.getByRole("menuitem", { name: "Inspect record", exact: true })
		.click();
	expect(fixtureFor(page).requests).toContainEqual({
		body: {
			args: { record_id: "proof-record-a", source: "sidebar" },
			method: "proof.inspect-record",
		},
		method: "POST",
		path: "/api/plugins/proof-app/host",
	});

	await page
		.getByRole("button", { name: "Create proof record", exact: true })
		.click();
	await expect
		.poll(async () => (await tabs(page)).tabs.at(-1)?.path)
		.toBe("/proof/records/proof-record-created");
	expect(
		fixtureFor(page).requests.filter(
			(request) =>
				request.method === "POST" && request.path === "/api/proof/records"
		)
	).toContainEqual({
		body: { name: "Created proof record" },
		method: "POST",
		path: "/api/proof/records",
	});

	let menu = await openGlobalContextMenu(page);
	await menu.getByRole("menuitem", { name: "Proof mode", exact: true }).click();
	await expect
		.poll(() => storageValue(page, "ryu:sidebar-mode"))
		.toBe("plugin:proof-app:proof-mode");
	await expect(
		page.getByRole("button", { name: /Proof record B/ }).first()
	).toBeVisible();

	const proofHome = page.getByRole("button", {
		name: "Proof home",
		exact: true,
	});
	await proofHome.click();
	await expect
		.poll(async () => {
			const state = await tabs(page);
			return state.tabs.find((tab) => tab.id === state.activeTabId)?.path;
		})
		.toBe("/proof/home");
	menu = await openChromeContextMenu(page, "Proof home");
	await menu
		.getByRole("menuitem", { name: "Open in new tab", exact: true })
		.click();
	await expect
		.poll(async () => {
			const state = await tabs(page);
			return state.tabs.find((tab) => tab.id === state.activeTabId)?.path;
		})
		.toBe("/proof/home");
	await expect
		.poll(async () => {
			const state = await tabs(page);
			return state.tabs.filter((tab) => tab.path === "/proof/home").length;
		})
		.toBe(2);

	menu = await openChromeContextMenu(page, "Proof home");
	await menu
		.getByRole("menuitem", { name: "Open in new window", exact: true })
		.click();
	const nativeCalls = await page.evaluate(
		() =>
			/* SAFETY: app-sidebar-interactions-proof.spec.ts installs __APP_SIDEBAR_PROOF__ before this proof page is evaluated. */ window
				.__APP_SIDEBAR_PROOF__?.nativeCalls ?? []
	);
	expect(nativeCalls).toContainEqual({
		args: {
			conversationId: null,
			entityKey: null,
			node: null,
			path: "/proof/home",
			title: "Proof home",
		},
		command: "open_tab_window",
	});

	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-contributed-section.png`,
		animations: "disabled",
	});
});

test("built-in sidebar lists navigate to their real destinations and add controls open their owner flows", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=channels,integrations,identities,skills,mcp,tools,plugins,engines&behavior=current&seed=${Date.now()}`
	);
	const routeRows = [
		["Proof Telegram", "/channels/channel-proof"],
		["proof-profile", "/identities/profile/proof-profile"],
		["Proof skill", "/skills"],
		["Proof MCP", "/tools"],
		["proof_search", "/tools"],
		["Proof Plugin", "/apps"],
		["Proof Engine", "/engines"],
	] as const;
	for (const [rowName, expectedPath] of routeRows) {
		const row = page.getByRole("button", { name: new RegExp(rowName) }).first();
		await expect(row).toBeVisible();
		await row.click();
		await expect.poll(() => activeTabPath(page)).toBe(expectedPath);
		await row.focus();
		await row.press("Enter");
		await expect.poll(() => activeTabPath(page)).toBe(expectedPath);
	}

	const newWindowRows = [
		[
			"identities",
			"proof-profile",
			"/identities/profile/proof-profile",
			"proof-profile",
		],
		["skills", "Proof skill", "/skills", "Skills"],
		["mcp", "Proof MCP", "/tools", "Tools"],
		["tools", "proof_search", "/tools", "Tools"],
		["plugins", "Proof Plugin", "/apps", "Plugins"],
		["engines", "Proof Engine", "/engines", "Engines"],
	] as const;
	for (const [sectionKey, rowName, path, title] of newWindowRows) {
		const menu = await openSectionRowContextMenu(page, sectionKey, rowName);
		await menu
			.getByRole("menuitem", { name: "Open in new window", exact: true })
			.click();
		const nativeCalls = await page.evaluate(
			() =>
				/* SAFETY: app-sidebar-interactions-proof.spec.ts installs __APP_SIDEBAR_PROOF__ before this proof page is evaluated. */ window
					.__APP_SIDEBAR_PROOF__?.nativeCalls ?? []
		);
		expect(nativeCalls).toContainEqual({
			args: {
				conversationId: null,
				entityKey: null,
				node: null,
				path,
				title,
			},
			command: "open_tab_window",
		});
	}

	const integrationRow = page
		.getByRole("button", { name: /Proof Mail/ })
		.first();
	await integrationRow.press("Enter");
	await expect(page.getByTestId("gateway-state")).toContainText(
		JSON.stringify({ open: true, section: "integrations" })
	);
	await page
		.getByRole("button", { name: "Add integration", exact: true })
		.click();
	await expect(page.getByTestId("gateway-state")).toContainText("integrations");

	await page.getByRole("button", { name: "Add channel", exact: true }).click();
	const channelDialog = page.getByRole("dialog", { name: "New channel bot" });
	await expect(channelDialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(channelDialog).toBeHidden();
	expect(
		fixtureFor(page).requests.some(
			(request) => request.method === "POST" && request.path === "/api/channels"
		)
	).toBe(false);

	await page.getByRole("button", { name: "Add identity", exact: true }).click();
	const identityDialog = page.getByRole("dialog");
	await expect(identityDialog).toBeVisible();
	await expect(identityDialog.getByLabel("Profile")).toBeVisible();
	await identityDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(identityDialog).toBeHidden();

	for (const [actionName, expectedPath] of [
		["Add skill", "/skills"],
		["Add MCP server", "/tools"],
		["Browse tools", "/tools"],
		["Add plugin", "/apps"],
		["Add engine", "/engines"],
	] as const) {
		await page.getByRole("button", { name: actionName, exact: true }).click();
		await expect.poll(() => activeTabPath(page)).toBe(expectedPath);
	}

	// The section data was loaded using the local session fixture above. Drop the
	// managed billing token before exercising the forced-new-tab branch so this
	// path proves navigation semantics without consuming a fixture plan's tab cap.
	// This bridge answers `undefined` for the sealed `desktop_secret_*` slots (a
	// host without them), so the auth client keeps reading the legacy localStorage
	// token live and removing it does sign the page out.
	await page.evaluate(() => localStorage.removeItem("ryu_session_token"));
	await page
		.locator("#sidebar-sec-channels")
		.getByRole("button", { name: /Proof Telegram/ })
		.click();
	await expect.poll(() => activeTabPath(page)).toBe("/channels/channel-proof");
	const channelMenu = await openSectionRowContextMenu(
		page,
		"channels",
		"Proof Telegram"
	);
	await channelMenu
		.getByRole("menuitem", { name: "Open in new tab", exact: true })
		.click();
	await expect
		.poll(async () => {
			const state = await tabs(page);
			return state.tabs.filter((tab) => tab.path === "/channels/channel-proof")
				.length;
		})
		.toBeGreaterThan(1);

	const channelContext = await openSectionRowContextMenu(
		page,
		"channels",
		"Proof Telegram"
	);
	await channelContext
		.getByRole("menuitem", { name: "Open in new window", exact: true })
		.click();
	const nativeCalls = await page.evaluate(
		() =>
			/* SAFETY: app-sidebar-interactions-proof.spec.ts installs __APP_SIDEBAR_PROOF__ before this proof page is evaluated. */ window
				.__APP_SIDEBAR_PROOF__?.nativeCalls ?? []
	);
	expect(nativeCalls).toContainEqual({
		args: {
			conversationId: null,
			entityKey: null,
			node: null,
			path: "/channels/channel-proof",
			title: "Proof Telegram",
		},
		command: "open_tab_window",
	});
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-built-in-sections.png`,
		animations: "disabled",
	});
});

test("identity, skill, server, tool, plugin, and engine rows open every exact new-tab target", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=identities,skills,mcp,tools,plugins,engines&behavior=current&seed=${Date.now()}`
	);
	const newTabRows = [
		["identities", "proof-profile", "/identities/profile/proof-profile"],
		["skills", "Proof skill", "/skills"],
		["mcp", "Proof MCP", "/tools"],
		["tools", "proof_search", "/tools"],
		["plugins", "Proof Plugin", "/apps"],
		["engines", "Proof Engine", "/engines"],
	] as const;
	for (const [sectionKey, rowName, path] of newTabRows) {
		const before = await tabs(page);
		const beforeCount = before.tabs.filter((tab) => tab.path === path).length;
		const menu = await openSectionRowContextMenu(page, sectionKey, rowName);
		await menu
			.getByRole("menuitem", { name: "Open in new tab", exact: true })
			.click();
		await expect
			.poll(
				async () =>
					(await tabs(page)).tabs.filter((tab) => tab.path === path).length
			)
			.toBe(beforeCount + 1);
		await expect.poll(() => activeTabPath(page)).toBe(path);
	}
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-entity-new-tabs.png`,
		animations: "disabled",
	});
});

test("agent rows route, edit, pin, dispatch contributed actions, create agents, and dismiss scheduled-task dialogs", async ({
	page,
}) => {
	fixtureFor(page).calendarEnabled = true;
	await page.goto(
		`${STORY_URL}?focus=agents,chats&auth=off&mode=sections&seed=${Date.now()}`
	);
	const agentSection = page.locator("#sidebar-sec-agents");
	const agentRow = agentSection
		.locator('div[role="button"]')
		.filter({ hasText: "Agent Alpha" })
		.first();
	await expect(agentRow).toBeVisible();
	const editAgentButton = agentSection.getByRole("button", {
		name: "Edit Agent Alpha",
		exact: true,
	});
	await editAgentButton.hover();
	await expect(
		page
			.locator('[data-slot="tooltip-content"]')
			.filter({ hasText: "Edit agent" })
	).toBeVisible();

	const state = await tabs(page);
	const initialChats = state.tabs.filter((tab) => tab.path === "/chat").length;
	await agentRow.click();
	await expect.poll(() => activeTabPath(page)).toBe("/chat");
	await expect
		.poll(
			async () =>
				(await tabs(page)).tabs.filter((tab) => tab.path === "/chat").length
		)
		.toBe(initialChats + 1);
	await agentRow.focus();
	await agentRow.press("Enter");
	await expect.poll(() => activeTabPath(page)).toBe("/chat");
	await expect
		.poll(
			async () =>
				(await tabs(page)).tabs.filter((tab) => tab.path === "/chat").length
		)
		.toBe(initialChats + 2);
	await editAgentButton.click();
	await expect.poll(() => activeTabPath(page)).toBe("/agents/agent-alpha/edit");

	let menu = await openSectionRowContextMenu(page, "agents", "Agent Alpha");
	await menu.getByRole("menuitem", { name: "Pin agent", exact: true }).click();
	expect(
		JSON.parse((await storageValue(page, "ryu:library-favorites")) ?? "[]")
	).toContainEqual({ id: "agent-alpha", type: "agent" });

	menu = await openSectionRowContextMenu(page, "agents", "Agent Alpha");
	await menu
		.getByRole("menuitem", { name: "Inspect agent", exact: true })
		.click();
	expect(fixtureFor(page).requests).toContainEqual({
		body: {
			args: { agent_id: "agent-alpha", source: "sidebar" },
			method: "proof.inspect-agent",
		},
		method: "POST",
		path: "/api/plugins/proof-app/host",
	});

	const beforeAgentTab = await tabs(page);
	menu = await openSectionRowContextMenu(page, "agents", "Agent Alpha");
	await menu
		.getByRole("menuitem", { name: "Open in new tab", exact: true })
		.click();
	await expect
		.poll(
			async () =>
				(await tabs(page)).tabs.filter(
					(tab) => tab.path === "/agents/agent-alpha/edit"
				).length
		)
		.toBe(
			beforeAgentTab.tabs.filter(
				(tab) => tab.path === "/agents/agent-alpha/edit"
			).length + 1
		);
	menu = await openSectionRowContextMenu(page, "agents", "Agent Alpha");
	await menu
		.getByRole("menuitem", { name: "Open in new window", exact: true })
		.click();
	const agentNativeCalls = await page.evaluate(
		() =>
			/* SAFETY: app-sidebar-interactions-proof.spec.ts installs __APP_SIDEBAR_PROOF__ before this proof page is evaluated. */ window
				.__APP_SIDEBAR_PROOF__?.nativeCalls ?? []
	);
	expect(agentNativeCalls).toContainEqual({
		args: {
			conversationId: null,
			entityKey: null,
			node: null,
			path: "/agents/agent-alpha/edit",
			title: "Agent Alpha",
		},
		command: "open_tab_window",
	});
	menu = await openSectionRowContextMenu(page, "agents", "Agent Alpha");
	await menu
		.getByRole("menuitem", { name: "Unpin agent", exact: true })
		.click();
	expect(
		JSON.parse((await storageValue(page, "ryu:library-favorites")) ?? "[]")
	).not.toContainEqual({ id: "agent-alpha", type: "agent" });

	await page.getByRole("button", { name: "New agent", exact: true }).click();
	const createAgentDialog = page.getByRole("dialog", { name: "New agent" });
	await expect(createAgentDialog).toBeVisible();
	await createAgentDialog.screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-new-agent-hidden-node.png`,
		animations: "disabled",
	});
	await page.keyboard.press("Escape");
	await expect(createAgentDialog).toBeHidden();

	const chatMenu = await openRowContextMenu(page, "Agent chat");
	await expect(
		chatMenu.getByRole("menuitem", { name: "Add scheduled task…", exact: true })
	).toBeVisible();
	await chatMenu
		.getByRole("menuitem", { name: "Add scheduled task…", exact: true })
		.click();
	const automationDialog = page.getByRole("dialog", { name: "New automation" });
	await expect(automationDialog).toBeVisible();
	await expect(automationDialog.getByLabel("Agent")).toHaveValue("agent-alpha");
	await expect(automationDialog.getByLabel("Persistent chat")).toHaveValue(
		"chat-agent-alpha"
	);
	await page.keyboard.press("Escape");
	await expect(automationDialog).toBeHidden();
	expect(
		fixtureFor(page).requests.some(
			(request) =>
				request.method === "POST" && request.path === "/api/automations"
		)
	).toBe(false);
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-agent-row-actions.png`,
		animations: "disabled",
	});
});

test("skill list load errors expose a real retry that recovers the production section", async ({
	page,
}) => {
	fixtureFor(page).failSkillReadCount = 4;
	await page.goto(
		`${STORY_URL}?focus=skills&auth=off&mode=sections&seed=${Date.now()}`
	);
	await expect(page.getByText("Couldn't load your skills.")).toBeVisible();
	fixtureFor(page).failSkillReadCount = 0;
	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await expect(page.getByText("Proof skill", { exact: true })).toBeVisible();
	expect(
		fixtureFor(page).requests.filter(
			(request) => request.method === "GET" && request.path === "/api/skills"
		)
	).toHaveLength(3);
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-skill-retry.png`,
		animations: "disabled",
	});
});

test("channel creation validates, trims exact fields, retains a failed draft for retry, and reloads from the local API fixture", async ({
	page,
}) => {
	await page.goto(`${STORY_URL}?focus=channels,agents&seed=${Date.now()}`);
	await expect(page.getByText("Proof Telegram", { exact: true })).toBeVisible();
	fixtureFor(page).failChannelCreateOnce = true;
	await page.getByRole("button", { name: "Add channel", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "New channel bot" });
	await expect(dialog).toBeVisible();
	await dialog.getByLabel("Name").fill("  Support proof  ");
	await dialog
		.getByRole("button", { name: "Paste a token", exact: true })
		.click();
	await dialog.getByRole("button", { name: "Create bot", exact: true }).click();
	await expect(dialog.getByText("Missing required: Bot token")).toBeVisible();
	expect(
		fixtureFor(page).requests.some(
			(request) => request.method === "POST" && request.path === "/api/channels"
		)
	).toBe(false);

	await dialog.getByLabel("Bot token").fill("  proof-secret-token  ");
	await dialog.getByLabel("Routes to").selectOption("agent-alpha");
	await dialog.getByLabel("Model override (optional)").fill("  proof-model  ");
	await dialog
		.getByLabel("System prompt (optional)")
		.fill("  Respond from the local proof fixture.  ");
	await dialog.getByLabel("Group replies").selectOption("all");
	await dialog.getByRole("switch", { name: "Enable channel" }).click();
	await dialog
		.getByRole("switch", { name: "Enable reaction learning" })
		.click();
	await dialog.getByLabel("Good response emojis").fill("👍, 🚀");
	await dialog.getByLabel("Bad response emojis").fill("👎, 💀");
	await dialog
		.getByRole("switch", { name: "Allow group reaction learning" })
		.click();
	await dialog.getByRole("switch", { name: "Let Ryu say hello first" }).click();
	await dialog
		.getByLabel("Where should Ryu say hello?")
		.fill("  approved-proof-chat  ");

	const expectedPayload = {
		agentId: "agent-alpha",
		channelType: "telegram",
		enabled: true,
		groupReplyMode: "all",
		model: "proof-model",
		name: "Support proof",
		proactiveOpening: true,
		proactiveTarget: "approved-proof-chat",
		reactionLearning: {
			allowGroup: true,
			enabled: true,
			negativeEmoji: ["👎", "💀"],
			positiveEmoji: ["👍", "🚀"],
		},
		secrets: { bot_token: "proof-secret-token" },
		systemPrompt: "Respond from the local proof fixture.",
		teamId: null,
	};
	await dialog.getByRole("button", { name: "Create bot", exact: true }).click();
	await expect(dialog).toBeVisible();
	await expect(dialog.getByLabel("Name")).toHaveValue("  Support proof  ");
	const createRequests = () =>
		fixtureFor(page).requests.filter(
			(request) => request.method === "POST" && request.path === "/api/channels"
		);
	await expect.poll(() => createRequests().length).toBe(1);
	expect(createRequests()[0]?.body).toEqual(expectedPayload);
	await expect(
		page.getByText("Fixture channel create failed", { exact: true })
	).toBeVisible();

	await dialog.getByRole("button", { name: "Create bot", exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByText("Support proof", { exact: true })).toBeVisible();
	await expect.poll(() => createRequests().length).toBe(2);
	expect(createRequests().map((request) => request.body)).toEqual([
		expectedPayload,
		expectedPayload,
	]);
	await page.reload();
	await expect(page.getByText("Support proof", { exact: true })).toBeVisible();
	await expect(page.getByTestId("app-sidebar-mount")).not.toContainText(
		"proof-secret-token"
	);
	expect(fixtureFor(page).channels.at(-1)).toMatchObject({
		name: "Support proof",
		secrets: { bot_token: "***" },
	});
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-channel-created.png`,
		animations: "disabled",
	});
});

test("Spaces section opens document rows, routes context actions, persists icon edits, and retries exact create payloads", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=spaces,tabs&grouped=off&behavior=current&auth=off&mode=sections&seed=${Date.now()}`
	);
	const projectBrowser = page.getByRole("dialog", {
		name: "Add a project folder to Ryu",
	});
	if (await projectBrowser.isVisible()) {
		await page.keyboard.press("Escape");
		await expect(projectBrowser).toBeHidden();
	}
	await expect(page.getByTestId("space-state")).toContainText("Proof space");
	const spaceRow = page.getByRole("button", { name: /Proof space/ }).first();
	await expect(spaceRow).toBeVisible();
	await spaceRow.click();
	const documentRow = page.getByRole("button", { name: /Proof page/ }).first();
	await expect(documentRow).toBeVisible();
	await documentRow.click();
	await expect
		.poll(() => activeTabPath(page))
		.toBe("/spaces/space-proof/doc/doc-proof-page");

	const documentMenu = await openSectionRowContextMenu(
		page,
		"spaces",
		"Proof page"
	);
	await documentMenu
		.getByRole("menuitem", { name: "Open in new tab", exact: true })
		.click();
	await expect
		.poll(async () => {
			const state = await tabs(page);
			return state.tabs.filter(
				(tab) => tab.path === "/spaces/space-proof/doc/doc-proof-page"
			).length;
		})
		.toBe(2);

	const iconMenu = await openSectionRowContextMenu(
		page,
		"spaces",
		"Proof page"
	);
	await iconMenu
		.getByRole("menuitem", { name: "Change icon…", exact: true })
		.click();
	const iconDialog = page.getByRole("dialog", { name: "Page icon" });
	await expect(iconDialog).toBeVisible();
	await iconDialog.getByRole("tab", { name: "Icon" }).click();
	await iconDialog
		.getByRole("textbox", { name: "Search icons" })
		.fill("folder");
	await iconDialog.getByRole("button", { name: "lucide:folder" }).click();
	await iconDialog
		.getByRole("button", { name: "Use icon", exact: true })
		.click();
	await expect(iconDialog).toBeHidden();
	expect(fixtureFor(page).requests).toContainEqual({
		body: { icon: { id: "lucide:folder", kind: "icon" } },
		method: "POST",
		path: "/api/spaces/space-proof/documents/doc-proof-page/icon",
	});

	fixtureFor(page).failSpaceCreateOnce = true;
	await page.getByRole("button", { name: "New space", exact: true }).click();
	const createDialog = page.getByRole("dialog", { name: "New space" });
	await expect(createDialog).toBeVisible();
	await createDialog.getByLabel("Name").fill("  Proof docs  ");
	await createDialog
		.getByLabel("Description (optional)")
		.fill("  local scope fixture  ");
	await createDialog
		.getByRole("button", { name: "Create", exact: true })
		.click();
	await expect(createDialog.getByText("/api/spaces failed: 503")).toBeVisible();
	await expect(createDialog.getByLabel("Name")).toHaveValue("  Proof docs  ");
	const spaceRequests = () =>
		fixtureFor(page).requests.filter(
			(request) => request.method === "POST" && request.path === "/api/spaces"
		);
	const expectedCreate = {
		description: "local scope fixture",
		name: "Proof docs",
		visibility: "private",
	};
	await expect.poll(() => spaceRequests().length).toBe(1);
	expect(spaceRequests()[0]?.body).toEqual(expectedCreate);
	await createDialog
		.getByRole("button", { name: "Create", exact: true })
		.click();
	await expect(createDialog).toBeHidden();
	await expect.poll(() => spaceRequests().length).toBe(2);
	expect(spaceRequests().map((request) => request.body)).toEqual([
		expectedCreate,
		expectedCreate,
	]);
	await expect(
		page.getByRole("button", { name: /^Proof docs/ }).first()
	).toBeVisible();
	await page.reload();
	await expect(
		page.getByRole("button", { name: /^Proof docs/ }).first()
	).toBeVisible();
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-spaces-documents.png`,
		animations: "disabled",
	});
});

test("grouped Spaces picker persists selection and routes its real visibility/delete confirmations", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=spaces&grouped=on&behavior=current&auth=off&mode=sections&seed=${Date.now()}`
	);
	const section = page.locator("#sidebar-sec-spaces");
	const privatePicker = section.getByRole("combobox").first();
	await expect(privatePicker).toContainText("All private spaces");
	await privatePicker.click();
	await page.getByRole("option", { name: "Proof space", exact: true }).click();
	await expect(privatePicker).toContainText("Proof space");
	expect(
		await page.evaluate(() =>
			localStorage.getItem("ryu:sidebar-private-space-selection")
		)
	).toBe("space-proof");

	const options = page.getByRole("button", {
		name: "Proof space options",
		exact: true,
	});
	await options.click();
	let menu = page.locator('[data-slot="dropdown-menu-content"]:visible').last();
	await menu
		.getByRole("menuitem", { name: "Delete space", exact: true })
		.click();
	const deleteDialog = page.getByRole("alertdialog");
	await expect(deleteDialog).toContainText("Delete Proof space");
	await deleteDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(deleteDialog).toBeHidden();
	expect(
		fixtureFor(page).requests.some(
			(request) =>
				request.method === "DELETE" &&
				request.path === "/api/spaces/space-proof"
		)
	).toBe(false);

	await options.click();
	menu = page.locator('[data-slot="dropdown-menu-content"]:visible').last();
	await menu
		.getByRole("menuitem", { name: "Share with team", exact: true })
		.click();
	const visibilityDialog = page.getByRole("alertdialog");
	await expect(visibilityDialog).toContainText("Share with your team?");
	await visibilityDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(visibilityDialog).toBeHidden();
	expect(
		fixtureFor(page).requests.some(
			(request) =>
				request.method === "POST" &&
				request.path === "/api/spaces/space-proof/visibility"
		)
	).toBe(false);

	await options.click();
	menu = page.locator('[data-slot="dropdown-menu-content"]:visible').last();
	await menu
		.getByRole("menuitem", { name: "Share with team", exact: true })
		.click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Share with team", exact: true })
		.click();
	await expect(page.getByRole("alertdialog")).toBeHidden();
	expect(fixtureFor(page).requests).toContainEqual({
		body: { visibility: "org" },
		method: "POST",
		path: "/api/spaces/space-proof/visibility",
	});
	await expect
		.poll(
			async () => (await page.getByTestId("space-state").textContent()) ?? ""
		)
		.toContain("Proof space");
	await page.reload();
	await expect(page.getByTestId("space-state")).toContainText("Proof space");
	const teamPicker = section.getByRole("combobox").nth(1);
	await expect(teamPicker).toContainText("All team spaces");
	await teamPicker.click();
	await expect(
		page.getByRole("option", { name: "Proof space", exact: true })
	).toBeVisible();
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-grouped-space-selection.png`,
		animations: "disabled",
	});
});

test("chat visibility confirmation cancels without a write and moves a shared chat into Team", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=chats&auth=off&mode=sections&seed=${Date.now()}`
	);
	let menu = await openRowContextMenu(page, "Proof chat");
	await menu
		.getByRole("menuitem", { name: "Share with team", exact: true })
		.click();
	let dialog = page.getByRole("alertdialog");
	await expect(dialog).toContainText("Share with your team?");
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toBeHidden();
	expect(
		fixtureFor(page).requests.some(
			(request) =>
				request.method === "POST" &&
				request.path === "/api/conversations/chat-loose/visibility"
		)
	).toBe(false);

	menu = await openRowContextMenu(page, "Proof chat");
	await menu
		.getByRole("menuitem", { name: "Share with team", exact: true })
		.click();
	dialog = page.getByRole("alertdialog");
	await dialog
		.getByRole("button", { name: "Share with team", exact: true })
		.click();
	await expect(dialog).toBeHidden();
	expect(fixtureFor(page).requests).toContainEqual({
		body: { visibility: "org" },
		method: "POST",
		path: "/api/conversations/chat-loose/visibility",
	});
	await expect(
		page.locator('#sidebar-sec-chats [data-subsection-key="team"]')
	).toContainText("Proof chat");
	await expect(
		page.locator('#sidebar-sec-chats [data-subsection-key="private"]')
	).not.toContainText("Proof chat");
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-chat-visibility-confirmed.png`,
		animations: "disabled",
	});
});

test("Projects scope actions change the active workspace, routes, dialogs, and removed-project persistence", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=projects,tabs&grouped=on&behavior=current&auth=off&active=off&mode=sections&seed=${Date.now()}`
	);
	const picker = page.getByRole("combobox").first();
	await expect(picker).toContainText("All projects");
	await picker.click();
	await page
		.getByRole("option", { name: "Project Alpha", exact: true })
		.click();
	await expect(picker).toContainText("Project Alpha");

	const scopeOptions = page.getByRole("button", {
		name: "Project Alpha options",
		exact: true,
	});
	await scopeOptions.click();
	await page
		.getByRole("menuitem", { name: "Set as active project", exact: true })
		.click();
	await expect(page.getByTestId("workspace-state")).toHaveText(PROJECT_PATH);

	await scopeOptions.click();
	await page
		.getByRole("menuitem", { name: "Open Git graph", exact: true })
		.click();
	await expect
		.poll(() => activeTabPath(page))
		.toBe(`/project/graph/${encodeURIComponent(PROJECT_PATH)}`);

	await scopeOptions.click();
	await page
		.getByRole("menuitem", { name: "New chat in this folder", exact: true })
		.click();
	await expect(page.getByTestId("workspace-state")).toHaveText(PROJECT_PATH);
	await expect.poll(() => activeTabPath(page)).toBe("/chat");
	await expect
		.poll(async () => (await tabs(page)).tabs.length)
		.toBeGreaterThan(1);

	await scopeOptions.click();
	await page
		.getByRole("menuitem", { name: "Edit project…", exact: true })
		.click();
	const settingsDialog = page.getByRole("dialog", { name: "Edit project" });
	await expect(settingsDialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(settingsDialog).toBeHidden();

	await scopeOptions.click();
	await page
		.getByRole("menuitem", { name: "Change icon…", exact: true })
		.click();
	const iconDialog = page.getByRole("dialog", { name: /Project icon/i });
	await expect(iconDialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(iconDialog).toBeHidden();

	await scopeOptions.click();
	await page
		.getByRole("menuitem", { name: "Remove from app", exact: true })
		.click();
	const removed = sidebarStringsSchema.parse(
		await page.evaluate(() =>
			JSON.parse(localStorage.getItem("ryu_workspace_removed") ?? "[]")
		)
	);
	expect(removed).toContain(PROJECT_PATH);
	await page.reload();
	await expect(page.getByTestId("workspace-state")).toHaveText("(none)");
	await expect(
		page.getByText("No projects yet. Click + to import a folder.")
	).toBeVisible();
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-project-scope-actions.png`,
		animations: "disabled",
	});
});

test("Projects add menu opens node folder browsing and new/clone dialogs with stateful retry payloads", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=projects,tabs&grouped=off&behavior=current&auth=off&active=off&mode=sections&seed=${Date.now()}`
	);
	const addProject = page.getByRole("button", {
		name: "Add project",
		exact: true,
	});
	await addProject.click();
	await page
		.getByRole("menuitem", { name: "New project", exact: true })
		.click();
	const browserDialog = page.getByRole("dialog", {
		name: "Add a project folder to Ryu",
	});
	await expect(browserDialog).toBeVisible();
	await expect(
		browserDialog.getByText("Documents", { exact: true })
	).toBeVisible();
	await browserDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(browserDialog).toBeHidden();
	expect(
		fixtureFor(page).requests.some(
			(request) =>
				request.method === "GET" && request.path === "/api/workspace/list"
		)
	).toBe(true);

	await addProject.click();
	await page
		.getByRole("menuitem", { name: "Start from scratch", exact: true })
		.click();
	const createDialog = page.getByRole("dialog", { name: "Start from scratch" });
	await expect(createDialog).toBeVisible();
	fixtureFor(page).failFolderCreateOnce = true;
	await createDialog
		.getByPlaceholder("New project name")
		.fill("  Proof workspace  ");
	await createDialog
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await expect(
		createDialog.getByText("Fixture project folder collision")
	).toBeVisible();
	await expect(createDialog.getByPlaceholder("New project name")).toHaveValue(
		"  Proof workspace  "
	);
	await createDialog
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await expect(createDialog).toBeHidden();
	await expect(page.getByTestId("workspace-state")).toHaveText(
		"/Users/proof/Documents/Ryu/Proof workspace"
	);
	expect(
		fixtureFor(page)
			.requests.filter(
				(request) =>
					request.method === "POST" &&
					request.path === "/api/workspace/new-folder"
			)
			.map((request) => request.body)
	).toEqual([{ name: "Proof workspace" }, { name: "Proof workspace" }]);

	await page.getByRole("button", { name: "Add project", exact: true }).click();
	await page
		.getByRole("menuitem", { name: "Clone from Git", exact: true })
		.click();
	const cloneDialog = page.getByRole("dialog", {
		name: "Clone Git repository",
	});
	await expect(cloneDialog).toBeVisible();
	fixtureFor(page).failFolderCloneOnce = true;
	await cloneDialog
		.getByLabel("Repository URL")
		.fill("  https://dev.azure.com/proof/platform/_git/clone-repo  ");
	await cloneDialog
		.getByRole("button", { name: "Clone repository", exact: true })
		.click();
	await expect(cloneDialog.getByText("Fixture clone failed")).toBeVisible();
	await expect(cloneDialog.getByLabel("Repository URL")).toHaveValue(
		"  https://dev.azure.com/proof/platform/_git/clone-repo  "
	);
	await cloneDialog
		.getByRole("button", { name: "Clone repository", exact: true })
		.click();
	await expect(cloneDialog).toBeHidden();
	await expect(page.getByTestId("workspace-state")).toHaveText(
		"/Users/proof/Documents/Ryu/clone-repo"
	);
	expect(
		fixtureFor(page)
			.requests.filter(
				(request) =>
					request.method === "POST" && request.path === "/api/workspace/clone"
			)
			.map((request) => request.body)
	).toEqual([
		{
			name: "clone-repo",
			url: "https://dev.azure.com/proof/platform/_git/clone-repo",
		},
		{
			name: "clone-repo",
			url: "https://dev.azure.com/proof/platform/_git/clone-repo",
		},
	]);
	await page.reload();
	await expect(page.getByTestId("workspace-state")).toHaveText(
		"/Users/proof/Documents/Ryu/clone-repo"
	);
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-project-picker-retry.png`,
		animations: "disabled",
	});
});

test("Chats header actions open and cancel both import dialogs, create a real caller chat, and scope delete-all confirmation", async ({
	page,
}) => {
	await page.goto(
		`${STORY_URL}?focus=chats,tabs&behavior=current&auth=off&mode=sections&seed=${Date.now()}`
	);
	await expect(page.getByRole("button", { name: /Proof chat/ })).toBeVisible();

	await page
		.getByRole("button", { name: "Import a past agent thread", exact: true })
		.click();
	const threadsDialog = page.getByRole("dialog", { name: "Import a thread" });
	await expect(threadsDialog).toBeVisible();
	await expect(
		threadsDialog.getByRole("button", { name: /Imported proof thread/ })
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(threadsDialog).toBeHidden();
	expect(
		fixtureFor(page).requests.some(
			(request) =>
				request.method === "GET" &&
				request.path === "/api/agents/agent-alpha/threads"
		)
	).toBe(true);

	await page
		.getByRole("button", { name: "Import a past agent thread", exact: true })
		.click();
	const importDialog = page.getByRole("dialog", { name: "Import a thread" });
	await expect(importDialog).toBeVisible();
	await importDialog
		.getByRole("button", { name: /Imported proof thread/ })
		.click();
	await expect(
		importDialog.getByRole("button", { name: "Import 1", exact: true })
	).toBeEnabled();
	await importDialog
		.getByRole("button", { name: "Import 1", exact: true })
		.click();
	await expect(importDialog).toBeHidden();
	expect(fixtureFor(page).requests).toContainEqual({
		body: { dry_run: false, thread_id: "native-thread-proof" },
		method: "POST",
		path: "/api/agents/agent-alpha/threads/import",
	});
	await expect
		.poll(async () => {
			const state = await tabs(page);
			return state.tabs.find((tab) => tab.id === state.activeTabId)
				?.conversationId;
		})
		.toBe("conversation-imported-proof");

	await page
		.getByRole("button", {
			name: "Import agent setup from a folder",
			exact: true,
		})
		.click();
	const setupDialog = page.getByRole("dialog", { name: "Import agent setup" });
	await expect(setupDialog).toBeVisible();
	await setupDialog.getByRole("button", { name: "Choose a folder…" }).click();
	const folderDialog = page.getByRole("dialog", {
		name: "Add a project folder to Ryu",
	});
	await expect(folderDialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(folderDialog).toBeHidden();
	await expect(setupDialog).toBeVisible();
	await setupDialog
		.getByRole("button", { name: "Close", exact: true })
		.first()
		.click();
	await expect(setupDialog).toBeHidden();
	expect(
		fixtureFor(page).requests.some(
			(request) =>
				request.method === "POST" && request.path === "/api/import/scan"
		)
	).toBe(false);

	await page
		.getByRole("button", {
			name: "Import agent setup from a folder",
			exact: true,
		})
		.click();
	const setupImportDialog = page.getByRole("dialog", {
		name: "Import agent setup",
	});
	await expect(setupImportDialog).toBeVisible();
	await setupImportDialog
		.getByRole("button", { name: "Claude Code", exact: true })
		.click();
	await expect(
		setupImportDialog.getByRole("button", { name: /Proof instructions/ })
	).toBeVisible();
	await setupImportDialog
		.getByRole("button", { name: /Proof instructions/ })
		.click();
	await expect(
		setupImportDialog.getByRole("button", { name: "Import 1", exact: true })
	).toBeEnabled();
	await setupImportDialog
		.getByRole("button", { name: "Import 1", exact: true })
		.click();
	await expect(setupImportDialog.getByText("Imported 1")).toBeVisible();
	expect(fixtureFor(page).requests).toContainEqual({
		body: {
			items: [{ id: "proof-instructions", kind: "instructions" }],
			path: "/Users/proof/.claude",
		},
		method: "POST",
		path: "/api/import/run",
	});
	await expect(page.getByTestId("workspace-project-state")).toContainText(
		"/Users/proof/Imported instructions"
	);
	await setupImportDialog
		.getByRole("button", { name: "Close", exact: true })
		.first()
		.click();
	await expect(setupImportDialog).toBeHidden();
	await page.reload();
	await expect(page.getByTestId("workspace-project-state")).toContainText(
		"/Users/proof/Imported instructions"
	);

	const beforeNew = await tabs(page);
	await page
		.getByRole("button", { name: "New chat", exact: true })
		.last()
		.click();
	await expect
		.poll(async () => (await tabs(page)).tabs.length)
		.toBe(beforeNew.tabs.length + 1);
	const chatStateAfterNew = await page.getByTestId("chat-state").textContent();
	expect(chatStateAfterNew).toContain("sidebar-new-");
	await expect.poll(() => activeTabPath(page)).toBe("/chat");

	const chatsHeader = page
		.locator("#sidebar-sec-chats")
		.getByRole("button", { name: "Chats", exact: true });
	await chatsHeader.click({ button: "right", force: true });
	const deleteMenu = page
		.locator('[data-slot="context-menu-content"]:visible')
		.last();
	await expect(
		deleteMenu.getByRole("menuitem", { name: /Delete all chats/ })
	).toBeVisible();
	const deleteLabel = await deleteMenu
		.getByRole("menuitem", { name: /Delete all chats/ })
		.innerText();
	await deleteMenu.getByRole("menuitem", { name: /Delete all chats/ }).click();
	const confirmation = page.getByRole("alertdialog");
	await expect(confirmation).toBeVisible();
	const confirmationTitle = await confirmation
		.locator("[data-slot='alert-dialog-title']")
		.innerText();
	const countMatch = confirmationTitle.match(/Delete all (\d+) chats?/);
	expect(countMatch?.[1]).toBeTruthy();
	await confirmation
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(confirmation).toBeHidden();
	await expect(page.getByTestId("chat-state")).toContainText("chat-loose");

	await chatsHeader.click({ button: "right", force: true });
	const confirmMenu = page
		.locator('[data-slot="context-menu-content"]:visible')
		.last();
	await confirmMenu.getByRole("menuitem", { name: /Delete all chats/ }).click();
	const expectedDeleteCount = countMatch?.[1];
	if (!expectedDeleteCount) {
		throw new Error(
			`Could not read delete confirmation count from ${deleteLabel}`
		);
	}
	await page
		.getByRole("alertdialog")
		.getByRole("button", {
			name: `Delete ${expectedDeleteCount} chats`,
			exact: true,
		})
		.click();
	await expect(page.getByRole("alertdialog")).toBeHidden();
	const finalChats = await page.getByTestId("chat-state").textContent();
	expect(finalChats).not.toContain("chat-loose");
	expect(finalChats).not.toContain("chat-agent-alpha");
	expect(finalChats).not.toContain("chat-group-alpha");
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${EVIDENCE_DIRECTORY}/app-sidebar-chat-actions.png`,
		animations: "disabled",
	});
});

test.describe("Customize sidebar production dialog", () => {
	test.afterEach(async ({ page }) => {
		expect(unexpectedBrowserErrors.get(page)).toEqual([]);
	});
	async function openCustomize(page: Page) {
		const menu = await openGlobalContextMenu(page);
		await menu
			.getByRole("menuitem", { name: "Customize sidebar", exact: true })
			.click();
		const dialog = page.getByRole("dialog", { name: "Customize sidebar" });
		await expect(dialog).toBeVisible();
		await expect(
			dialog.getByRole("button", { name: "All off", exact: true })
		).toBeVisible();
		await expect(page.getByRole("menu")).toHaveCount(0);
		return dialog;
	}
	async function readList(page: Page, key: string) {
		return sidebarStringsSchema.parse(
			JSON.parse((await storageValue(page, key)) ?? "[]")
		);
	}
	test("bulk visibility covers contributed buttons and sections, survives Done and reload, and resets defaults", async ({
		page,
	}) => {
		await page.goto(`${STORY_URL}?focus=agents,chats`);
		let dialog = await openCustomize(page);
		await expect(dialog.getByText("Proof home", { exact: true })).toBeVisible();
		await dialog.getByRole("button", { name: "All off", exact: true }).click();
		expect(await readList(page, "ryu:sidebar-hidden-chrome")).toContain(
			"plugin:proof-app:proof-home"
		);
		expect(await readList(page, "ryu:sidebar-hidden-sections")).toContain(
			"plugin:proof-app:proof-records"
		);
		await dialog.getByRole("button", { name: "Done", exact: true }).click();
		await expect(dialog).toBeHidden();
		await expect(
			page.getByRole("button", { name: "Proof home", exact: true })
		).toBeHidden();
		await page.reload();
		expect(await readList(page, "ryu:sidebar-hidden-chrome")).toContain(
			"plugin:proof-app:proof-home"
		);
		// Hidden content still has its production background context-menu entry.
		await page
			.locator('[data-sidebar="content"]')
			.click({ button: "right", position: { x: 10, y: 10 } });
		await page
			.getByRole("menuitem", { name: "Customize sidebar", exact: true })
			.click();
		dialog = page.getByRole("dialog", { name: "Customize sidebar" });
		await dialog.getByRole("button", { name: "All on", exact: true }).click();
		expect(await readList(page, "ryu:sidebar-hidden-chrome")).toEqual(["logo"]);
		expect(await readList(page, "ryu:sidebar-hidden-sections")).toEqual([]);
		await dialog
			.getByRole("button", { name: "Reset to default", exact: true })
			.click();
		expect(await readList(page, "ryu:sidebar-hidden-sections")).toEqual(
			DEFAULT_PROOF_HIDDEN_SECTIONS
		);
		expect(await readList(page, "ryu:sidebar-section-order")).toEqual(
			DEFAULT_SECTION_ORDER
		);
		await dialog.getByRole("button", { name: "Done", exact: true }).click();
		await expect(dialog).toBeHidden();
		await expect(
			page.getByRole("button", { name: "Proof home", exact: true })
		).toBeVisible();
		await page.locator('[data-sidebar="sidebar"]').screenshot({
			path: `${EVIDENCE_DIRECTORY}/customize-sidebar-restored.png`,
			animations: "disabled",
		});
	});
	test("group controls are isolated and keyboard visibility changes apply immediately on Escape", async ({
		page,
	}) => {
		await page.goto(`${STORY_URL}?focus=agents,chats`);
		const dialog = await openCustomize(page);
		const groups = ["Top buttons", "Sections", "Bottom buttons"];
		for (const title of groups) {
			const sectionsBefore = await readList(
				page,
				"ryu:sidebar-hidden-sections"
			);
			const chromeBefore = await readList(page, "ryu:sidebar-hidden-chrome");
			const group = dialog
				.getByText(title, { exact: true })
				.locator("xpath=../..");
			await group
				.getByRole("button", { name: "Hide all", exact: true })
				.click();
			await expect(dialog).toBeVisible();
			if (title === "Sections") {
				expect(await readList(page, "ryu:sidebar-hidden-chrome")).toEqual(
					chromeBefore
				);
			} else {
				expect(await readList(page, "ryu:sidebar-hidden-sections")).toEqual(
					sectionsBefore
				);
				expect(
					(await readList(page, "ryu:sidebar-hidden-chrome")).includes(
						title === "Top buttons" ? "settings" : "new-chat"
					)
				).toBe(
					chromeBefore.includes(
						title === "Top buttons" ? "settings" : "new-chat"
					)
				);
			}
			await expect(
				group.getByRole("button", {
					name: title === "Sections" ? "Hide section" : "Hide button",
					exact: true,
				})
			).toHaveCount(0);
			await group
				.getByRole("button", { name: "Show all", exact: true })
				.click();
			await expect(
				group.getByRole("button", {
					name: title === "Sections" ? "Show section" : "Show button",
					exact: true,
				})
			).toHaveCount(0);
		}
		const agents = dialog
			.getByText("Agents", { exact: true })
			.locator("xpath=../..");
		await agents
			.getByRole("button", { name: "Hide section", exact: true })
			.click();
		expect(await readList(page, "ryu:sidebar-hidden-sections")).toEqual([
			"agents",
		]);
		await agents
			.getByRole("button", { name: "Show section", exact: true })
			.focus();
		await page.keyboard.press("Space");
		expect(await readList(page, "ryu:sidebar-hidden-sections")).toEqual([]);
		const node = dialog
			.getByText("Node selector", { exact: true })
			.locator("..");
		await node
			.getByRole("button", { name: "Hide button", exact: true })
			.click();
		expect(await readList(page, "ryu:sidebar-hidden-chrome")).toEqual([
			"logo",
			"node-selector",
		]);
		await node
			.getByRole("button", { name: "Show button", exact: true })
			.click();
		const row = dialog
			.getByText("Proof home", { exact: true })
			.locator("xpath=../..");
		await row.getByRole("button", { name: "Hide button", exact: true }).focus();
		await page.keyboard.press("Enter");
		expect(await readList(page, "ryu:sidebar-hidden-chrome")).toEqual([
			"logo",
			"plugin:proof-app:proof-home",
		]);
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
		await page.reload();
		await expect(
			page.getByRole("button", { name: "Proof home", exact: true })
		).toBeHidden();
	});
	test("dragging contributed rows persists exact order without mixing sections and top buttons", async ({
		page,
	}) => {
		await page.goto(`${STORY_URL}?focus=agents,chats`);
		let dialog = await openCustomize(page);
		const chromeBefore = await readList(page, "ryu:sidebar-chrome-order");
		const chromeTransfer = await page.evaluateHandle(() => new DataTransfer());
		const chromeSource = dialog.getByRole("button", {
			name: "Proof home",
			exact: true,
		});
		await chromeSource.dispatchEvent("dragstart", {
			dataTransfer: chromeTransfer,
		});
		await expect(chromeSource.locator("..")).toHaveClass(/opacity-50/);
		const chromeTarget = dialog
			.getByRole("button", { name: "New chat", exact: true })
			.locator("..");
		await chromeTarget.dispatchEvent("dragover", {
			dataTransfer: chromeTransfer,
		});
		await chromeTarget.dispatchEvent("drop", { dataTransfer: chromeTransfer });
		await chromeTransfer.dispose();
		const chromeAfter = await readList(page, "ryu:sidebar-chrome-order");
		expect(chromeAfter.indexOf("plugin:proof-app:proof-home")).toBeLessThan(
			chromeAfter.indexOf("new-chat")
		);
		expect(chromeAfter).not.toEqual(chromeBefore);
		const transfer = await page.evaluateHandle(() => new DataTransfer());
		await dialog
			.getByRole("button", { name: "Proof records", exact: true })
			.dispatchEvent("dragstart", { dataTransfer: transfer });
		const target = dialog
			.getByRole("button", { name: "Agents", exact: true })
			.locator("..");
		await target.dispatchEvent("dragover", { dataTransfer: transfer });
		await target.dispatchEvent("drop", { dataTransfer: transfer });
		await transfer.dispose();
		const sectionAfter = await readList(page, "ryu:sidebar-section-order");
		expect(sectionAfter.indexOf("plugin:proof-app:proof-records")).toBeLessThan(
			sectionAfter.indexOf("agents")
		);
		expect(await readList(page, "ryu:sidebar-chrome-order")).toEqual(
			chromeAfter
		);
		await dialog.getByRole("button", { name: "Done", exact: true }).click();
		await expect(dialog).toBeHidden();
		await page.reload();
		dialog = await openCustomize(page);
		expect(await readList(page, "ryu:sidebar-chrome-order")).toEqual(
			chromeAfter
		);
		expect(await readList(page, "ryu:sidebar-section-order")).toEqual(
			sectionAfter
		);
		await dialog.getByRole("button", { name: "Done", exact: true }).click();
		await expect(dialog).toBeHidden();
	});
});

const DATA_FLOW_PROOF = fileURLToPath(
	new URL(
		"../../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-data-flows/import-browse/",
		import.meta.url
	)
);

test("data-flow import retries denied lists and failed-only batches through the real sidebar", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	let denyList = true;
	let denyImport = true;
	let releaseImport: (() => void) | undefined;
	const imported: string[] = [];
	const writes: unknown[] = [];
	await page.route("**/api/agents/agent-alpha/threads**", async (route) => {
		const request = route.request();
		if (request.method() === "GET") {
			if (denyList) {
				denyList = false;
				return route.fulfill(jsonResponse({ error: "denied" }, 403));
			}
			return route.fulfill(
				jsonResponse({
					supported: true,
					engine: "claude-code",
					threads: [
						{
							id: "thread-success",
							title: "Successful native thread",
							message_count: 3,
							updated_at: 200,
							engine: "claude-code",
						},
						{
							id: "thread-retry",
							title: "Retry native thread",
							message_count: 4,
							updated_at: 100,
							engine: "claude-code",
						},
					],
				})
			);
		}
		const body = sidebarThreadImportSchema.parse(request.postDataJSON());
		writes.push(body);
		if (writes.length === 1) {
			await new Promise<void>((resolve) => {
				releaseImport = resolve;
			});
		}
		if (body.thread_id === "thread-retry" && denyImport) {
			denyImport = false;
			return route.fulfill(jsonResponse({ error: "denied" }, 403));
		}
		imported.push(body.thread_id);
		return route.fulfill(
			jsonResponse({
				conversation_id: `conversation-${body.thread_id}`,
				dry_run: false,
				messages_added: 3,
			})
		);
	});
	await page.goto(
		`${STORY_URL}?focus=chats,tabs&auth=off&mode=sections&session=main&seed=data-flow`
	);
	const trigger = page.getByRole("button", {
		name: "Import a past agent thread",
		exact: true,
	});
	await trigger.click();
	const dialog = page.getByRole("dialog", { name: "Import a thread" });
	await expect(dialog).toContainText("Failed to load agent threads: 403");
	await dialog.getByRole("button", { name: "Retry", exact: true }).click();
	await dialog.getByRole("button", { name: "Select all", exact: true }).click();
	await expect(dialog).toContainText("2 of 2 selected");
	await dialog
		.getByRole("button", { name: "Deselect all", exact: true })
		.click();
	await expect(
		dialog.getByRole("button", { name: "Import", exact: true })
	).toBeDisabled();
	await dialog.getByRole("button", { name: "Select all", exact: true }).click();
	await dialog.getByRole("button", { name: "Import 2", exact: true }).click();
	await expect.poll(() => Boolean(releaseImport)).toBe(true);
	await expect(dialog.getByRole("combobox")).toBeDisabled();
	await expect(
		dialog.getByRole("button", { name: "Cancel", exact: true })
	).toBeDisabled();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeVisible();
	releaseImport?.();
	await expect(dialog.getByRole("status")).toContainText("1 imported");
	await expect(dialog).toContainText(
		"Failed to import thread. Retry the selected thread."
	);
	await expect(
		dialog.getByRole("button", { name: /Successful native thread/ })
	).toHaveCount(0);
	await expect(
		dialog.getByRole("button", { name: /Retry native thread/ })
	).toHaveAttribute("aria-pressed", "true");
	await mkdir(DATA_FLOW_PROOF, { recursive: true });
	await dialog.screenshot({
		path: `${DATA_FLOW_PROOF}/import-partial-retry.png`,
		animations: "disabled",
	});
	await dialog.getByRole("button", { name: "Import 1", exact: true }).click();
	await expect(dialog).toBeHidden();
	expect(writes).toEqual([
		{ thread_id: "thread-success", dry_run: false },
		{ thread_id: "thread-retry", dry_run: false },
		{ thread_id: "thread-retry", dry_run: false },
	]);
	expect(imported).toEqual(["thread-success", "thread-retry"]);
	await expect
		.poll(async () => {
			const state = await tabs(page);
			return state.tabs.find((tab) => tab.id === state.activeTabId)
				?.conversationId;
		})
		.toBe("conversation-thread-success");
	await expect
		.poll(() =>
			page
				.evaluate(() =>
					JSON.parse(localStorage.getItem("ryu_session_tabs") ?? "null")
				)
				.then(sidebarPersistedConversationIds)
		)
		.toContain("conversation-thread-success");
	await page.reload();
	await expect(page.getByTestId("tab-state")).toContainText(
		"conversation-thread-success"
	);
	await trigger.click();
	await expect(
		dialog.getByRole("button", { name: /Successful native thread/ })
	).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	expect(writes).toHaveLength(3);
	await page.locator('[data-sidebar="sidebar"]').screenshot({
		path: `${DATA_FLOW_PROOF}/import-completed-readback.png`,
		animations: "disabled",
	});
	expect(unexpectedBrowserErrors.get(page)).toEqual([
		"http://127.0.0.1:7980/api/agents/agent-alpha/threads: Failed to load resource: the server responded with a status of 403 (Forbidden)",
		"http://127.0.0.1:7980/api/agents/agent-alpha/threads/import: Failed to load resource: the server responded with a status of 403 (Forbidden)",
	]);
	expect(errors).toEqual([]);
});

test("data-flow import ignores a late previous-agent list and cancels without writes", async ({
	page,
}) => {
	let releaseAlpha: (() => void) | undefined;
	let alphaComplete = false;
	const writes: string[] = [];
	await page.route("**/api/agents/*/threads**", async (route) => {
		if (route.request().method() !== "GET") {
			writes.push(route.request().url());
			return route.fulfill(jsonResponse({}));
		}
		if (route.request().url().includes("agent-alpha")) {
			await new Promise<void>((resolve) => {
				releaseAlpha = resolve;
			});
			await route.fulfill(
				jsonResponse({
					supported: true,
					threads: [
						{
							id: "late",
							title: "Late wrong agent",
							message_count: 1,
							updated_at: 100,
							engine: "claude-code",
						},
					],
				})
			);
			alphaComplete = true;
			return;
		}
		return route.fulfill(jsonResponse({ supported: false, threads: [] }));
	});
	await page.goto(
		`${STORY_URL}?focus=chats&auth=off&mode=sections&seed=data-flow-stale`
	);
	await page
		.getByRole("button", { name: "Import a past agent thread", exact: true })
		.click();
	const dialog = page.getByRole("dialog", { name: "Import a thread" });
	await expect.poll(() => Boolean(releaseAlpha)).toBe(true);
	await dialog.getByRole("combobox").click();
	await page.getByRole("option", { name: "Agent Beta" }).click();
	await expect(dialog).toContainText(
		"This agent doesn't keep an importable local history."
	);
	releaseAlpha?.();
	await expect.poll(() => alphaComplete).toBe(true);
	await expect(dialog).toContainText(
		"This agent doesn't keep an importable local history."
	);
	await expect(
		dialog.getByRole("button", { name: /Late wrong agent/ })
	).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	expect(writes).toEqual([]);
	expect(unexpectedBrowserErrors.get(page)).toEqual([]);
});
