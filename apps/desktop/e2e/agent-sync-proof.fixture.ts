import { expect, type Page, type Route, test } from "@playwright/test";
import { z } from "zod";
import { type ProofJsonValue, parseProofJson } from "./fixture-json.ts";

export const CORE_ORIGIN = "http://127.0.0.1:7980";

export interface ProfileFixture {
	conflictCount: number;
	exportEnabled: boolean;
	id: string;
	importEnabled: boolean;
	lastOperationId: string | null;
	provider: "claude" | "codex" | "cursor";
	root: string;
	status: string;
	updatedAt: number;
}

export interface SyncItemFixture {
	conflict: unknown;
	generatedHash: string | null;
	kind: string;
	operationId: string | null;
	profileId: string;
	revision: number;
	sourceHash: string | null;
	sourceId: string;
	state: string;
	updatedAt: number;
}

export interface BindingFixture {
	agentId: string;
	capabilities: unknown;
	conversationId: string;
	engine: string;
	nativeSessionId: string;
	nodeId: string;
	updatedAt: number;
	workingDirectory: string | null;
}

export interface StatusFixture {
	activeOperations: number;
	bindings: BindingFixture[];
	items: SyncItemFixture[];
	nodeId: string;
	profiles: ProfileFixture[];
}

export interface CoreCall {
	body: unknown;
	headers: {
		authorization: string | undefined;
		"x-ryu-user-jwt": string | undefined;
	};
	method: string;
	path: string;
}

export interface FailureRule {
	bodyPath?: string;
	error: string;
	method: string;
	path: string;
	status: number;
	times: number;
}

export interface FixtureOptions {
	bindings?: BindingFixture[];
	conflicts?: SyncItemFixture[];
	emptyScanPath?: string;
	failures?: FailureRule[];
	holdInitialSyncReads?: boolean;
	noAgentScanPath?: string;
	profiles?: ProfileFixture[];
}

export interface CoreApiFixture {
	calls: CoreCall[];
	releaseInitialSyncReads: () => void;
}

export const DEFAULT_PROFILES: ProfileFixture[] = [
	{
		conflictCount: 1,
		exportEnabled: true,
		id: "profile-claude",
		importEnabled: false,
		lastOperationId: null,
		provider: "claude",
		root: "/Users/fixture/.claude",
		status: "conflict",
		updatedAt: 1_790_810_000,
	},
	{
		conflictCount: 1,
		exportEnabled: false,
		id: "profile-codex",
		importEnabled: true,
		lastOperationId: null,
		provider: "codex",
		root: "/Users/fixture/.codex",
		status: "conflict",
		updatedAt: 1_790_810_001,
	},
];

export const DEFAULT_BINDINGS: BindingFixture[] = [
	{
		agentId: "agent-claude-fixture",
		capabilities: { loadSession: true, resumeSession: true },
		conversationId: "conversation-load",
		engine: "claude",
		nativeSessionId: "native-session-load",
		nodeId: "node-agent-sync-fixture",
		updatedAt: 1_790_810_010,
		workingDirectory: "/Users/fixture/project-a",
	},
	{
		agentId: "agent-codex-fixture",
		capabilities: { loadSession: false, resumeSession: false },
		conversationId: "conversation-replay",
		engine: "codex",
		nativeSessionId: "native-session-replay",
		nodeId: "node-agent-sync-fixture",
		updatedAt: 1_790_810_011,
		workingDirectory: "/Users/fixture/project-b",
	},
];

export const DEFAULT_CONFLICTS: SyncItemFixture[] = [
	{
		conflict: { source: "fixture" },
		generatedHash: "generated-hash-skill",
		kind: "skill",
		operationId: "sync-fixture-001",
		profileId: "profile-claude",
		revision: 4,
		sourceHash: "source-hash-skill",
		sourceId: "skill-conflict",
		state: "conflict",
		updatedAt: 1_790_810_020,
	},
	{
		conflict: { source: "fixture" },
		generatedHash: "generated-hash-agent",
		kind: "agent",
		operationId: "sync-fixture-002",
		profileId: "profile-codex",
		revision: 7,
		sourceHash: "source-hash-agent",
		sourceId: "agent-conflict",
		state: "conflict",
		updatedAt: 1_790_810_021,
	},
];

export const corsHeaders = {
	"access-control-allow-headers":
		"authorization, content-type, x-ryu-user-jwt, x-ryu-client-id, x-ryu-client-label, x-ryu-surface",
	"access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
	"access-control-allow-origin": "*",
	"access-control-max-age": "3600",
};

export const browserIssues = new WeakMap<Page, string[]>();
export const expectedFixtureHttpErrors = new WeakMap<
	Page,
	Map<number, number>
>();

