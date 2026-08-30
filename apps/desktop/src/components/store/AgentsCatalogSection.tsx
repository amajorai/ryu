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
// Below the runtimes sits the COMMUNITY shelf (`CommunityAgents.tsx`): agents
// other users published, browsed from the control plane rather than Core. They
// are a different species — a configuration someone wrote, not a vendor program —
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

import {
	Alert01Icon,
	Delete01Icon,
	Download01Icon,
	Target01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { InstallProgressButton } from "@ryu/blocks/desktop/install-button.tsx";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import StoreCatalogLayout, {
	StoreCardGrid,
	useStoreViewMode,
} from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import StoreItemAction, {
	storeItemContextMenu,
} from "@ryu/marketplace/catalog/chrome/store-item-action";
import StoreShelfHeading from "@ryu/marketplace/catalog/chrome/store-shelf-heading";
import {
	ListingAsideCard,
	ListingDetailShell,
	ListingHero,
	ListingInfoGrid,
	ListingSection,
	ListingStatStrip,
} from "@ryu/marketplace/catalog/detail/listing-detail-shell";
import { useInstalledOnly } from "@ryu/marketplace/catalog/installed-filter";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import {
	StatusBadge,
	UNAVAILABLE_ROW_CLASS,
} from "@ryu/ui/components/status-badge.tsx";
import { useMemo, useState } from "react";
import { AgentBadgeCard } from "@/src/components/agents/AgentBadgeCard.tsx";
import { useMarketplacePurchase } from "@/src/components/marketplace/useMarketplacePurchase.ts";
import {
	CommunityAgentDetail,
	CommunityAgentsShelf,
} from "@/src/components/store/CommunityAgents.tsx";
import { useDebouncedValue } from "@/src/hooks/use-debounced-value.ts";
import { useAgentsCatalog } from "@/src/hooks/useAgentsCatalog.ts";
import { useCommunityAgents } from "@/src/hooks/useCommunityAgents.ts";
import {
	type PluginSettingsOpener,
	usePluginSettingsOpener,
} from "@/src/hooks/usePluginSettingsOpener.ts";
import { groupAgents } from "@/src/lib/agent-catalog-groups.ts";
import { AgentCatalogLogo } from "@/src/lib/agent-catalog-logo.tsx";
import type {
	AgentCatalogEntry,
	PublishedAgentInstallResult,
} from "@/src/lib/api/agents.ts";
import type { MarketplaceCard } from "@/src/lib/api/marketplace.ts";
import { useInstallProgress } from "@/src/store/useDownloadsStore.ts";

const SEARCH_DEBOUNCE_MS = 200;

/** The flagship agent: always installed, cannot be uninstalled. */
const FLAGSHIP_AGENT_ID = "ryu";

/** Why an agent row is dimmed and un-addable. One string, three surfaces (the
 *  card action, the detail header, the detail hero), so the card's tooltip and
 *  the hero's chip cannot drift into two different explanations. */
const UNAVAILABLE_AGENT_REASON = "Unavailable on this platform";

/** Sort recommended agents first, then by display name. */
function sortAgents(agents: AgentCatalogEntry[]): AgentCatalogEntry[] {
	return [...agents].sort((a, b) => {
		if (a.recommended !== b.recommended) {
			return a.recommended ? -1 : 1;
		}
		return a.name.localeCompare(b.name);
	});
}

function InstallButton({
	entry,
	busy,
	onInstall,
	onUninstall,
}: {
	entry: AgentCatalogEntry;
	busy: boolean;
	onInstall: () => void;
	onUninstall: () => void;
}) {
	const locked = entry.id === FLAGSHIP_AGENT_ID;
	const { percent } = useInstallProgress(["agent"], entry.name);
	if (entry.added) {
		// The flagship can never be removed, so it gets the shared status glyph
		// rather than a disabled Remove button — a disabled verb reads as "not
		// right now" when the answer is "not ever".
		if (locked) {
			return <StatusBadge kind="builtin" />;
		}
		return (
			<Button loading={busy} onClick={onUninstall} size="sm" variant="ghost">
				{!busy && <HugeiconsIcon className="size-4" icon={Delete01Icon} />}
				Remove
			</Button>
		);
	}
	if (!entry.available) {
		return <StatusBadge kind="unavailable" label={UNAVAILABLE_AGENT_REASON} />;
	}
	return (
		<InstallProgressButton
			idleVariant="ghost"
			installing={busy}
			onClick={onInstall}
			percent={percent}
		>
			<HugeiconsIcon className="size-4" icon={Download01Icon} />
			Add
		</InstallProgressButton>
	);
}

/** Card lifecycle control: locked flagship, unavailable, or install/uninstall. */
function AgentCardAction({
	entry,
	busy,
	onInstall,
	onUninstall,
	onOpenSettings,
}: {
	entry: AgentCatalogEntry;
	busy: boolean;
	onInstall: () => void;
	onUninstall: () => void;
	/** Set only for a listing that is ALSO an installed plugin with settings —
	 *  most agents are not, and then no Settings row renders. */
	onOpenSettings?: (() => void) | null;
}) {
	const { percent } = useInstallProgress(["agent"], entry.name);
	if (entry.id === FLAGSHIP_AGENT_ID) {
		return (
			<StoreItemAction
				installed
				locked
				lockedLabel="Built in"
				onOpenSettings={onOpenSettings ?? undefined}
			/>
		);
	}
	if (!(entry.available || entry.added)) {
		return <StatusBadge kind="unavailable" label={UNAVAILABLE_AGENT_REASON} />;
	}
	return (
		<StoreItemAction
			busy={busy}
			installed={entry.added}
			onInstall={onInstall}
			onOpenSettings={onOpenSettings ?? undefined}
			onUninstall={onUninstall}
			percent={percent}
		/>
	);
}

function AgentCards({
	agents,
	selectedId,
	pendingId,
	onSelect,
	onInstall,
	onUninstall,
	settingsOpener,
}: {
	agents: AgentCatalogEntry[];
	selectedId: string | null;
	pendingId: string | null;
	onSelect: (id: string) => void;
	onInstall: (id: string) => void;
	onUninstall: (id: string) => void;
	/** Resolves a row to its settings tab; null for anything that is not an
	 *  installed plugin, which is most agents. */
	settingsOpener: PluginSettingsOpener;
}) {
	const view = useStoreViewMode()?.mode ?? "showcase";
	return (
		<StoreCardGrid>
			{agents.map((entry) => {
				const action = (
					<AgentCardAction
						busy={pendingId === entry.id}
						entry={entry}
						onInstall={() => onInstall(entry.id)}
						onOpenSettings={settingsOpener(entry.id)}
						onUninstall={() => onUninstall(entry.id)}
					/>
				);
				// Mirrors `AgentCardAction` branch for branch, in its order. The
				// flagship is checked FIRST and pinned to installed+locked exactly as
				// the card does — it ships with Ryu whether or not its catalog row
				// happens to carry `added`, and a right-click offering to "Add" the
				// built-in agent is the one wrong answer here. Then: an agent this
				// platform cannot run has no verbs at all, and everything else gets
				// the same Add/Settings/Remove the card's own control offers.
				const contextMenu =
					entry.id === FLAGSHIP_AGENT_ID
						? storeItemContextMenu({
								installed: true,
								locked: true,
								onOpenSettings: settingsOpener(entry.id) ?? undefined,
							})
						: entry.available || entry.added
							? storeItemContextMenu({
									installed: entry.added,
									onInstall: () => onInstall(entry.id),
									onOpenSettings: settingsOpener(entry.id) ?? undefined,
									onUninstall: () => onUninstall(entry.id),
								})
							: undefined;
				// An agent that cannot run here is dimmed, never hidden: "why is
				// Codex not in this list?" is a worse question to leave the user with
				// than a greyed row whose glyph says which platform it needs.
				const className =
					entry.available || entry.added ? undefined : UNAVAILABLE_ROW_CLASS;
				if (view === "showcase") {
					return (
						<AgentBadgeCard
							action={action}
							className={className}
							contextMenu={contextMenu}
							employeeId={entry.id}
							key={entry.id}
							// On the card face, above the name — Claude, Codex and Cursor are
							// recognised by their marks long before their names are read, and a
							// 20px glyph in the footer strip under the card read as an
							// annotation rather than as whose card this is.
							logo={
								<AgentCatalogLogo
									className="size-20 opacity-90"
									entry={entry}
									size="80px"
								/>
							}
							name={entry.name}
							onOpen={() => onSelect(entry.id)}
							role={entry.description}
							selected={entry.id === selectedId}
						/>
					);
				}
				return (
					<StoreCatalogCard
						action={action}
						brandIcon={
							<AgentCatalogLogo className="size-8" entry={entry} size="32px" />
						}
						contextMenu={contextMenu}
						description={entry.description}
						dimmed={!(entry.available || entry.added)}
						iconUrl={entry.iconUrl}
						key={entry.id}
						name={entry.name}
						onClick={() => onSelect(entry.id)}
						seedId={entry.id}
						selected={entry.id === selectedId}
					/>
				);
			})}
		</StoreCardGrid>
	);
}

function AgentList({
	agents,
	grouped,
	loading,
	error,
	selectedId,
	pendingId,
	onSelect,
	onInstall,
	onUninstall,
	onClearSearch,
	onRetry,
	settingsOpener,
}: {
	agents: AgentCatalogEntry[];
	/** False while searching: results collapse into a single ungrouped grid. */
	grouped: boolean;
	loading: boolean;
	error: string | null;
	selectedId: string | null;
	pendingId: string | null;
	onSelect: (id: string) => void;
	onInstall: (id: string) => void;
	onUninstall: (id: string) => void;
	onClearSearch: () => void;
	onRetry: () => void;
	settingsOpener: PluginSettingsOpener;
}) {
	if (loading && agents.length === 0) {
		return (
			<div className="flex items-center justify-center p-8 text-muted-foreground">
				<Spinner className="size-5" />
			</div>
		);
	}
	if (error && agents.length === 0) {
		return (
			<Empty className="h-full p-6">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Target01Icon} />
					</EmptyMedia>
					<EmptyTitle>Couldn&apos;t load agents</EmptyTitle>
					<EmptyDescription>{error}</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onRetry} size="sm" variant="ghost">
						Try again
					</Button>
				</EmptyContent>
			</Empty>
		);
	}
	if (agents.length === 0) {
		return (
			<Empty className="h-full p-6">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Target01Icon} />
					</EmptyMedia>
					<EmptyTitle>No agents found</EmptyTitle>
					<EmptyDescription>Try a different search.</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onClearSearch} size="sm" variant="ghost">
						Clear search
					</Button>
				</EmptyContent>
			</Empty>
		);
	}

	const cardProps = {
		onInstall,
		onSelect,
		onUninstall,
		pendingId,
		selectedId,
		settingsOpener,
	};
	if (!grouped) {
		return <AgentCards agents={agents} {...cardProps} />;
	}
	return (
		<div>
			{groupAgents(agents).map((group) => (
				<section className="mb-6" key={group.key}>
					<StoreShelfHeading>{group.label}</StoreShelfHeading>
					<AgentCards agents={group.items} {...cardProps} />
				</section>
			))}
		</div>
	);
}

