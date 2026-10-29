// The accounts an agent's account access can allow, with readable labels, for
// the terminal: `ryu-cli agents access <id> available|pick` (src/cli/agents.ts) and
// the TUI editor's account-access panel (src/surfaces/agents).
//
// This mirrors what the desktop editor lists
// (`apps/desktop/src/components/agents/AgentAccountAccessPanel.tsx`, laid out by
// `packages/blocks/src/desktop/agent-account-access.tsx`) from the same Core
// endpoints:
//
//   Treg                            always (platform:treg)
//   Your accounts (Acts as you, Both)
//     Connected apps                GET /api/composio/status, /api/composio/connections
//     Model providers               GET /api/gateway/config (+ the engine's own vendor)
//     MCP sign-ins                  GET /api/plugins, /api/plugins/:id/auth
//     Services using your saved keys GET /api/mcp/servers (+ apps' own tools)
//     Control of your desktop       platform:desktop
//   Its own accounts (Its own identity, Both)
//     Its own logins                GET /api/vault/agent-accounts?agent_id=
//     Its own connected apps        GET /api/agents/:id/composio/connections
//
// Desktop's modules import web-only code, so the row builders are repeated here
// rather than imported; keep them in step. The pure key grammar, saved-key
// detection, BYOK provider list and engine-vendor lookup are shared from
// `@ryuhq/core-client/agent-account-access`. A source that fails to load says so
// on its section instead of looking empty, and keys the list cannot show (an
// account disconnected since, a key a newer node wrote) are reported as "not
// listed" so a picker carries them through instead of dropping them.

import {
	accountKey,
	appUsesSavedKeys,
	BYOK_MODEL_PROVIDERS,
	byokProviderRegistryId,
	COMPATIBLE_CHAT_PROVIDERS,
	DESKTOP_ACCOUNT_KEY,
	engineModelProvider,
	sourceReferencesSavedKey,
} from "@ryuhq/core-client/agent-account-access";
import { toAgentLaunchCheckBody } from "@ryuhq/core-client/agents";
import { ApiError } from "@ryuhq/core-client/client";
import { z } from "zod";
import {
	type AgentIdentityMode,
	accountKeyKind,
	modeHasOwnAccounts,
	modeUsesYourAccounts,
	TREG_ACCOUNT_KEY,
} from "./agentIdentity.ts";

export {
	accountKey,
	appUsesSavedKeys,
	DESKTOP_ACCOUNT_KEY,
	engineModelProvider,
	sourceReferencesSavedKey,
};

// ── Shapes ──────────────────────────────────────────────────────────────────

export type AccountSectionId =
	| "treg"
	| "connected-apps"
	| "model-providers"
	| "mcp-sign-ins"
	| "saved-keys"
	| "desktop"
	| "own-logins"
	| "own-connected-apps"
	| "not-listed";

export type AccountSectionOwner = "platform" | "yours" | "own";

/** One account the agent may be allowed, as a picker row. */
export interface AvailableAccount {
	/** A second line of context: the account id, profile, user name… */
	detail: string | null;
	key: string;
	section: AccountSectionId;
	/** Connection state worth showing ("Expired", "Sign in again", "2FA"). */
	status: string | null;
	title: string;
}

export interface AccountSection {
	/** Shown when the section has no rows and no error. */
	empty: string;
	/** Why the section could not be loaded; its rows may be incomplete. */
	error: string | null;
	id: AccountSectionId;
	owner: AccountSectionOwner;
	rows: AvailableAccount[];
	title: string;
}

export interface AvailableAccounts {
	/** Groups the identity mode hides, with why (desktop's one-line note). */
	hiddenGroups: string[];
	sections: AccountSection[];
}

/** The Core calls the catalog makes. GET returns parsed JSON; errors throw. */
export interface AccountCatalogCore {
	get: (path: string) => Promise<unknown>;
	post: (path: string, body: unknown) => Promise<unknown>;
}

