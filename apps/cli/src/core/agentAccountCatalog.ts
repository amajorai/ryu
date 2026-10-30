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
	DESKTOP_ACCOUNT_KEY,
	engineModelProvider,
} from "@ryuhq/core-client/agent-account-access";
import { toAgentLaunchCheckBody } from "@ryuhq/core-client/agents";
import { ApiError } from "@ryuhq/core-client/client";
import { tf } from "../i18n/translate.ts";
import {
	composioRows,
	mcpOAuthApps,
	mcpSignInRows,
	modelProviderRows,
	ownLoginRows,
	savedKeyRows,
} from "./agentAccountCatalog-rows.ts";
import type {
	AccountCatalogCore,
	AccountSection,
	AccountSectionId,
	AccountSectionOwner,
	AvailableAccount,
	AvailableAccounts,
	AvailableAccountsInput,
} from "./agentAccountCatalog-types.ts";
import {
	composioStatusSchema,
	gatewayConfigSchema,
	launchCheckSchema,
	mcpServersSchema,
	pluginsSchema,
} from "./agentAccountCatalog-wire.ts";
import {
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
} from "@ryuhq/core-client/agent-account-access";
export {
	accountLimitStartBlocked,
	accountPickerRows,
	isAccountAllowed,
	keysNotListed,
	listedAccounts,
	notListedRow,
	type PickCommand,
	parsePickCommand,
	sameAccountAccess,
	selectAllAccounts,
	startAccountLimit,
	toggleAccountAccess,
} from "./agentAccountCatalog-picking.ts";
export {
	composioRows,
	type ModelProviderRow,
	mcpOAuthApps,
	mcpSignInRows,
	modelProviderRows,
	modelProviders,
	ownLoginRows,
	savedKeyRows,
} from "./agentAccountCatalog-rows.ts";
export type {
	AccountCatalogCore,
	AccountSection,
	AccountSectionId,
	AccountSectionOwner,
	AvailableAccount,
	AvailableAccounts,
	AvailableAccountsInput,
} from "./agentAccountCatalog-types.ts";
export type {
	GatewayProvidersWire,
	McpServerWire,
	PluginWire,
} from "./agentAccountCatalog-wire.ts";

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
		mcpError = tf("Couldn't load the sign-ins of {apps}.", {
			apps: mcpFailures.join(", "),
		});
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