function AgentDetailPanel({
	entry,
	busy,
	error,
	onInstall,
	onUninstall,
}: {
	entry: AgentCatalogEntry | null;
	busy: boolean;
	error: string | null;
	onInstall: () => void;
	onUninstall: () => void;
}) {
	if (!entry) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Target01Icon} />
					</EmptyMedia>
					<EmptyTitle>No agent selected</EmptyTitle>
					<EmptyDescription>
						Pick an agent on the left to review its details and install it.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	const updateAvailable =
		entry.versionStatus === "behind_latest" ||
		entry.bridgeVersionStatus === "behind_latest";

	return (
		<ListingDetailShell
			actions={
				<>
					<InstallButton
						busy={busy}
						entry={entry}
						onInstall={onInstall}
						onUninstall={onUninstall}
					/>
					{error && (
						<span className="ml-auto flex items-center gap-1.5 text-destructive text-sm">
							<HugeiconsIcon className="size-4 shrink-0" icon={Alert01Icon} />
							{error}
						</span>
					)}
				</>
			}
			aside={
				<ListingAsideCard title="Information">
					<ListingInfoGrid
						rows={[
							{ label: "Engine", value: entry.engine ?? "—" },
							{ label: "Transport", value: entry.transport ?? "—" },
							{ label: "Registry ID", value: entry.registryId ?? "—" },
							{
								label: "On PATH",
								value:
									entry.detected === null
										? "Unknown"
										: entry.detected
											? "Yes"
											: "No",
							},
							{
								label: "Gateway",
								value: entry.gatewayBypass ? "Bypassed" : "Routed",
							},
						]}
					/>
				</ListingAsideCard>
			}
			hero={
				<ListingHero
					badges={[
						entry.added ? "Added" : "Not added",
						entry.recommended ? "Recommended" : null,
						entry.available ? null : UNAVAILABLE_AGENT_REASON,
						updateAvailable ? "Update available" : null,
					].filter((b): b is string => Boolean(b))}
					icon={
						<AgentCatalogLogo
							className="size-9 opacity-90"
							entry={entry}
							size="36px"
						/>
					}
					name={entry.name}
					tagline={entry.description}
				/>
			}
			stats={
				<ListingStatStrip
					items={[
						{
							label: "Agent",
							sub: entry.latestVersion
								? `Latest v${entry.latestVersion}`
								: undefined,
							value: entry.installedVersion
								? `v${entry.installedVersion}`
								: (entry.latestVersion ?? "—"),
						},
						{
							label: "Bridge",
							sub: entry.latestBridgeVersion
								? `Latest v${entry.latestBridgeVersion}`
								: undefined,
							value: entry.installedBridgeVersion
								? `v${entry.installedBridgeVersion}`
								: (entry.latestBridgeVersion ?? "—"),
						},
						{ label: "Engine", value: entry.engine ?? "—" },
						{ label: "Transport", value: entry.transport ?? "—" },
						{
							label: "Status",
							value: entry.added ? "Added" : "Available",
						},
					]}
				/>
			}
		>
			<ListingSection title="About">
				<p className="text-muted-foreground text-sm leading-relaxed">
					{entry.description ?? "No description provided."}
				</p>
			</ListingSection>
			{entry.installHint ? (
				<ListingSection title="Adding this agent">
					<p className="text-muted-foreground text-sm">{entry.installHint}</p>
				</ListingSection>
			) : null}
		</ListingDetailShell>
	);
}