export interface AvailableAccountsInput {
	/** The saved agent; `null` for an agent with no record yet. */
	agentId: string | null;
	engine: string | null;
	identityMode: AgentIdentityMode;
	/** The mode Core holds; apps of its own need it saved. Defaults to `identityMode`. */
	savedIdentityMode?: AgentIdentityMode | null;
}

const SECTION_TITLES: Record<AccountSectionId, string> = {
	treg: "Treg",
	"connected-apps": "Connected apps",
	"model-providers": "Model providers",
	"mcp-sign-ins": "MCP sign-ins",
	"saved-keys": "Services using your saved keys",
	desktop: "Control of your desktop",
	"own-logins": "Its own logins",
	"own-connected-apps": "Its own connected apps",
	"not-listed": "Allowed but not listed now",
};

/** The group headings, as on desktop. */
export const ACCOUNT_OWNER_HEADINGS: Record<AccountSectionOwner, string> = {
	platform: "Platform",
	yours: "Your accounts",
	own: "Its own accounts",
};

const HIDDEN_YOURS =
	"Your accounts: not shown, because this agent has only its own identity and never uses yours.";
const HIDDEN_OWN =
	"Its own accounts: not shown, because this agent acts as you and has no accounts of its own.";

// ── Wire codecs (loose: unknown fields pass through) ────────────────────────

const composioStatusSchema = z.looseObject({
	configured: z.boolean().optional(),
});
const connectionWireSchema = z.looseObject({
	active: z.boolean().optional(),
	id: z.string().optional(),
	status: z.string().optional(),
	toolkit: z.string().optional(),
});
const connectionsSchema = z.looseObject({
	configured: z.boolean().optional(),
	data: z.array(connectionWireSchema).optional(),
});
const pluginsSchema = z.looseObject({
	apps: z
		.array(
			z.looseObject({
				enabled: z.boolean().optional(),
				id: z.string(),
				mcp_servers: z
					.record(
						z.string(),
						z.looseObject({
							auth: z.looseObject({ type: z.string().optional() }).nullish(),
							url: z.string().nullish(),
						})
					)
					.nullish(),
				name: z.string().optional(),
				runnables: z
					.array(
						z.looseObject({
							config: z.unknown().optional(),
							kind: z.string().optional(),
						})
					)
					.nullish(),
			})
		)
		.optional(),
});
const mcpOAuthSchema = z.looseObject({
	servers: z
		.array(
			z.looseObject({
				connections: z
					.array(
						z.looseObject({
							account_label: z.string().nullish(),
							profile_id: z.string(),
							status: z.string().optional(),
						})
					)
					.optional(),
				server_name: z.string(),
			})
		)
		.optional(),
});
const mcpServersSchema = z.looseObject({
	servers: z
		.array(
			z.looseObject({
				name: z.string(),
				owner_plugin_id: z.string().nullish(),
				saved_key_account: z.string().nullish(),
			})
		)
		.optional(),
});
const providerViewSchema = z.looseObject({
	api_key: z.string().nullish(),
	api_key_count: z.number().optional(),
});
const gatewayConfigSchema = z.looseObject({
	providers: z
		.looseObject({
			compatible: z.record(z.string(), providerViewSchema).nullish(),
			core: z.looseObject({ has_token: z.boolean().optional() }).nullish(),
			genai: z
				.looseObject({
					gemini_account_count: z.number().optional(),
					keys: z.array(z.string()).optional(),
					sdk_providers: z
						.array(
							z.looseObject({
								auth_kind: z.string().optional(),
								configured: z.boolean().optional(),
								label: z.string(),
								provider_id: z.string(),
							})
						)
						.optional(),
				})
				.nullish(),
		})
		.nullish(),
});
const vaultAccountsSchema = z.looseObject({
	accounts: z
		.array(
			z.looseObject({
				email: z.string().nullish(),
				has_totp: z.boolean().optional(),
				host: z.string().optional(),
				id: z.string(),
				label: z.string().nullish(),
				site: z.string().optional(),
				username: z.string().nullish(),
			})
		)
		.optional(),
});
const launchCheckSchema = z.looseObject({
	vendor_provider: z.string().nullish(),
});