/** The console/pageerror guard every agent-sync proof test runs under. */
export function guardBrowserIssues(): void {
	test.beforeEach(async ({ page }) => {
		const issues: string[] = [];
		browserIssues.set(page, issues);
		expectedFixtureHttpErrors.set(page, new Map());
		page.on("console", (message) => {
			if (message.type() === "warning" || message.type() === "error") {
				const failedResponse =
					/^Failed to load resource: the server responded with a status of (\d{3})/.exec(
						message.text()
					);
				if (failedResponse) {
					const status = Number(failedResponse[1]);
					const expected = expectedFixtureHttpErrors.get(page);
					const remaining = expected?.get(status) ?? 0;
					if (remaining > 0) {
						expected?.set(status, remaining - 1);
						return;
					}
				}
				issues.push(`${message.type()}: ${message.text()}`);
			}
		});
		page.on("pageerror", (error) => issues.push(`pageerror: ${error.message}`));
	});

	test.afterEach(async ({ page }) => {
		expect(browserIssues.get(page) ?? []).toEqual([]);
	});
}

export function makeConflicts(): SyncItemFixture[] {
	return DEFAULT_CONFLICTS.map((item) => ({ ...item }));
}

export function jsonBody<FixturePayload>(value: FixturePayload): string {
	return JSON.stringify(value);
}

export async function fulfillJson<Payload>(
	route: Route,
	body: Payload,
	status = 200
): Promise<void> {
	await route.fulfill({
		body: jsonBody(body),
		headers: { ...corsHeaders, "content-type": "application/json" },
		status,
	});
}

