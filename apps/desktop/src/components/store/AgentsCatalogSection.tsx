// apps/desktop/src/components/store/AgentsCatalogSection.tsx
//
// The Agents section in the Store. Browses Core's agent catalog
// (`GET /api/agents/catalog`): every built-in agent (the flagship "Ryu" Pi+Gateway
// plus the full ACP registry (Claude Agent, Codex, Cursor, Devin, …) loaded
// from the official CDN. It drives the install/uninstall lifecycle that adds or removes an agent
// from the installed set surfaced in the chat picker.
//
// Uses the shared Store master-detail layout (left list, right preview) like
// Plugins, Models, MCP, and Skills. Two per-entry signals are surfaced as badges:
//   - `added`    → the agent is installed (in the picker). Drives the button mode.
//   - `detected` → the agent's CLI binary is on PATH (null when not detectable),
//     a hint that the agent is ready to run locally without a separate install.
// Recommended agents (the flagship) sort first and carry a "Recommended" badge.
// The flagship `ryu` is locked: it is always installed and cannot be removed.

import {
	Alert01Icon,
	CheckmarkCircle02Icon,
	Delete01Icon,
	Download01Icon,
	Loading01Icon,
	Refresh01Icon,
	Robot01Icon,
	StarIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { InstallProgressButton } from "@ryu/blocks/desktop/install-button";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import StoreCatalogLayout, {
	StoreCardGrid,
} from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import StoreItemAction from "@ryu/marketplace/catalog/chrome/store-item-action";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Spinner } from "@ryu/ui/components/spinner";
import { useMemo, useState } from "react";
import { useDebouncedValue } from "@/src/hooks/use-debounced-value.ts";
import { useAgentsCatalog } from "@/src/hooks/useAgentsCatalog.ts";
import { AgentCatalogLogo } from "@/src/lib/agent-catalog-logo.tsx";
import type { AgentCatalogEntry } from "@/src/lib/api/agents.ts";
import { useInstallProgress } from "@/src/store/useDownloadsStore.ts";

const SEARCH_DEBOUNCE_MS = 200;

/** The flagship agent: always installed, cannot be uninstalled. */
const FLAGSHIP_AGENT_ID = "ryu";

/** Sort recommended agents first, then by display name. */
function sortAgents(agents: AgentCatalogEntry[]): AgentCatalogEntry[] {
	return [...agents].sort((a, b) => {
		if (a.recommended !== b.recommended) {
			return a.recommended ? -1 : 1;
		}
		return a.name.localeCompare(b.name);
	});
}

/** Provenance/run-readiness hint from the detect flag. */
function detectBadge(entry: AgentCatalogEntry) {
	if (entry.detected === true) {
		return (
			<Badge variant="secondary">
				<HugeiconsIcon className="size-3" icon={CheckmarkCircle02Icon} />
				On PATH
			</Badge>
		);
	}
	return null;
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
		return (
			<Button
				disabled={busy || locked}
				onClick={onUninstall}
				size="sm"
				variant="ghost"
			>
				{busy ? (
					<HugeiconsIcon className="size-4 animate-spin" icon={Loading01Icon} />
				) : (
					<HugeiconsIcon className="size-4" icon={Delete01Icon} />
				)}
				{locked ? "Built in" : "Uninstall"}
			</Button>
		);
	}
	if (!entry.available) {
		return (
			<Button disabled size="sm" variant="ghost">
				<HugeiconsIcon className="size-4" icon={Alert01Icon} />
				Unavailable
			</Button>
		);
	}
	return (
		<InstallProgressButton
			idleVariant="ghost"
			installing={busy}
			onClick={onInstall}
			percent={percent}
		>
			<HugeiconsIcon className="size-4" icon={Download01Icon} />
			Install
		</InstallProgressButton>
	);
}

function AgentBadges({ entry }: { entry: AgentCatalogEntry }) {
	const updateAvailable =
		entry.versionStatus === "behind_latest" ||
		entry.bridgeVersionStatus === "behind_latest";
	return (
		<>
			{entry.added ? (
				<Badge variant="secondary">Installed</Badge>
			) : (
				<Badge variant="secondary">Not installed</Badge>
			)}
			{!entry.available && (
				<Badge variant="outline">
					<HugeiconsIcon className="size-3" icon={Alert01Icon} />
					Not available on this platform
				</Badge>
			)}
			{entry.recommended && (
				<Badge>
					<HugeiconsIcon className="size-3" icon={StarIcon} />
					Recommended
				</Badge>
			)}
			{updateAvailable && (
				<Badge variant="outline">
					<HugeiconsIcon className="size-3" icon={Refresh01Icon} />
					Update available
				</Badge>
			)}
			{entry.installedVersion ? (
				<Badge variant="secondary">Agent v{entry.installedVersion}</Badge>
			) : null}
			{entry.installedBridgeVersion ? (
				<Badge variant="secondary">
					Bridge v{entry.installedBridgeVersion}
				</Badge>
			) : entry.latestBridgeVersion ? (
				<Badge variant="secondary">Bridge v{entry.latestBridgeVersion}</Badge>
			) : null}
			{detectBadge(entry)}
		</>
	);
}