export type GatewayProvidersWire = NonNullable<
	z.output<typeof gatewayConfigSchema>["providers"]
>;
export type PluginWire = NonNullable<
	z.output<typeof pluginsSchema>["apps"]
>[number];
export type McpServerWire = NonNullable<
	z.output<typeof mcpServersSchema>["servers"]
>[number];

// ── Row builders (pure) ─────────────────────────────────────────────────────

function capitalized(value: string): string {
	const trimmed = value.trim().toLowerCase();
	return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : "";
}

function composioStatus(status: string, active: boolean): string | null {
	if (active) {
		return null;
	}
	return capitalized(status) || "Inactive";
}

/** Rows for Composio connections, yours (`composio:`) or the agent's own. */
export function composioRows(
	json: unknown,
	section: "connected-apps" | "own-connected-apps"
): AvailableAccount[] {
	const parsed = connectionsSchema.parse(json);
	return (parsed.data ?? []).flatMap((wire) => {
		const id = wire.id ?? "";
		if (!id) {
			return [];
		}
		return [
			{
				detail: id,
				key:
					section === "connected-apps"
						? accountKey.composio(id)
						: accountKey.agentComposio(id),
				section,
				status: composioStatus(wire.status ?? "", wire.active ?? false),
				title: wire.toolkit || "Connected app",
			},
		];
	});
}

/** Enabled apps that declare an OAuth MCP server, as desktop's `mcpApps`. */
export function mcpOAuthApps(apps: readonly PluginWire[]): PluginWire[] {
	return apps.filter(
		(app) =>
			app.enabled === true &&
			Object.values(app.mcp_servers ?? {}).some(
				(server) => server.auth?.type === "oauth" && Boolean(server.url)
			)
	);
}

/** Rows for one app's MCP sign-ins (`GET /api/plugins/:id/auth`). */
export function mcpSignInRows(
	app: Pick<PluginWire, "id" | "name">,
	json: unknown
): AvailableAccount[] {
	const parsed = mcpOAuthSchema.parse(json);
	const rows: AvailableAccount[] = [];
	for (const server of parsed.servers ?? []) {
		for (const connection of server.connections ?? []) {
			rows.push({
				detail: [connection.account_label, `profile ${connection.profile_id}`]
					.filter(Boolean)
					.join(" · "),
				key: accountKey.mcp(connection.profile_id, app.id, server.server_name),
				section: "mcp-sign-ins",
				status: connection.status === "connected" ? null : "Sign in again",
				title: `${app.name ?? app.id} · ${server.server_name}`,
			});
		}
	}
	return rows;
}

/**
 * "Services using your saved keys": every MCP server Core reports as using
 * one, and every enabled app whose own tools do, one row per id.
 */
export function savedKeyRows(
	servers: readonly McpServerWire[],
	apps: readonly PluginWire[]
): AvailableAccount[] {
	const appNames = new Map(apps.map((app) => [app.id, app.name ?? app.id]));
	const rows = new Map<string, AvailableAccount>();
	for (const server of servers) {
		const id = server.saved_key_account;
		if (!id) {
			continue;
		}
		const key = accountKey.savedKey(id);
		if (!rows.has(key)) {
			rows.set(key, {
				detail: server.owner_plugin_id ? "App" : "MCP server you added",
				key,
				section: "saved-keys",
				status: null,
				title: appNames.get(id) ?? id,
			});
		}
	}
	for (const app of apps) {
		const key = accountKey.savedKey(app.id);
		if (
			app.enabled === true &&
			!rows.has(key) &&
			appUsesSavedKeys(app.runnables ?? [])
		) {
			rows.set(key, {
				detail: "App",
				key,
				section: "saved-keys",
				status: null,
				title: app.name ?? app.id,
			});
		}
	}
	return [...rows.values()].sort((left, right) =>
		left.title.localeCompare(right.title)
	);
}

