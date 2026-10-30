// apps/desktop/src/components/store/AgentsCatalogSection.tsx
//
// The Agents section in the Store. Browses Core's agent catalog
// (`GET /api/agents/catalog`): every built-in agent (the flagship "Ryu" Pi+Gateway
// plus the full ACP registry (Claude Agent, Codex, Cursor, Devin, …) loaded
// from the official CDN. It drives the install/uninstall lifecycle that adds or removes an agent
// from the installed set surfaced in the chat picker.
//
// Uses the shared Store master-detail layout (left list, right preview) like
// Plugins, Models, MCP, and Skills — but the list itself is a wall of employee
// badges (`AgentBadgeCard`), not the one-line `StoreCatalogCard` row every other
// tab renders. An agent is the one catalog entry the app already has a physical
// card for, and it is the same card its profile page shows. Two per-entry
// signals are surfaced as badges:
//   - `added`    → the agent is installed (in the picker). Drives the button mode.
//   - `detected` → the agent's CLI binary is on PATH (null when not detectable),
//     a hint that the agent is ready to run locally without a separate install.
// Recommended agents (the flagship) sort first and carry a "Recommended" badge.
// The flagship `ryu` is locked: it is always installed and cannot be removed.
//
// Below the runtimes sits the Agent Templates shelf (`CommunityAgents.tsx`):
// customized definitions other users published, browsed from the control plane
// rather than Core. They are a different species — a configuration someone
// wrote, not a vendor program —
// so they never mix into the runtime groups, and installing one goes through
// Core's published-agent install (which strips the privilege-bearing bindings and
// reports them back) rather than the runtime installer used above.
//
// The list is GROUPED (Workflows/Engines shape): Installed → On this machine →
// Popular → More agents → Needs manual install. The groups are a presentation of
// the flags above, never a filter — every catalog row lands in exactly one group,
// so nothing can silently disappear from the tab. Precedence is top-down, which
// is what keeps them mutually exclusive (an installed agent that is also detected
// shows once, under Installed). Searching flattens back to a single grid, the
// same way the Tools library behaves.

import { useLiteralMessages } from "@ryu/i18n/react";
import StoreCatalogLayout from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import { useInstalledOnly } from "@ryu/marketplace/catalog/installed-filter";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useMemo, useState } from "react";
import { useMarketplacePurchase } from "@/src/components/marketplace/useMarketplacePurchase.ts";
import {
	AgentMysteryBox,
	AgentsOverflowMenu,
} from "@/src/components/store/AgentMysteryBox.tsx";
import {
	CommunityAgentDetail,
	CommunityAgentsShelf,
} from "@/src/components/store/CommunityAgents.tsx";
import { useDebouncedValue } from "@/src/hooks/use-debounced-value.ts";
import { useAgentsCatalog } from "@/src/hooks/useAgentsCatalog.ts";
import { useCommunityAgents } from "@/src/hooks/useCommunityAgents.ts";
import { usePluginSettingsOpener } from "@/src/hooks/usePluginSettingsOpener.ts";
import type { MysteryAgent } from "@/src/lib/agent-mystery-box.ts";
import type { PublishedAgentInstallResult } from "@/src/lib/api/agents.ts";
import { ApiError } from "@/src/lib/api/client.ts";
import type { MarketplaceCard } from "@/src/lib/api/marketplace.ts";
import { AgentDetailPanel } from "./agents/AgentDetailPanel.tsx";
import {
	AgentList,
	SEARCH_DEBOUNCE_MS,
	sortAgents,
} from "./agents/agent-list.tsx";

