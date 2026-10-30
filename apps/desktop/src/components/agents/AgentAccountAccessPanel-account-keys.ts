import {
	type AccountAccessRow,
	DESKTOP_ACCOUNT_KEY,
	TREG_ACCOUNT_KEY,
} from "@ryu/blocks/desktop/agent-account-access.tsx";
import { appUsesSavedKeys } from "@ryuhq/core-client/agent-account-access";
import {
	agentEngineModelProvider,
	agentModelProviders,
} from "@/src/components/agents/agent-provider-access.ts";
import type { McpServer } from "@/src/lib/api/mcp.ts";
import type { AppInfo } from "@/src/lib/api/plugins.ts";

/** Account-key builders. Keep in step with `apps/core/src/agent_access.rs`. */
export const accountKey = {
	agent: (vaultAccountId: string) => `agent:${vaultAccountId}`,
	/** An app connected to the agent's own Composio identity. */
	agentComposio: (connectedAccountId: string) =>
		`agent-composio:${connectedAccountId}`,
	composio: (connectedAccountId: string) => `composio:${connectedAccountId}`,
	mcp: (profileId: string, pluginId: string, serverName: string) =>
		`mcp:${profileId}:${pluginId}:${serverName}`,
	/** Ghost controlling your desktop, and what Shadow captured from it. */
	desktop: DESKTOP_ACCOUNT_KEY,
	/** A model provider, by its Gateway registry id (Gemini is `genai`). */
	provider: (registryId: string) => `provider:${registryId}`,
	/** An MCP server or app's tools that use one of your saved keys. */
	savedKey: (serverOrPluginId: string) => `mcp-secret:${serverOrPluginId}`,
	treg: TREG_ACCOUNT_KEY,
} as const;

/**
 * The "Services using your saved keys" rows: every MCP server Core reports as
 * using one, and every enabled app whose own tools do, one row per id.
 */
export function savedKeyRows(
	servers: readonly Pick<
		McpServer,
		"name" | "ownerPluginId" | "savedKeyAccount"
	>[],
	apps: readonly Pick<AppInfo, "enabled" | "id" | "name" | "runnables">[]
): AccountRow[] {
	const appNames = new Map(apps.map((app) => [app.id, app.name]));
	const rows = new Map<string, AccountRow>();
	for (const server of servers) {
		const id = server.savedKeyAccount;
		if (!id) {
			continue;
		}
		const key = accountKey.savedKey(id);
		if (!rows.has(key)) {
			rows.set(key, {
				detail: server.ownerPluginId ? "App" : "MCP server you added",
				key,
				title: appNames.get(id) ?? id,
			});
		}
	}
	for (const app of apps) {
		const key = accountKey.savedKey(app.id);
		if (app.enabled && !rows.has(key) && appUsesSavedKeys(app.runnables)) {
			rows.set(key, { detail: "App", key, title: app.name });
		}
	}
	return [...rows.values()].sort((left, right) =>
		left.title.localeCompare(right.title)
	);
}

/** Add or remove one key from an explicit allowlist, keeping every other key. */
export function toggleAccountKey(
	access: readonly string[],
	key: string,
	allowed: boolean
): string[] {
	const rest = access.filter((existing) => existing !== key);
	return allowed ? [...rest, key] : rest;
}

/**
 * The list a fresh limit starts from: everything currently visible, so turning
 * the switch on changes nothing until the user unticks something.
 */
export function startAccountLimit(visibleKeys: readonly string[]): string[] {
	return [...new Set(visibleKeys)];
}

export type AccountRow = AccountAccessRow;

export function composioStatusLabel(status: string, active: boolean) {
	if (active) {
		return { label: "Active", muted: false };
	}
	const normalized = status.trim().toLowerCase();
	return {
		label: normalized
			? normalized.charAt(0).toUpperCase() + normalized.slice(1)
			: "Inactive",
		muted: true,
	};
}

/**
 * The model-provider rows: your configured providers, plus the vendor the
 * agent's engine calls itself. When that vendor already has a row (a BYOK key
 * under the same id), the row says the engine's sign-in is covered too.
 *
 * `vendorProvider` is Core's launch-check answer for which vendor the engine
 * calls itself under the current routing (Codex only on its ChatGPT
 * passthrough). `null` means none, so the engine gets no row; `undefined`
 * means Core has not answered, and the engine's row follows its command.
 */
export function engineProviderRows(
	providers: Parameters<typeof agentModelProviders>[0],
	engine: string | null,
	vendorProvider?: string | null
): AccountRow[] {
	const rows: AccountRow[] = agentModelProviders(providers).map((provider) => ({
		key: accountKey.provider(provider.id),
		title: provider.label,
	}));
	const engineProvider = agentEngineModelProvider(engine);
	if (
		!engineProvider ||
		(vendorProvider !== undefined && vendorProvider !== engineProvider.id)
	) {
		return rows;
	}
	const key = accountKey.provider(engineProvider.id);
	const existing = rows.find((row) => row.key === key);
	if (existing) {
		existing.detail = `Also covers ${engineProvider.label}`;
		return rows;
	}
	return [{ key, title: engineProvider.label }, ...rows];
}