/** One of your model providers, by its Gateway registry id. */
export interface ModelProviderRow {
	id: string;
	label: string;
}

function keyCount(view: unknown): number {
	const parsed = providerViewSchema.safeParse(view);
	if (!parsed.success) {
		return 0;
	}
	return parsed.data.api_key_count ?? (parsed.data.api_key ? 1 : 0);
}

function byokAccountCount(
	providers: GatewayProvidersWire,
	slug: string
): number {
	if (slug === "gemini") {
		return (
			providers.genai?.gemini_account_count ??
			(providers.genai?.keys?.includes("gemini") ? 1 : 0)
		);
	}
	const compatible = providers.compatible?.[slug];
	if (compatible) {
		return keyCount(compatible);
	}
	return keyCount((providers as Record<string, unknown>)[slug]);
}

/** Your configured chat model providers, in desktop's order. */
export function modelProviders(
	providers: GatewayProvidersWire | null
): ModelProviderRow[] {
	if (!providers) {
		return [];
	}
	const rows: ModelProviderRow[] = [];
	const seen = new Set<string>();
	const add = (id: string, label: string) => {
		if (!seen.has(id)) {
			seen.add(id);
			rows.push({ id, label });
		}
	};
	for (const { slug, label } of BYOK_MODEL_PROVIDERS) {
		if (byokAccountCount(providers, slug) > 0) {
			add(byokProviderRegistryId(slug), label);
		}
	}
	for (const [id, label] of Object.entries(COMPATIBLE_CHAT_PROVIDERS)) {
		if (keyCount(providers.compatible?.[id]) > 0) {
			add(id, label);
		}
	}
	for (const sdk of providers.genai?.sdk_providers ?? []) {
		if (sdk.configured && sdk.auth_kind !== "no_auth") {
			add(sdk.provider_id, sdk.label);
		}
	}
	if (providers.core?.has_token) {
		add("core", "Subscriptions you signed in to through Ryu, if any");
		add("kiro", "Kiro sign-in, if any");
	}
	return rows;
}

/**
 * Model-provider rows: your providers, plus the engine's own vendor. Core's
 * launch check names the vendor under the current routing; when it names
 * another (or none), the local guess is dropped, as on desktop.
 */
export function modelProviderRows(
	providers: GatewayProvidersWire | null,
	engine: string | null,
	vendorProvider?: string | null
): AvailableAccount[] {
	const rows: AvailableAccount[] = modelProviders(providers).map(
		(provider) => ({
			detail: null,
			key: accountKey.provider(provider.id),
			section: "model-providers",
			status: null,
			title: provider.label,
		})
	);
	const vendor = engineModelProvider(engine);
	if (
		!vendor ||
		(vendorProvider !== undefined && vendorProvider !== vendor.id)
	) {
		return rows;
	}
	const key = accountKey.provider(vendor.id);
	const existing = rows.find((row) => row.key === key);
	if (existing) {
		existing.detail = `Also covers ${vendor.label}`;
		return rows;
	}
	return [
		{
			detail: null,
			key,
			section: "model-providers",
			status: null,
			title: vendor.label,
		},
		...rows,
	];
}

/** Rows for the agent's own website logins (metadata only, never a secret). */
export function ownLoginRows(json: unknown): AvailableAccount[] {
	const parsed = vaultAccountsSchema.parse(json);
	return (parsed.accounts ?? []).map((account) => ({
		detail:
			[account.username ?? account.email, account.label]
				.filter(Boolean)
				.join(" · ") || null,
		key: accountKey.agent(account.id),
		section: "own-logins",
		status: account.has_totp ? "2FA" : null,
		title: account.host || account.site || account.id,
	}));
}