/** Card lifecycle control: locked flagship, unavailable, or install/uninstall. */
function AgentCardAction({
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
	const { percent } = useInstallProgress(["agent"], entry.name);
	if (entry.id === FLAGSHIP_AGENT_ID) {
		return <StoreItemAction installed locked lockedLabel="Built in" />;
	}
	if (!(entry.available || entry.added)) {
		return (
			<Button disabled size="sm" variant="ghost">
				<HugeiconsIcon className="size-4" icon={Alert01Icon} />
				Unavailable
			</Button>
		);
	}
	return (
		<StoreItemAction
			busy={busy}
			installed={entry.added}
			onInstall={onInstall}
			onUninstall={onUninstall}
			percent={percent}
		/>
	);
}

function AgentList({
	agents,
	loading,
	error,
	selectedId,
	pendingId,
	onSelect,
	onInstall,
	onUninstall,
}: {
	agents: AgentCatalogEntry[];
	loading: boolean;
	error: string | null;
	selectedId: string | null;
	pendingId: string | null;
	onSelect: (id: string) => void;
	onInstall: (id: string) => void;
	onUninstall: (id: string) => void;
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
			<div className="p-4 text-destructive text-sm">
				Couldn't load agents: {error}
			</div>
		);
	}
	if (agents.length === 0) {
		return (
			<Empty className="h-full p-6">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Robot01Icon} />
					</EmptyMedia>
					<EmptyTitle>No agents found</EmptyTitle>
					<EmptyDescription>Try a different search.</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		<StoreCardGrid>
			{agents.map((entry) => (
				<StoreCatalogCard
					action={
						<AgentCardAction
							busy={pendingId === entry.id}
							entry={entry}
							onInstall={() => onInstall(entry.id)}
							onUninstall={() => onUninstall(entry.id)}
						/>
					}
					description={entry.description}
					icon={
						<AgentCatalogLogo
							className="size-5 opacity-90"
							entry={entry}
							size="20px"
						/>
					}
					key={entry.id}
					name={entry.name}
					onClick={() => onSelect(entry.id)}
					selected={entry.id === selectedId}
				/>
			))}
		</StoreCardGrid>
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
						<HugeiconsIcon icon={Robot01Icon} />
					</EmptyMedia>
					<EmptyTitle>No agent selected</EmptyTitle>
					<EmptyDescription>
						Pick an agent on the left to review its details and install it.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		<div className="scroll-fade-effect-y flex h-full flex-col gap-6 overflow-auto p-4">
			<header className="flex flex-col gap-3">
				<div className="flex items-start justify-between gap-3">
					<div className="flex min-w-0 items-center gap-3">
						<AgentCatalogLogo
							className="size-8 shrink-0 opacity-90"
							entry={entry}
							size="32px"
						/>
						<div className="min-w-0">
							<h2 className="truncate font-semibold text-xl">{entry.name}</h2>
							{(entry.latestVersion ?? entry.latestBridgeVersion) && (
								<p className="text-muted-foreground text-sm">
									{entry.latestVersion
										? `Latest agent: v${entry.latestVersion}`
										: null}
									{entry.latestVersion && entry.latestBridgeVersion
										? " · "
										: null}
									{entry.latestBridgeVersion
										? `Latest bridge: v${entry.latestBridgeVersion}`
										: null}
								</p>
							)}
						</div>
					</div>
					<InstallButton
						busy={busy}
						entry={entry}
						onInstall={onInstall}
						onUninstall={onUninstall}
					/>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<AgentBadges entry={entry} />
				</div>
				<p className="text-muted-foreground text-sm">
					{entry.description ?? "No description provided."}
				</p>
				{entry.installHint && (
					<p className="text-muted-foreground text-xs">{entry.installHint}</p>
				)}
				{error && (
					<p className="flex items-center gap-1.5 text-destructive text-sm">
						<HugeiconsIcon className="size-4 shrink-0" icon={Alert01Icon} />
						{error}
					</p>
				)}
			</header>
		</div>
	);
}

export default function AgentsCatalogSection({
	initialQuery = "",
}: {
	initialQuery?: string;
} = {}) {
	const [query, setQuery] = useState(initialQuery);
	const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const { agents, loading, error, install, uninstall, pendingId } =
		useAgentsCatalog();
	const [errorId, setErrorId] = useState<string | null>(null);

	const sorted = useMemo(() => sortAgents(agents), [agents]);

	const filtered = useMemo(() => {
		const q = debouncedQuery.trim().toLowerCase();
		if (!q) {
			return sorted;
		}
		return sorted.filter(
			(entry) =>
				entry.name.toLowerCase().includes(q) ||
				(entry.description?.toLowerCase().includes(q) ?? false)
		);
	}, [sorted, debouncedQuery]);

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

	return (
		<StoreCatalogLayout
			detail={
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
			}
			detailTitle={selectedEntry?.name ?? "Agent"}
			hasSelection={selectedEntry != null}
			list={
				<AgentList
					agents={filtered}
					error={error}
					loading={loading}
					onInstall={(id) => run(id, () => install(id))}
					onSelect={setSelectedId}
					onUninstall={(id) => run(id, () => uninstall(id))}
					pendingId={pendingId}
					selectedId={selectedId}
				/>
			}
			onCloseDetail={() => setSelectedId(null)}
			search={{
				value: query,
				onChange: setQuery,
				placeholder: "Search agents…",
			}}
		/>
	);
}
