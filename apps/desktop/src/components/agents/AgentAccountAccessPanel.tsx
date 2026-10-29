import { Link01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	type AccountAccessRow,
	AccountAccessRows,
	AgentAccountAccessView,
	AgentOwnConnectedAppsCard,
	DESKTOP_ACCOUNT_KEY,
	TREG_ACCOUNT_KEY,
} from "@ryu/blocks/desktop/agent-account-access.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
	appUsesSavedKeys,
	sourceReferencesSavedKey,
} from "@ryuhq/core-client/agent-account-access";
import { useQueries, useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { sileo } from "sileo";
import { z } from "zod";
import { openExternal } from "@/lib/tauri-bridge.ts";
import {
	modeHasOwnAccounts,
	modeUsesYourAccounts,
} from "@/src/components/agents/AgentIdentityModePicker.tsx";
import {
	NO_SANDBOX_NOTE,
	showsNoSandboxNote,
} from "@/src/components/agents/AgentLaunchWarning.tsx";
import { savedModeHasOwnApps } from "@/src/components/agents/agent-account-keys.ts";
import {
	agentEngineModelProvider,
	agentModelProviders,
	engineRefusedWhenLimited,
} from "@/src/components/agents/agent-provider-access.ts";
import { ConnectionPermissionDialog } from "@/src/components/marketplace/ConnectionPermissionDialog.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgentLaunchCheck } from "@/src/hooks/useAgentLaunchCheck.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import {
	useAgentComposioConnections,
	useComposioConnections,
	useComposioStatus,
	useComposioToolkits,
	useDisconnectAgentComposioConnection,
	useInitiateAgentComposioConnection,
} from "@/src/hooks/useComposioCatalog.ts";
import { useIdentities } from "@/src/hooks/useIdentities.ts";
import { mcpServersQuery } from "@/src/hooks/useMcpCatalog.ts";
import type { AgentIdentityMode } from "@/src/lib/api/agents.ts";
import {
	ApiError,
	type ApiTarget,
	request,
	toTarget,
} from "@/src/lib/api/client.ts";
import { isAgentComposioUnsupported } from "@/src/lib/api/composio.ts";
import { fetchGatewayConfig } from "@/src/lib/api/gateway.ts";
import type { McpServer } from "@/src/lib/api/mcp.ts";
import { fetchMcpOAuth } from "@/src/lib/api/mcp-oauth.ts";
import { fetchPiConfig } from "@/src/lib/api/pi-config.ts";
import type { AppInfo } from "@/src/lib/api/plugins.ts";
import type { ConnectionAccessLevel } from "@/src/lib/connection-permissions.ts";

export { appUsesSavedKeys, sourceReferencesSavedKey };

// Account access: which accounts one agent may use.
//
// This component loads the accounts and builds their rows; the layout is the
// data-free `AgentAccountAccessView` in `@ryu/blocks/desktop/agent-account-access.tsx`,
// which the storyboard renders from fixtures.
//
// The list is Core's `account_access` allowlist (see `apps/core/src/agent_access.rs`
// for the key grammar). `null` means unrestricted — every account the agent's
// identity mode permits, which is how every agent worked before this setting
// existed — and the "Limit to selected accounts" switch is the only way to turn
// it into an explicit list. An explicit list only ever narrows: keys this panel
// cannot see right now (an account disconnected since, a key a newer node wrote)
// are carried through untouched instead of being dropped on save.
//
// The Treg switch is a platform route, not one of the user's accounts, so it is
// shown in every mode. Core enforces it on the Treg calls an app makes for the
// agent, including work the app runs later (a scheduled post).
//
// Groups follow the identity mode: "Your accounts" for Acts as you and Both,
// "Agent's own accounts" for Its own identity and Both. A hidden group gets one
// line saying why, so the selection does not look lost. Identity Vault profiles
// keep their own allowlist (`identity_profile_ids`, empty = none) and are only
// moved here, not merged into `account_access`.
//
// "Agent's own accounts" also lists the apps connected to the agent's own
// Composio identity (`agent-composio:<id>`). Connect app starts one for the
// saved agent; Core adds it to a limited agent's allowlist, and this panel adds
// it to the unsaved list too so saving the editor keeps it.
//
// Model providers (`provider:<id>`) are your accounts too: Gateway skips any
// provider a limited agent was not given. Ryu credits and local models are not
// your accounts, so they stay available and have no row. An engine that calls
// its vendor itself (Claude Code, Codex on ChatGPT, Gemini CLI, Kiro) gets that
// vendor's row even without a Gateway key, because Core starts it for a limited
// agent only when the vendor is allowed.
//
// Services using your saved keys (`mcp-secret:<id>`) are MCP servers and app
// tools that call out with a key you saved (a `secret:`, `vault:` or `env:`
// reference, or a key typed into a server you added). One row per app, or per
// server you added. Control of your desktop (`platform:desktop`) covers Ghost
// and what Shadow captured. Both are yours, so an agent with only its own
// identity never gets them.

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

/** One of the agent's own website logins (PR #749 vault agent accounts). */
export interface VaultAgentAccount {
	email: string | null;
	hasTotp: boolean;
	host: string;
	id: string;
	label: string | null;
	site: string;
	username: string | null;
}

const vaultAgentAccountsResponseCodec = z
	.object({
		accounts: z
			.array(
				z
					.object({
						email: z.string().nullish(),
						has_totp: z.boolean().optional(),
						host: z.string(),
						id: z.string(),
						label: z.string().nullish(),
						site: z.string(),
						username: z.string().nullish(),
					})
					.passthrough()
			)
			.optional(),
	})
	.passthrough();

/** GET /api/vault/agent-accounts?agent_id= — metadata only, never a secret. */
export async function fetchVaultAgentAccounts(
	target: ApiTarget,
	agentId: string
): Promise<VaultAgentAccount[]> {
	const json = await request(
		target,
		`/api/vault/agent-accounts?agent_id=${encodeURIComponent(agentId)}`,
		undefined,
		vaultAgentAccountsResponseCodec
	);
	return (json.accounts ?? []).map((account) => ({
		email: account.email ?? null,
		hasTotp: account.has_totp ?? false,
		host: account.host,
		id: account.id,
		label: account.label ?? null,
		site: account.site,
		username: account.username ?? null,
	}));
}

export type AccountRow = AccountAccessRow;

function composioStatusLabel(status: string, active: boolean) {
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

/** A message for a failed request, preferring Core's own words. */
function errorMessage(cause: unknown, fallback: string): string {
	if (cause instanceof ApiError) {
		return cause.serverMessage ?? cause.message;
	}
	return cause instanceof Error ? cause.message : fallback;
}

/**
 * Why the agent's connected apps did not load. A 409 is Core saying the saved
 * agent may not hold apps of its own, so its words are shown; anything else
 * gets the generic line.
 */
export function connectedAppsErrorMessage(cause: unknown): string {
	if (
		cause instanceof ApiError &&
		cause.status === 409 &&
		cause.serverMessage
	) {
		return cause.serverMessage;
	}
	return "Couldn't load this agent's connected apps.";
}

/**
 * Apps connected to the agent's own Composio identity, with Connect app and a
 * Disconnect action per app. Only for a saved agent with its own identity.
 */
function OwnConnectedApps({
	accountAccess,
	agentId,
	composioConfigured,
	disabled,
	error,
	loading,
	needsSave,
	onAccountAccessChange,
	onToggle,
	rows,
}: {
	accountAccess: string[] | null;
	agentId: string | null;
	composioConfigured: boolean;
	disabled: boolean;
	error: unknown;
	loading: boolean;
	/** The agent is saved as Acts as you, so Core holds no apps for it yet. */
	needsSave: boolean;
	onAccountAccessChange: (next: string[] | null) => void;
	onToggle: (key: string, allowed: boolean) => void;
	rows: AccountRow[];
}) {
	const [picking, setPicking] = useState(false);
	const [toolkit, setToolkit] = useState("");
	const [permissionOpen, setPermissionOpen] = useState(false);
	const toolkits = useComposioToolkits(picking && composioConfigured);
	const initiate = useInitiateAgentComposioConnection(agentId);
	const disconnect = useDisconnectAgentComposioConnection(agentId);
	const unsupported = isAgentComposioUnsupported(error);
	const canConnect =
		agentId !== null &&
		composioConfigured &&
		!needsSave &&
		!unsupported &&
		!disabled;
	const toolkitName =
		toolkits.data?.find((candidate) => candidate.slug === toolkit)?.name ??
		toolkit;

	const handleConnect = async (accessLevel: ConnectionAccessLevel) => {
		const started = await initiate.mutateAsync({ accessLevel, toolkit });
		// Core adds the account to a limited agent's saved list; add it to the
		// list being edited too, so saving the editor keeps it.
		if (accountAccess !== null && started.connectionId) {
			onAccountAccessChange(
				toggleAccountKey(
					accountAccess,
					accountKey.agentComposio(started.connectionId),
					true
				)
			);
		}
		if (!started.redirectUrl) {
			throw new Error("Composio did not return a connect link.");
		}
		await openExternal(started.redirectUrl);
		setPicking(false);
		setToolkit("");
		sileo.success({
			title: `Connecting ${toolkitName} for this agent…`,
			description:
				"Authorize in your browser with the account the agent should use. It turns active here when you return.",
		});
	};

	const handleDisconnect = async (row: AccountRow) => {
		if (!row.id) {
			return;
		}
		try {
			await disconnect.mutateAsync(row.id);
		} catch (cause) {
			sileo.error({
				title: "Couldn't disconnect the app",
				description: errorMessage(cause, "Try again."),
			});
			return;
		}
		if (accountAccess !== null) {
			onAccountAccessChange(toggleAccountKey(accountAccess, row.key, false));
		}
	};

	let body: ReactNode;
	if (agentId === null) {
		body = (
			<p className="text-muted-foreground text-sm">
				Save the agent first. You can then connect apps to its own identity.
			</p>
		);
	} else if (!composioConfigured) {
		body = (
			<p className="text-muted-foreground text-sm">
				Composio isn't set up on this node.
			</p>
		);
	} else if (needsSave) {
		body = (
			<p className="text-muted-foreground text-sm">
				Save to connect apps for this agent.
			</p>
		);
	} else if (unsupported) {
		body = (
			<p className="text-muted-foreground text-sm">
				The Connect service on this node doesn't allow apps for agents.
			</p>
		);
	} else if (error) {
		body = (
			<p className="text-muted-foreground text-sm">
				{connectedAppsErrorMessage(error)}
			</p>
		);
	} else {
		body = (
			<AccountAccessRows
				accountAccess={accountAccess}
				disabled={disabled}
				empty="No apps connected to this agent yet."
				loading={loading}
				onToggle={onToggle}
				rows={rows}
				trailing={(row) => (
					<Button
						aria-label={`Disconnect ${row.title}`}
						disabled={disabled || disconnect.isPending}
						onClick={() => handleDisconnect(row)}
						size="sm"
						variant="ghost"
					>
						Disconnect
					</Button>
				)}
			/>
		);
	}

	return (
		<AgentOwnConnectedAppsCard
			connectAction={
				canConnect && !picking ? (
					<Button onClick={() => setPicking(true)} size="sm" variant="ghost">
						<HugeiconsIcon className="size-4" icon={Link01Icon} />
						Connect app
					</Button>
				) : null
			}
			picker={
				canConnect && picking ? (
					<div className="flex flex-wrap items-center gap-2">
						<NativeSelect
							aria-label="App to connect"
							disabled={toolkits.isLoading}
							onChange={(event) => setToolkit(event.target.value)}
							size="sm"
							value={toolkit}
						>
							<NativeSelectOption value="">
								{toolkits.isLoading ? "Loading apps…" : "Choose an app"}
							</NativeSelectOption>
							{(toolkits.data ?? []).map((candidate) => (
								<NativeSelectOption key={candidate.slug} value={candidate.slug}>
									{candidate.name}
								</NativeSelectOption>
							))}
						</NativeSelect>
						<Button
							disabled={!toolkit || initiate.isPending}
							loading={initiate.isPending}
							onClick={() => setPermissionOpen(true)}
							size="sm"
						>
							Continue
						</Button>
						<Button
							onClick={() => {
								setPicking(false);
								setToolkit("");
							}}
							size="sm"
							variant="ghost"
						>
							Cancel
						</Button>
					</div>
				) : null
			}
		>
			{body}
			<ConnectionPermissionDialog
				connectionName={toolkitName}
				connectionType="Composio"
				onConfirm={handleConnect}
				onOpenChange={setPermissionOpen}
				open={permissionOpen}
			/>
		</AgentOwnConnectedAppsCard>
	);
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

export function AgentAccountAccessPanel({
	accountAccess,
	agentId,
	disabled,
	engine = null,
	identityMode,
	launchNoticesShownElsewhere = false,
	onAccountAccessChange,
	onToggleIdentity,
	savedIdentityMode,
	selectedIdentities,
}: {
	accountAccess: string[] | null;
	/** The saved agent; `null` for a brand-new agent with no record yet. */
	agentId: string | null;
	disabled: boolean;
	/** The agent's engine (`acp:claude`, `acp-exec:<command>`, …), if chosen. */
	engine?: string | null;
	identityMode: AgentIdentityMode;
	/**
	 * The page already shows Core's launch check beside this panel (the simple
	 * editor puts it in the same Identity section, in `AgentLaunchWarning`), so
	 * the panel leaves out Core's refusal and the no-sandbox note.
	 */
	launchNoticesShownElsewhere?: boolean;
	onAccountAccessChange: (next: string[] | null) => void;
	onToggleIdentity: (profileId: string) => void;
	/**
	 * The identity mode Core holds for the saved agent. Apps on the agent's own
	 * identity need it saved as Its own identity or Both, so an unsaved switch
	 * from Acts as you asks for a save first. Omitted, `identityMode` is
	 * taken as saved.
	 */
	savedIdentityMode?: AgentIdentityMode | null;
	selectedIdentities: ReadonlySet<string>;
}) {
	const activeNode = useActiveNode();
	const target = useMemo(() => toTarget(activeNode), [activeNode]);
	const openTab = useTabSelector((state) => state.openTab);
	const showYours = modeUsesYourAccounts(identityMode);
	const showOwn = modeHasOwnAccounts(identityMode);

	const composioStatus = useComposioStatus();
	const composioConfigured = composioStatus.data?.configured ?? false;
	const composioConnections = useComposioConnections(
		"",
		composioConfigured && showYours
	);

	const { apps } = useApps();
	const mcpApps = useMemo(
		() =>
			showYours
				? apps.filter((app) => app.enabled && app.mcpOAuthServers.length > 0)
				: [],
		[apps, showYours]
	);
	// Same query key as `useMcpOAuthConnections`, so the Connections tab and
	// this panel share one cache entry per app.
	const mcpServers = useQuery({
		...mcpServersQuery(target),
		enabled: showYours,
		staleTime: 10_000,
	});
	const mcpQueries = useQueries({
		queries: mcpApps.map((app) => ({
			queryFn: () => fetchMcpOAuth(target, app.id),
			queryKey: ["mcp-oauth", target.url, app.id],
			staleTime: 10_000,
		})),
	});

	const { profileIds, loading: identitiesLoading } = useIdentities();

	const gatewayConfig = useQuery({
		enabled: showYours,
		queryFn: () => fetchGatewayConfig(target),
		queryKey: ["gateway-config", target.url, "agent-model-providers"],
		staleTime: 30_000,
	});

	const ownAccounts = useQuery({
		enabled: showOwn && agentId !== null,
		queryFn: () => fetchVaultAgentAccounts(target, agentId ?? ""),
		queryKey: ["vault-agent-accounts", target.url, agentId],
		staleTime: 15_000,
	});

	// Core answers 409 for the apps of an agent saved as Acts as you, so they
	// are not fetched until the switch to its own identity is saved.
	const ownAppsNeedSave =
		agentId !== null &&
		!savedModeHasOwnApps(
			savedIdentityMode === undefined ? identityMode : savedIdentityMode
		);
	const ownComposio = useAgentComposioConnections(
		agentId,
		showOwn && composioConfigured && !ownAppsNeedSave
	);

	const composioRows = useMemo<AccountRow[]>(
		() =>
			(composioConnections.data ?? []).map((connection) => ({
				detail: connection.id,
				key: accountKey.composio(connection.id),
				status: composioStatusLabel(connection.status, connection.active),
				title: connection.toolkit || "Connected app",
			})),
		[composioConnections.data]
	);
	const mcpRows = useMemo<AccountRow[]>(() => {
		const rows: AccountRow[] = [];
		for (const [index, app] of mcpApps.entries()) {
			for (const server of mcpQueries[index]?.data ?? []) {
				for (const connection of server.connections) {
					rows.push({
						detail: [connection.accountLabel, `profile ${connection.profileId}`]
							.filter(Boolean)
							.join(" · "),
						key: accountKey.mcp(
							connection.profileId,
							app.id,
							server.serverName
						),
						status:
							connection.status === "connected"
								? { label: "Connected", muted: false }
								: { label: "Sign in again", muted: true },
						title: `${app.name} · ${server.serverName}`,
					});
				}
			}
		}
		return rows;
	}, [mcpApps, mcpQueries]);
	const savedKeyAccountRows = useMemo<AccountRow[]>(
		() => (showYours ? savedKeyRows(mcpServers.data ?? [], apps) : []),
		[showYours, mcpServers.data, apps]
	);
	const launch = useAgentLaunchCheck({
		accountAccess,
		agentId,
		engine,
		identityMode,
	});
	const vendorProvider = launch.check ? launch.check.vendorProvider : undefined;
	const providerRows = useMemo<AccountRow[]>(
		() =>
			engineProviderRows(
				gatewayConfig.data?.providers ?? null,
				engine,
				vendorProvider
			),
		[gatewayConfig.data, engine, vendorProvider]
	);
	const ownRows = useMemo<AccountRow[]>(
		() =>
			(ownAccounts.data ?? []).map((account) => ({
				detail:
					[account.username ?? account.email, account.label]
						.filter(Boolean)
						.join(" · ") || undefined,
				key: accountKey.agent(account.id),
				status: account.hasTotp ? { label: "2FA", muted: false } : undefined,
				title: account.host || account.site,
			})),
		[ownAccounts.data]
	);
	const ownComposioRows = useMemo<AccountRow[]>(
		() =>
			(ownComposio.data?.connections ?? []).map((connection) => ({
				detail: connection.id,
				id: connection.id,
				key: accountKey.agentComposio(connection.id),
				status: composioStatusLabel(connection.status, connection.active),
				title: connection.toolkit || "Connected app",
			})),
		[ownComposio.data]
	);

	const limited = accountAccess !== null;
	// Model providers are limited for a limited list, and always for an agent
	// with only its own identity (Core's `user_provider_access`).
	const modelsLimited = limited || !showYours;
	// Core's launch check says whether the engine starts under this access,
	// with the reason its first turn would fail with. Until it answers (or on
	// a Core without it), the local mirror covers Ryu's managed Pi.
	const piConfig = useQuery({
		enabled: launch.check === null && modelsLimited && engine === "acp:pi",
		queryFn: () => fetchPiConfig(target),
		queryKey: ["pi-config", target.url, "agent-account-access"],
		staleTime: 30_000,
	});
	let engineRefusal: string | null = null;
	if (launch.check) {
		engineRefusal = launchNoticesShownElsewhere ? null : launch.check.reason;
	} else if (modelsLimited) {
		engineRefusal = engineRefusedWhenLimited(
			engine,
			piConfig.data?.routing ?? null
		);
	}
	const noSandbox =
		!launchNoticesShownElsewhere &&
		showsNoSandboxNote(launch.check, modelsLimited);
	const visibleKeys = [
		...(showYours
			? [
					...composioRows.map((row) => row.key),
					...mcpRows.map((row) => row.key),
					...providerRows.map((row) => row.key),
					...savedKeyAccountRows.map((row) => row.key),
					accountKey.desktop,
				]
			: []),
		accountKey.treg,
		...(showOwn
			? [
					...ownRows.map((row) => row.key),
					...(ownAppsNeedSave ? [] : ownComposioRows).map((row) => row.key),
				]
			: []),
	];
	// Turning the limit off and on again restores the last explicit list,
	// including the keys this panel cannot show, instead of rebuilding it.
	const lastLimitRef = useRef<string[] | null>(null);
	// A fresh limit starts from every visible account, so wait until they have
	// all loaded; otherwise accounts still loading would be left out.
	const accountsLoading =
		(showYours &&
			((composioConfigured && composioConnections.isLoading) ||
				mcpQueries.some((query) => query.isLoading) ||
				mcpServers.isLoading ||
				gatewayConfig.isLoading)) ||
		(showOwn &&
			agentId !== null &&
			(ownAccounts.isLoading ||
				(composioConfigured && !ownAppsNeedSave && ownComposio.isLoading)));

	const toggle = (key: string, allowed: boolean) => {
		if (accountAccess === null) {
			return;
		}
		onAccountAccessChange(toggleAccountKey(accountAccess, key, allowed));
	};

	return (
		<AgentAccountAccessView
			accountAccess={accountAccess}
			accountsLoading={accountsLoading}
			connectedApps={{
				configured: composioConfigured,
				loading: composioConnections.isLoading,
				rows: composioRows,
			}}
			disabled={disabled}
			engineRefusal={engineRefusal}
			identities={{
				loading: identitiesLoading,
				onToggle: onToggleIdentity,
				profileIds,
				selected: selectedIdentities,
			}}
			identityMode={identityMode}
			mcpSignIns={
				mcpApps.length > 0
					? {
							loading: mcpQueries.some((query) => query.isLoading),
							rows: mcpRows,
						}
					: null
			}
			modelProviders={{
				error: gatewayConfig.isError,
				loading: gatewayConfig.isLoading,
				rows: providerRows,
			}}
			noSandboxNote={noSandbox ? NO_SANDBOX_NOTE : null}
			onConnectApp={() => openTab("/store/connections")}
			onLimitChange={(on) => {
				if (on) {
					onAccountAccessChange(
						lastLimitRef.current ?? startAccountLimit(visibleKeys)
					);
					return;
				}
				lastLimitRef.current = accountAccess;
				onAccountAccessChange(null);
			}}
			onOpenVault={() => openTab("/vault", { title: "Vault" })}
			onToggle={toggle}
			ownConnectedApps={
				<OwnConnectedApps
					accountAccess={accountAccess}
					agentId={agentId}
					composioConfigured={composioConfigured}
					disabled={disabled}
					error={ownComposio.error}
					loading={ownComposio.isLoading}
					needsSave={ownAppsNeedSave}
					onAccountAccessChange={onAccountAccessChange}
					onToggle={toggle}
					rows={ownAppsNeedSave ? [] : ownComposioRows}
				/>
			}
			ownLogins={{
				error: ownAccounts.isError,
				loading: ownAccounts.isLoading,
				rows: ownRows,
				unsaved: agentId === null,
			}}
			savedKeys={{
				error: mcpServers.isError,
				loading: mcpServers.isLoading,
				rows: savedKeyAccountRows,
			}}
		/>
	);
}