// ── Loading ─────────────────────────────────────────────────────────────────

function failure(error: unknown, fallback: string): string {
	if (error instanceof ApiError && error.serverMessage) {
		return `${fallback} (${error.serverMessage})`;
	}
	return fallback;
}

function section(
	id: AccountSectionId,
	owner: AccountSectionOwner,
	rows: AvailableAccount[],
	empty: string,
	error: string | null = null
): AccountSection {
	return { empty, error, id, owner, rows, title: SECTION_TITLES[id] };
}

const TREG_ROW: AvailableAccount = {
	detail:
		"Metered tool APIs through Ryu's Treg router, including calls an app makes later for work this agent set up.",
	key: TREG_ACCOUNT_KEY,
	section: "treg",
	status: null,
	title: "Treg",
};

const DESKTOP_ROW: AvailableAccount = {
	detail: "Ghost using your mouse and keyboard, and what Shadow captured.",
	key: DESKTOP_ACCOUNT_KEY,
	section: "desktop",
	status: null,
	title: "Control of your desktop",
};

/** Run a load and its parsing, turning any failure of either into a result. */
async function settle<T>(
	work: () => Promise<T>
): Promise<{ ok: true; value: T } | { error: unknown; ok: false }> {
	try {
		return { ok: true, value: await work() };
	} catch (error) {
		return { error, ok: false };
	}
}

async function loadVendorProvider(
	core: AccountCatalogCore,
	input: AvailableAccountsInput
): Promise<string | null | undefined> {
	if (!engineModelProvider(input.engine)) {
		return;
	}
	const result = await settle(() =>
		core.post(
			"/api/agents/launch-check",
			toAgentLaunchCheckBody({
				accountAccess: null,
				agentId: input.agentId,
				engine: input.engine ?? "",
				identityMode: input.identityMode,
			})
		)
	);
	if (!result.ok) {
		return;
	}
	const parsed = launchCheckSchema.safeParse(result.value);
	return parsed.success ? (parsed.data.vendor_provider ?? null) : undefined;
}

async function loadYourSections(
	core: AccountCatalogCore,
	input: AvailableAccountsInput,
	composioConfigured: boolean | null
): Promise<AccountSection[]> {
	const [connections, plugins, mcpServers, gateway, vendorProvider] =
		await Promise.all([
			composioConfigured
				? settle(async () =>
						composioRows(
							await core.get("/api/composio/connections"),
							"connected-apps"
						)
					)
				: Promise.resolve(null),
			settle(
				async () =>
					pluginsSchema.parse(await core.get("/api/plugins")).apps ?? []
			),
			settle(
				async () =>
					mcpServersSchema.parse(await core.get("/api/mcp/servers")).servers ??
					[]
			),
			settle(
				async () =>
					gatewayConfigSchema.parse(await core.get("/api/gateway/config"))
						.providers ?? null
			),
			loadVendorProvider(core, input),
		]);

	let connectedApps: AccountSection;
	if (composioConfigured === null) {
		connectedApps = section(
			"connected-apps",
			"yours",
			[],
			"",
			"Couldn't check whether Composio is set up on this node."
		);
	} else if (connections === null) {
		connectedApps = section(
			"connected-apps",
			"yours",
			[],
			"Composio isn't set up on this node."
		);
	} else {
		const rows = connections.ok ? connections.value : [];
		connectedApps = section(
			"connected-apps",
			"yours",
			rows,
			"No connected apps yet.",
			connections.ok
				? null
				: failure(connections.error, "Couldn't load your connected apps.")
		);
	}

	const providers = gateway.ok ? gateway.value : null;
	const models = section(
		"model-providers",
		"yours",
		modelProviderRows(providers, input.engine, vendorProvider),
		"No provider keys yet.",
		gateway.ok
			? null
			: failure(gateway.error, "Couldn't load your model providers.")
	);

	const apps = plugins.ok ? plugins.value : [];
	const oauthApps = mcpOAuthApps(apps);
	const signIns = await Promise.all(
		oauthApps.map((app) =>
			settle(async () =>
				mcpSignInRows(
					app,
					await core.get(`/api/plugins/${encodeURIComponent(app.id)}/auth`)
				)
			)
		)
	);
	const mcpRows: AvailableAccount[] = [];
	const mcpFailures: string[] = [];
	for (const [index, app] of oauthApps.entries()) {
		const result = signIns[index];
		if (result?.ok) {
			mcpRows.push(...result.value);
		} else {
			mcpFailures.push(app.name ?? app.id);
		}
	}
	let mcpError: string | null = null;
	if (!plugins.ok) {
		mcpError = failure(plugins.error, "Couldn't load your apps.");
	} else if (mcpFailures.length > 0) {
		mcpError = `Couldn't load the sign-ins of ${mcpFailures.join(", ")}.`;
	}
	const mcp = section(
		"mcp-sign-ins",
		"yours",
		mcpRows,
		"No MCP servers signed in yet.",
		mcpError
	);

	const servers = mcpServers.ok ? mcpServers.value : [];
	let savedKeysError: string | null = null;
	if (!mcpServers.ok) {
		savedKeysError = failure(
			mcpServers.error,
			"Couldn't load your MCP servers."
		);
	} else if (!plugins.ok) {
		savedKeysError = "Couldn't load your apps.";
	}
	const savedKeys = section(
		"saved-keys",
		"yours",
		savedKeyRows(servers, apps),
		"No services use your saved keys yet.",
		savedKeysError
	);

	return [
		connectedApps,
		models,
		mcp,
		savedKeys,
		section("desktop", "yours", [DESKTOP_ROW], ""),
	];
}

