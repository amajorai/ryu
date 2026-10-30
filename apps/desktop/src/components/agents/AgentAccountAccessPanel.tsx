import { AgentAccountAccessView } from "@ryu/blocks/desktop/agent-account-access.tsx";
import {
	appUsesSavedKeys,
	sourceReferencesSavedKey,
} from "@ryuhq/core-client/agent-account-access";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import {
	type AccountRow,
	accountKey,
	composioStatusLabel,
	engineProviderRows,
	savedKeyRows,
	startAccountLimit,
	toggleAccountKey,
} from "@/src/components/agents/AgentAccountAccessPanel-account-keys.ts";
import { OwnConnectedApps } from "@/src/components/agents/AgentAccountAccessPanel-own-connected-apps.tsx";
import { fetchVaultAgentAccounts } from "@/src/components/agents/AgentAccountAccessPanel-vault-accounts.ts";
import {
	modeHasOwnAccounts,
	modeUsesYourAccounts,
} from "@/src/components/agents/AgentIdentityModePicker.tsx";
import {
	NO_SANDBOX_NOTE,
	showsNoSandboxNote,
} from "@/src/components/agents/AgentLaunchWarning.tsx";
import { savedModeHasOwnApps } from "@/src/components/agents/agent-account-keys.ts";
import { engineRefusedWhenLimited } from "@/src/components/agents/agent-provider-access.ts";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgentLaunchCheck } from "@/src/hooks/useAgentLaunchCheck.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import {
	useAgentComposioConnections,
	useComposioConnections,
	useComposioStatus,
} from "@/src/hooks/useComposioCatalog.ts";
import { useIdentities } from "@/src/hooks/useIdentities.ts";
import { mcpServersQuery } from "@/src/hooks/useMcpCatalog.ts";
import type { AgentIdentityMode } from "@/src/lib/api/agents.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { fetchGatewayConfig } from "@/src/lib/api/gateway.ts";
import { fetchMcpOAuth } from "@/src/lib/api/mcp-oauth.ts";
import { fetchPiConfig } from "@/src/lib/api/pi-config.ts";

export {
	type AccountRow,
	accountKey,
	engineProviderRows,
	savedKeyRows,
	startAccountLimit,
	toggleAccountKey,
} from "@/src/components/agents/AgentAccountAccessPanel-account-keys.ts";
export { connectedAppsErrorMessage } from "@/src/components/agents/AgentAccountAccessPanel-own-connected-apps.tsx";
export {
	fetchVaultAgentAccounts,
	type VaultAgentAccount,
} from "@/src/components/agents/AgentAccountAccessPanel-vault-accounts.ts";
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