export default function AgentsCatalogSection({
	initialQuery = "",
	initialSelectedId,
}: {
	initialQuery?: string;
	/** Open this item's preview on arrival — the id of a card clicked on the
	 *  Store's Home shelves. */
	initialSelectedId?: string;
} = {}) {
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

	// ── Community agents (published definitions, control plane) ────────────────
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

	const run = async (id: string, action: () => Promise<void>) => {
		setErrorId(null);
		try {
			await action();
		} catch {
			setErrorId(id);
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
			toast.success(`${result.agent.name} is now one of your agents`, {
				description:
					"Open it to grant anything it asked for — nothing was enabled for you.",
			});
		} catch (e) {
			toast.error("Couldn't install this agent", {
				description: e instanceof Error ? e.message : String(e),
			});
		}
	};

	const communityInstall = selectedCommunity
		? (installedRequires[selectedCommunity.id] ?? null)
		: null;

	return (
		<StoreCatalogLayout
			detail={
				selectedCommunity ? (
					<CommunityAgentDetail
						busy={
							community.pendingId === selectedCommunity.id ||
							buying === selectedCommunity.id
						}
						card={selectedCommunity}
						onBuy={() => buy({ id: selectedCommunity.id, kind: "agent" })}
						onInstall={() => installCommunity(selectedCommunity)}
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
								run(selectedId, () => install(selectedId));
							}
						}}
						onUninstall={() => {
							if (selectedId) {
								run(selectedId, () => uninstall(selectedId));
							}
						}}
					/>
				)
			}
			detailTitle={selectedCommunity?.name ?? selectedEntry?.name ?? "Agent"}
			hasSelection={selectedCommunity != null || selectedEntry != null}
			list={
				<>
					<AgentList
						agents={filtered}
						error={error}
						grouped={debouncedQuery.trim().length === 0}
						loading={loading}
						onClearSearch={() => setQuery("")}
						onInstall={(id) => run(id, () => install(id))}
						onRetry={() => {
							void reload();
						}}
						onSelect={(id) => {
							setSelectedCommunity(null);
							setSelectedId(id);
						}}
						onUninstall={(id) => run(id, () => uninstall(id))}
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