async function loadOwnSections(
	core: AccountCatalogCore,
	input: AvailableAccountsInput,
	composioConfigured: boolean | null
): Promise<AccountSection[]> {
	const { agentId } = input;
	if (agentId === null) {
		const unsaved =
			"Save the agent first. It can then have accounts of its own.";
		return [
			section("own-logins", "own", [], unsaved),
			section("own-connected-apps", "own", [], unsaved),
		];
	}
	const savedMode = input.savedIdentityMode ?? input.identityMode;
	// Core answers 409 for the apps of an agent saved as Acts as you.
	const appsNeedSave = savedMode === "managed";
	const agentPath = encodeURIComponent(agentId);
	const [logins, apps] = await Promise.all([
		settle(async () =>
			ownLoginRows(
				await core.get(
					`/api/vault/agent-accounts?agent_id=${encodeURIComponent(agentId)}`
				)
			)
		),
		composioConfigured && !appsNeedSave
			? settle(async () =>
					composioRows(
						await core.get(`/api/agents/${agentPath}/composio/connections`),
						"own-connected-apps"
					)
				)
			: Promise.resolve(null),
	]);
	const ownLogins = section(
		"own-logins",
		"own",
		logins.ok ? logins.value : [],
		"No accounts yet. The agent adds one when it signs up for a site.",
		logins.ok
			? null
			: failure(logins.error, "Couldn't load this agent's accounts.")
	);
	let ownApps: AccountSection;
	if (appsNeedSave) {
		ownApps = section(
			"own-connected-apps",
			"own",
			[],
			"Save the agent as Its own identity or Both first. It can then connect apps of its own."
		);
	} else if (composioConfigured === null) {
		ownApps = section(
			"own-connected-apps",
			"own",
			[],
			"",
			"Couldn't check whether Composio is set up on this node."
		);
	} else if (apps === null) {
		ownApps = section(
			"own-connected-apps",
			"own",
			[],
			"Composio isn't set up on this node."
		);
	} else {
		ownApps = section(
			"own-connected-apps",
			"own",
			apps.ok ? apps.value : [],
			"No apps connected to its own identity yet.",
			apps.ok
				? null
				: failure(apps.error, "Couldn't load this agent's connected apps.")
		);
	}
	return [ownLogins, ownApps];
}