export async function installCoreApiFixture(
	page: Page,
	options: FixtureOptions = {}
): Promise<CoreApiFixture> {
	const calls: CoreCall[] = [];
	let profiles = (options.profiles ?? DEFAULT_PROFILES).map((profile) => ({
		...profile,
	}));
	const status: StatusFixture = {
		activeOperations: 0,
		bindings: (options.bindings ?? DEFAULT_BINDINGS).map((binding) => ({
			...binding,
		})),
		items: (options.conflicts ?? makeConflicts()).map((item) => ({
			...item,
		})),
		nodeId: "node-agent-sync-fixture",
		profiles,
	};
	const failures = (options.failures ?? []).map((failure) => ({ ...failure }));
	const expectedErrors = expectedFixtureHttpErrors.get(page);
	for (const failure of failures) {
		expectedErrors?.set(
			failure.status,
			(expectedErrors?.get(failure.status) ?? 0) + failure.times
		);
	}
	let releaseInitialSyncReads = () => undefined;
	const initialSyncReads = new Promise<void>((resolve) => {
		releaseInitialSyncReads = resolve;
	});
	const scanCounts = new Map<string, number>();

	await page.route(`${CORE_ORIGIN}/**`, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const method = request.method().toUpperCase();
		if (method === "OPTIONS") {
			await route.fulfill({ headers: corsHeaders, status: 204 });
			return;
		}

		let body: ProofJsonValue = null;
		const rawBody = request.postData();
		if (rawBody) {
			body = parseProofJson(rawBody);
		}
		calls.push({
			body,
			headers: {
				authorization: request.headers().authorization,
				"x-ryu-user-jwt": request.headers()["x-ryu-user-jwt"],
			},
			method,
			path: `${url.pathname}${url.search}`,
		});

		if (
			options.holdInitialSyncReads &&
			method === "GET" &&
			(url.pathname === "/api/agent-sync/profiles" ||
				url.pathname === "/api/agent-sync/status")
		) {
			await initialSyncReads;
		}

		const bodyPath = z.object({ path: z.string() }).safeParse(body).data?.path;
		const failure = failures.find(
			(entry) =>
				entry.times > 0 &&
				entry.method === method &&
				entry.path === url.pathname &&
				(entry.bodyPath === undefined || entry.bodyPath === bodyPath)
		);
		if (failure) {
			failure.times -= 1;
			await fulfillJson(route, { error: failure.error }, failure.status);
			return;
		}

		if (url.pathname === "/api/workspace/list" && method === "GET") {
			await fulfillJson(route, {
				entries: [],
				home: "/Users/fixture",
				parent: "/Users",
				path: "/Users/fixture",
			});
			return;
		}

		if (url.pathname === "/api/gateway/status" && method === "GET") {
			await fulfillJson(route, {
				health: {
					auth_required: false,
					providers: ["anthropic", "openai"],
					status: "ok",
					version: "fixture",
				},
				metrics: {
					cache: {
						exact_hits: 0,
						hit_rate: 0,
						misses: 0,
						semantic_hits: 0,
					},
					composio: { calls: 0 },
					provider_health: {},
					provider_quota: {},
					providers: { errors: {}, requests: {} },
					requests: {},
					tokens: {},
				},
				reachable: true,
				url: "http://127.0.0.1:7981",
			});
			return;
		}

		if (url.pathname === "/api/plugins/contributions" && method === "GET") {
			await fulfillJson(route, { settings_tabs: [] });
			return;
		}

		if (url.pathname === "/api/plugins" && method === "GET") {
			await fulfillJson(route, { apps: [], plugins: [] });
			return;
		}

		if (url.pathname === "/api/agent-sync/profiles" && method === "GET") {
			await fulfillJson(route, { profiles });
			return;
		}

		if (url.pathname === "/api/agent-sync/profiles" && method === "POST") {
			// SAFETY: This private route receives the mounted Gateway AgentSyncSections saveCurrentProfile/toggleProfile drafts, whose actual saveAgentSyncProfile request JSON preserves the authored provider, root and boolean fields; this spec never injects raw requests.
			const input = body as {
				exportEnabled: boolean;
				id?: string;
				importEnabled: boolean;
				provider: ProfileFixture["provider"];
				root: string;
			};
			const existing = profiles.find(
				(profile) =>
					profile.id === input.id ||
					(profile.provider === input.provider && profile.root === input.root)
			);
			const saved: ProfileFixture = {
				conflictCount: existing?.conflictCount ?? 0,
				exportEnabled: input.exportEnabled,
				id: input.id ?? existing?.id ?? `profile-created-${input.provider}`,
				importEnabled: input.importEnabled,
				lastOperationId: existing?.lastOperationId ?? null,
				provider: input.provider,
				root: input.root,
				status: existing?.status ?? "idle",
				updatedAt: 1_790_810_100,
			};
			profiles = [
				...profiles.filter((profile) => profile.id !== saved.id),
				saved,
			].sort((left, right) => left.root.localeCompare(right.root));
			status.profiles = profiles;
			await fulfillJson(route, saved);
			return;
		}

		if (url.pathname === "/api/agent-sync/status" && method === "GET") {
			status.profiles = profiles;
			await fulfillJson(route, status);
			return;
		}

		if (url.pathname === "/api/agent-sync/scan" && method === "POST") {
			// SAFETY: The mounted AgentSyncSections scanner calls actual scanAgentSyncRoot, whose request serializer constructs { path, provider } from the root input and authored PROVIDERS selection; this fixture does not handle arbitrary external JSON.
			const input = body as { path: string; provider?: string };
			// SAFETY: The owned scan callers select only the actual claude/codex/cursor PROVIDERS values, and the absent-provider fallback is claude; this assertion is limited to those mounted fixture callers.
			const provider = (input.provider ??
				"claude") as ProfileFixture["provider"];
			const count = (scanCounts.get(input.path) ?? 0) + 1;
			scanCounts.set(input.path, count);
			const empty = input.path === options.emptyScanPath;
			const noAgent = input.path === options.noAgentScanPath;
			const threadItems = noAgent
				? [
						{
							engine: provider,
							id: "thread-agent-unavailable",
							message_count: 3,
							native_session_id: "native-session-unavailable",
							title: "Thread without an installed agent",
							updated_at: 1_790_810_200,
						},
					]
				: provider === "cursor"
					? []
					: [
							{
								engine: provider,
								id: "thread-001",
								message_count: 12,
								native_session_id: "native-session-001",
								title: "Fixture architecture review",
								updated_at: 1_790_810_201,
							},
							{
								engine: provider,
								id: "thread-002",
								message_count: 7,
								native_session_id: "native-session-002",
								title: "Fixture migration notes",
								updated_at: 1_790_810_202,
							},
						];
			const items = empty
				? []
				: [
						{
							id: "agent-setup/fixture-agent.md",
							kind: "agent",
							title: "Fixture agent definition",
						},
						{
							already_exists: true,
							id: "skills/fixture-skill/SKILL.md",
							kind: "skill",
							title: "Fixture skill",
						},
					];
			await fulfillJson(route, {
				agentId:
					noAgent || provider === "cursor" ? null : `agent-${provider}-fixture`,
				capabilities: {
					acpLoadResume: provider === "claude",
					nativeConversationExport: false,
					nativeThreads: provider !== "cursor",
					note: provider === "cursor" ? "Native history unavailable" : null,
					portableBundle: true,
					setupImport: true,
				},
				items,
				provider,
				root: input.path,
				threads: threadItems,
				warnings:
					provider === "cursor"
						? ["Cursor native history stays bundle-only."]
						: provider === "openclaw"
							? [
									"Channels configured in OpenClaw (telegram) are not imported; reconnect them in Ryu Channels.",
								]
							: [],
			});
			return;
		}

		if (
			url.pathname === "/api/agent-sync/threads/import" &&
			method === "POST"
		) {
			await fulfillJson(route, {
				already_imported: false,
				conversation_id: "conversation-thread-imported",
				dry_run: false,
				messages_added: 7,
				would_create: false,
			});
			return;
		}

		if (url.pathname === "/api/agent-sync/import" && method === "POST") {
			// SAFETY: Mounted AgentSyncSections runImport maps this fixture scan items to string id/kind pairs and calls actual importAgentSyncItems, whose serializer supplies boolean dryRun and the saved fixture string profileId.
			const input = body as {
				dryRun: boolean;
				items: Array<{ kind: string; id: string }>;
				profileId: string;
			};
			await fulfillJson(route, {
				conflicts: 0,
				dryRun: input.dryRun,
				failed: 0,
				imported: input.dryRun ? 0 : input.items.length,
				operationId: input.dryRun
					? "import-preview-fixture-001"
					: "import-fixture-001",
				profileId: input.profileId,
				results: input.items.map((item) => ({
					alreadyExists: false,
					id: item.id,
					kind: item.kind,
					status: input.dryRun ? "skipped" : "imported",
					title: item.id,
				})),
				skipped: input.dryRun ? input.items.length : 0,
			});
			return;
		}

		if (url.pathname === "/api/agent-sync/export" && method === "POST") {
			// SAFETY: Mounted AgentSyncSections runExport supplies its text destination and checkbox booleans to actual exportAgentSyncBundle; that serializer defaults all flags and preserves the optional saved fixture profileId.
			const input = body as {
				destination: string;
				dryRun: boolean;
				includeAgents: boolean;
				includeConversations: boolean;
				includeSkills: boolean;
				profileId?: string;
			};
			await fulfillJson(route, {
				acpResume: [],
				agents: input.includeAgents ? 2 : 0,
				bundleHash: "bundle-hash-fixture-001",
				bundlePath: `${input.destination}/.ryu-agent-sync.json`,
				conflicts: 0,
				conversations: input.includeConversations ? 3 : 0,
				destination: input.destination,
				dryRun: input.dryRun,
				messages: input.includeConversations ? 8 : 0,
				operationId: input.dryRun
					? "export-preview-fixture-001"
					: "export-fixture-001",
				profileId: input.profileId ?? null,
				projectedFiles: input.includeAgents || input.includeSkills ? 4 : 0,
				skills: input.includeSkills ? 5 : 0,
				warnings: [],
			});
			return;
		}

		if (url.pathname === "/api/agent-sync/acp/resume" && method === "POST") {
			// SAFETY: Mounted AgentSyncSections probes the bindings authored by this private fixture, passing each string conversationId to actual resumeAgentSyncAcpSession, whose request constructs that single field.
			const input = body as { conversationId: string };
			const replay = input.conversationId === "conversation-replay";
			await fulfillJson(route, {
				agentId: replay ? "agent-codex-fixture" : "agent-claude-fixture",
				conversationId: input.conversationId,
				mode: replay ? "replay" : "load",
				nativeSessionId: replay
					? "native-session-replay"
					: "native-session-load",
				reason: replay
					? "The agent cannot load this session; replaying the canonical transcript."
					: "The native session was loaded.",
				response: replay ? null : { sessionId: "native-session-load" },
			});
			return;
		}

		if (
			url.pathname === "/api/agent-sync/conflicts/resolve" &&
			method === "PUT"
		) {
			// SAFETY: Mounted AgentSyncSections resolves the authored fixture status items through actual resolveAgentSyncConflict; its request constructs itemId from sourceId and profileId from the same fixture string fields.
			const input = body as { itemId: string; profileId: string };
			status.items = status.items.map((item) =>
				item.profileId === input.profileId && item.sourceId === input.itemId
					? { ...item, state: "resolved" }
					: item
			);
			profiles = profiles.map((profile) =>
				profile.id === input.profileId
					? {
							...profile,
							conflictCount: Math.max(0, profile.conflictCount - 1),
							status: profile.conflictCount <= 1 ? "idle" : profile.status,
						}
					: profile
			);
			status.profiles = profiles;
			await fulfillJson(route, { resolved: true });
			return;
		}

		await fulfillJson(route, {});
	});

	return { calls, releaseInitialSyncReads };
}

export async function openGateway(
	page: Page,
	options: FixtureOptions = {}
): Promise<CoreApiFixture> {
	const fixture = await installCoreApiFixture(page, options);
	await page.goto("/agent-sync-proof.html");
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Import agent setup" })
	).toBeVisible();
	return fixture;
}

export async function openExportSection(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Export Ryu", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Export Ryu data" })
	).toBeVisible();
}

export function callsFor(
	fixture: CoreApiFixture,
	method: string,
	path: string
): CoreCall[] {
	return fixture.calls.filter(
		(call) => call.method === method && call.path === path
	);
}

export async function saveScreenshot(
	page: Page,
	name: string
): Promise<string> {
	const screenshotPath = test.info().outputPath(name);
	await page.screenshot({ fullPage: true, path: screenshotPath });
	return screenshotPath;
}
