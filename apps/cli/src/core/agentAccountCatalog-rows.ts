// Pure row builders for the agent account catalog (see ./agentAccountCatalog.ts).

import {
	accountKey,
	appUsesSavedKeys,
	BYOK_MODEL_PROVIDERS,
	byokProviderRegistryId,
	COMPATIBLE_CHAT_PROVIDERS,
	engineModelProvider,
} from "@ryuhq/core-client/agent-account-access";
import type { AvailableAccount } from "./agentAccountCatalog-types.ts";
import {
	connectionsSchema,
	type GatewayProvidersWire,
	type McpServerWire,
	mcpOAuthSchema,
	type PluginWire,
	providerViewSchema,
	vaultAccountsSchema,
} from "./agentAccountCatalog-wire.ts";

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