/**
 * Load every account the agent may be allowed under its identity mode, from
 * the same Core endpoints the desktop editor reads. Never throws: a source
 * that fails to load, or answers with a body that does not parse, is reported
 * on its section.
 */
export async function loadAvailableAccounts(
	core: AccountCatalogCore,
	input: AvailableAccountsInput
): Promise<AvailableAccounts> {
	const showYours = modeUsesYourAccounts(input.identityMode);
	const showOwn = modeHasOwnAccounts(input.identityMode);
	const status = await settle(() => core.get("/api/composio/status"));
	let composioConfigured: boolean | null = null;
	if (status.ok) {
		const parsed = composioStatusSchema.safeParse(status.value);
		composioConfigured = parsed.success
			? (parsed.data.configured ?? false)
			: null;
	}
	const [yours, own] = await Promise.all([
		showYours
			? loadYourSections(core, input, composioConfigured)
			: Promise.resolve([]),
		showOwn
			? loadOwnSections(core, input, composioConfigured)
			: Promise.resolve([]),
	]);
	const hiddenGroups: string[] = [];
	if (!showYours) {
		hiddenGroups.push(HIDDEN_YOURS);
	}
	if (!showOwn) {
		hiddenGroups.push(HIDDEN_OWN);
	}
	return {
		hiddenGroups,
		sections: [section("treg", "platform", [TREG_ROW], ""), ...yours, ...own],
	};
}

/**
 * The catalog to show when loading it failed outright: no rows, and an error
 * that also keeps a limit from starting (`accountLimitStartBlocked`).
 */
export function accountCatalogLoadFailed(error: unknown): AvailableAccounts {
	return {
		hiddenGroups: [],
		sections: [
			section(
				"treg",
				"platform",
				[],
				"",
				failure(error, "Couldn't load your accounts. Press r to try again.")
			),
		],
	};
}

// ── Picking (pure) ──────────────────────────────────────────────────────────

/** Every listed row, in display order, de-duplicated by key. */
export function listedAccounts(
	accounts: AvailableAccounts
): AvailableAccount[] {
	const seen = new Set<string>();
	const rows: AvailableAccount[] = [];
	for (const entry of accounts.sections) {
		for (const row of entry.rows) {
			if (!seen.has(row.key)) {
				seen.add(row.key);
				rows.push(row);
			}
		}
	}
	return rows;
}

/** Allowed keys the list does not show; a picker keeps them. */
export function keysNotListed(
	accountAccess: readonly string[] | null,
	accounts: AvailableAccounts
): string[] {
	if (accountAccess === null) {
		return [];
	}
	const listed = new Set(listedAccounts(accounts).map((row) => row.key));
	return accountAccess.filter((key) => !listed.has(key));
}

/** A row for a kept key that is not listed, labelled by its kind. */
export function notListedRow(key: string): AvailableAccount {
	return {
		detail: "Disconnected since, or not shown for how it works; kept",
		key,
		section: "not-listed",
		status: null,
		title: accountKeyKind(key)?.label ?? "Other",
	};
}

/** Whether the row is allowed: everything is under no limit. */
export function isAccountAllowed(
	accountAccess: readonly string[] | null,
	key: string
): boolean {
	return accountAccess === null || accountAccess.includes(key);
}

/**
 * Toggle one key. Toggling under no limit first starts a limit from every
 * listed account (desktop's "Limit to selected accounts" switch), so it only
 * ever narrows; every other key is kept untouched.
 */
export function toggleAccountAccess(
	accountAccess: readonly string[] | null,
	accounts: AvailableAccounts,
	key: string
): string[] {
	const current =
		accountAccess === null ? startAccountLimit(accounts) : [...accountAccess];
	return current.includes(key)
		? current.filter((existing) => existing !== key)
		: [...current, key];
}