export default function AgentsCatalogSection({
	initialQuery = "",
	initialSelectedId,
	onOpenAgentAccountAccess,
}: {
	initialQuery?: string;
	/** Open this item's preview on arrival — the id of a card clicked on the
	 *  Store's Home shelves. */
	initialSelectedId?: string;
	/** Open an installed Agent Template's editor at Account access. Hosts
	 *  without tabs omit it and the detail shows no link. */
	onOpenAgentAccountAccess?: (agent: { id: string; name: string }) => void;
} = {}) {
	const tl = useLiteralMessages();
	const [query, setQuery] = useState(initialQuery);
	const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
	// Seeded, not synced: this catalog is fetched whole and filtered client-side,
	// so a Home shelf card's id resolves on the first render and needs no effect.
	const [selectedId, setSelectedId] = useState<string | null>(
		initialSelectedId ?? null
	);
	// A few catalog rows are ALSO installed plugins that declare settings; the
	// resolver returns null for the rest, so the row simply has no Settings entry.
	const settingsOpener = usePluginSettingsOpener();
	const { agents, loading, error, install, uninstall, pendingId, reload } =
		useAgentsCatalog();
	const [errorId, setErrorId] = useState<string | null>(null);

	// ── Agent Templates (published definitions, control plane) ────────────────
	// A second, independent catalog: it has its own loading/error state and its own
	// selection, because a marketplace outage must not touch the runtime list above.
	const community = useCommunityAgents();
	const { buy, buying } = useMarketplacePurchase();
	const [selectedCommunity, setSelectedCommunity] =
		useState<MarketplaceCard | null>(null);
	// What Core stripped, per listing installed in this session. Keyed by listing
	// id (not a single slot) so switching between two installed agents shows each
	// one's own disclosure rather than the last install's.
	const [installedRequires, setInstalledRequires] = useState<
		Record<string, PublishedAgentInstallResult>
	>({});

	const sorted = useMemo(() => sortAgents(agents), [agents]);
	const [mysteryOpen, setMysteryOpen] = useState(false);

	// The Store shell's "installed only" switch (the retired "Added" tab,
	// inverted). This catalog is fetched whole and filtered here, so it applies to
	// the rendered list — `added` is the runtime list's word for installed.
	const installedOnly = useInstalledOnly();

	const filtered = useMemo(() => {
		const q = debouncedQuery.trim().toLowerCase();
		const base = installedOnly ? sorted.filter((entry) => entry.added) : sorted;
		if (!q) {
			return base;
		}
		return base.filter(
			(entry) =>
				entry.name.toLowerCase().includes(q) ||
				(entry.description?.toLowerCase().includes(q) ?? false)
		);
	}, [sorted, debouncedQuery, installedOnly]);

	const filteredCommunity = useMemo(() => {
		// A published community definition has no installed state on the card, so
		// "installed only" hides the whole shelf rather than showing rows it cannot
		// answer for.
		if (installedOnly) {
			return [];
		}
		const q = debouncedQuery.trim().toLowerCase();
		if (!q) {
			return community.agents;
		}
		return community.agents.filter(
			(card) =>
				card.name.toLowerCase().includes(q) ||
				(card.description?.toLowerCase().includes(q) ?? false) ||
				(card.author?.toLowerCase().includes(q) ?? false)
		);
	}, [community.agents, debouncedQuery, installedOnly]);

	const selectedEntry = useMemo(
		() => filtered.find((entry) => entry.id === selectedId) ?? null,
		[filtered, selectedId]
	);

	const run = async (
		id: string,
		action: () => Promise<void>,
		failureTitle: string
	) => {
		setErrorId(null);
		try {
			await action();
		} catch (cause) {
			setErrorId(id);
			toast.error(failureTitle, {
				description:
					cause instanceof ApiError && cause.serverMessage
						? cause.serverMessage
						: cause instanceof Error
							? cause.message
							: String(cause),
			});
		}
	};

	// Install a published definition. On success the listing is SELECTED even when
	// the install came from a card, because the disclosure of what Core stripped is
	// the part the user still has to act on — a toast alone would drop it.
	const installCommunity = async (card: MarketplaceCard) => {
		try {
			const result = await community.install(card.id);
			setInstalledRequires((prev) => ({ ...prev, [card.id]: result }));
			setSelectedId(null);
			setSelectedCommunity(card);
			toast.success(
				tl("{name} is now one of your agents", { name: result.agent.name }),
				{
					description:
						"Open it to grant anything it asked for — nothing was enabled for you.",
				}
			);
		} catch (e) {
			toast.error("Couldn't install this agent", {
				description: e instanceof Error ? e.message : String(e),
			});
		}
	};

	// The Mystery Box reports failures itself, so these reject instead of toasting.
	const addTemplateFromBox = async (card: MarketplaceCard) => {
		const result = await community.install(card.id);
		setInstalledRequires((prev) => ({ ...prev, [card.id]: result }));
		toast.success(
			tl("{name} is now one of your agents", { name: result.agent.name }),
			{
				description:
					"Open its details to grant anything it asked for, and to choose which of your accounts it may use under Account access — nothing was enabled for you.",
			}
		);
	};

	const viewFromBox = (agent: MysteryAgent) => {
		setMysteryOpen(false);
		if (agent.kind === "runtime") {
			setSelectedCommunity(null);
			setSelectedId(agent.entry.id);
		} else {
			setSelectedId(null);
			setSelectedCommunity(agent.card);
		}
	};

	const showMysteryBox =
		debouncedQuery.trim().length === 0 &&
		!installedOnly &&
		(agents.length > 0 || community.agents.length > 0);

	const communityInstall = selectedCommunity
		? (installedRequires[selectedCommunity.id] ?? null)
		: null;

	return (
		<StoreCatalogLayout
			actions={
				showMysteryBox ? (
					<AgentsOverflowMenu onOpenMysteryBox={() => setMysteryOpen(true)} />
				) : null
			}
			detail={
				selectedCommunity ? (
					<CommunityAgentDetail
						busy={
							community.pendingId === selectedCommunity.id ||
							buying === selectedCommunity.id
						}
						card={selectedCommunity}
						installedIdentityMode={communityInstall?.agent.identityMode ?? null}
						onBuy={() => buy({ id: selectedCommunity.id, kind: "agent" })}
						onInstall={() => installCommunity(selectedCommunity)}
						onOpenAccountAccess={
							communityInstall && onOpenAgentAccountAccess
								? () => onOpenAgentAccountAccess(communityInstall.agent)
								: undefined
						}
						requestedSpaceCount={communityInstall?.requestedSpaceCount ?? 0}
						requires={communityInstall?.requires ?? null}
					/>
				) : (
					<AgentDetailPanel
						busy={pendingId === selectedId}
						entry={selectedEntry}
						error={errorId === selectedId ? error : null}
						onInstall={() => {
							if (selectedId) {
								run(
									selectedId,
									() => install(selectedId),
									"Couldn't add agent"
								);
							}
						}}
						onUninstall={() => {
							if (selectedId) {
								run(
									selectedId,
									() => uninstall(selectedId),
									"Couldn't remove agent"
								);
							}
						}}
					/>
				)
			}
			detailTitle={selectedCommunity?.name ?? selectedEntry?.name ?? "Agent"}
			hasSelection={selectedCommunity != null || selectedEntry != null}
			list={
				<>
					<AgentMysteryBox
						onAddRuntime={install}
						onAddTemplate={addTemplateFromBox}
						onBuyTemplate={(card) => buy({ id: card.id, kind: "agent" })}
						onOpenChange={setMysteryOpen}
						onViewDetails={viewFromBox}
						open={mysteryOpen}
						runtimes={agents}
						templates={community.agents}
					/>
					<AgentList
						agents={filtered}
						error={error}
						grouped={debouncedQuery.trim().length === 0}
						loading={loading}
						onClearSearch={() => setQuery("")}
						onInstall={(id) => run(id, () => install(id), "Couldn't add agent")}
						onRetry={() => {
							void reload();
						}}
						onSelect={(id) => {
							setSelectedCommunity(null);
							setSelectedId(id);
						}}
						onUninstall={(id) =>
							run(id, () => uninstall(id), "Couldn't remove agent")
						}
						pendingId={pendingId}
						selectedId={selectedId}
						settingsOpener={settingsOpener}
					/>
					<CommunityAgentsShelf
						agents={filteredCommunity}
						busyId={community.pendingId ?? buying}
						error={community.error}
						loading={community.loading}
						onBuy={(card) => buy({ id: card.id, kind: "agent" })}
						onInstall={(card) => installCommunity(card)}
						onSelect={(card) => {
							setSelectedId(null);
							setSelectedCommunity(card);
						}}
						selectedId={selectedCommunity?.id ?? null}
					/>
				</>
			}
			onCloseDetail={() => {
				setSelectedId(null);
				setSelectedCommunity(null);
			}}
			search={{
				value: query,
				onChange: setQuery,
				placeholder: "Search agents…",
			}}
		/>
	);
}