/**
 * Why a limit can't start from the listed accounts now, or `null` when it can.
 * A fresh limit keeps only the accounts listed, so starting one while a section
 * failed to load would also take away that section's accounts, which the user
 * never saw to untick. Names the sections that failed.
 */
export function accountLimitStartBlocked(
	accounts: AvailableAccounts
): string | null {
	const failed = accounts.sections.filter((entry) => entry.error !== null);
	if (failed.length === 0) {
		return null;
	}
	const names = failed.map((entry) => entry.title).join(", ");
	return `Couldn't load ${names}, so a limit started now would also take those accounts away. Nothing was changed; try again once they load.`;
}

/** The list a fresh limit starts from: every listed account, Treg included. */
export function startAccountLimit(accounts: AvailableAccounts): string[] {
	return listedAccounts(accounts).map((row) => row.key);
}

/**
 * The rows a picker shows, in order: every listed account, then the keys the
 * saved list allows that are not listed now, so they can be seen and removed
 * rather than silently kept or dropped.
 */
export function accountPickerRows(
	accounts: AvailableAccounts,
	savedAccess: readonly string[] | null
): AvailableAccount[] {
	return [
		...listedAccounts(accounts),
		...keysNotListed(savedAccess, accounts).map(notListedRow),
	];
}

/** Every allowed key plus every listed one: what "all" selects. */
export function selectAllAccounts(
	accountAccess: readonly string[] | null,
	accounts: AvailableAccounts
): string[] {
	const next = [...(accountAccess ?? [])];
	for (const key of startAccountLimit(accounts)) {
		if (!next.includes(key)) {
			next.push(key);
		}
	}
	return next;
}

/** Whether two allowlists mean the same thing (order does not matter). */
export function sameAccountAccess(
	left: readonly string[] | null,
	right: readonly string[] | null
): boolean {
	if (left === null || right === null) {
		return left === right;
	}
	const a = new Set(left);
	const b = new Set(right);
	return a.size === b.size && [...a].every((key) => b.has(key));
}

export type PickCommand =
	| { kind: "toggle"; indexes: number[] }
	| { kind: "all" }
	| { kind: "none" }
	| { kind: "no-limit" }
	| { kind: "save" }
	| { kind: "cancel" }
	| { kind: "show" }
	| { kind: "invalid"; message: string };

const RANGE = /^(\d+)(?:-(\d+))?$/;
const SEPARATORS = /[\s,]+/;

/**
 * One line typed at the picker: row numbers and ranges to toggle ("1 3-5"),
 * or a word: all, none, unlimited, save, cancel. Empty shows the list again.
 */
export function parsePickCommand(input: string, rowCount: number): PickCommand {
	const text = input.trim().toLowerCase();
	switch (text) {
		case "":
			return { kind: "show" };
		case "all":
			return { kind: "all" };
		case "none":
			return { kind: "none" };
		case "unlimited":
		case "no-limit":
		case "nolimit":
		case "clear":
			return { kind: "no-limit" };
		case "s":
		case "save":
		case "done":
			return { kind: "save" };
		case "q":
		case "quit":
		case "cancel":
			return { kind: "cancel" };
		default:
			break;
	}
	const indexes: number[] = [];
	for (const token of text.split(SEPARATORS).filter(Boolean)) {
		const match = RANGE.exec(token);
		if (!match) {
			return {
				kind: "invalid",
				message: `'${token}' is not a row number. Type numbers such as 1 3-5, or all, none, unlimited, save or cancel.`,
			};
		}
		const from = Number(match[1]);
		const to = match[2] === undefined ? from : Number(match[2]);
		if (from < 1 || to > rowCount || from > to) {
			return {
				kind: "invalid",
				message: `There is no row ${token}. Rows go from 1 to ${rowCount}.`,
			};
		}
		for (let index = from; index <= to; index += 1) {
			indexes.push(index - 1);
		}
	}
	return { kind: "toggle", indexes };
}
