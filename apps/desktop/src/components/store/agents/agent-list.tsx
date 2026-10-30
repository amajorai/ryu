// The Agents section's list: sorting, the card install action, the grouped
// employee-badge cards and the list states. Split from AgentsCatalogSection.

import {
	Delete01Icon,
	Download01Icon,
	Target01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { InstallProgressButton } from "@ryu/blocks/desktop/install-button.tsx";
import {
	STORE_LOAD_ERROR_SENTENCE,
	StoreErrorDetails,
} from "@ryu/blocks/desktop/store-error-details.tsx";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import {
	StoreCardGrid,
	useStoreViewMode,
} from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import StoreItemAction, {
	storeItemContextMenu,
} from "@ryu/marketplace/catalog/chrome/store-item-action";
import StoreShelfHeading from "@ryu/marketplace/catalog/chrome/store-shelf-heading";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import {
	StatusBadge,
	UNAVAILABLE_ROW_CLASS,
} from "@ryu/ui/components/status-badge.tsx";
import { AgentBadgeCard } from "@/src/components/agents/AgentBadgeCard.tsx";
import type { PluginSettingsOpener } from "@/src/hooks/usePluginSettingsOpener.ts";
import { groupAgents } from "@/src/lib/agent-catalog-groups.ts";
import { AgentCatalogLogo } from "@/src/lib/agent-catalog-logo.tsx";
import type { AgentCatalogEntry } from "@/src/lib/api/agents.ts";
import { useInstallProgress } from "@/src/store/useDownloadsStore.ts";

// The Agents section's list: sorting, the card install action, the grouped
// employee-badge cards and the list states. Split from AgentsCatalogSection.

export const SEARCH_DEBOUNCE_MS = 200;

/** The flagship agent: always installed, cannot be uninstalled. */
export const FLAGSHIP_AGENT_ID = "ryu";

/** Why an agent row is dimmed and un-addable. One string, three surfaces (the
 *  card action, the detail header, the detail hero), so the card's tooltip and
 *  the hero's chip cannot drift into two different explanations. */
export const UNAVAILABLE_AGENT_REASON = "Unavailable on this platform";

/** Sort recommended agents first, then by display name. */
export function sortAgents(agents: AgentCatalogEntry[]): AgentCatalogEntry[] {
	return [...agents].sort((a, b) => {
		if (a.recommended !== b.recommended) {
			return a.recommended ? -1 : 1;
		}
		return a.name.localeCompare(b.name);
	});
}

export function InstallButton({
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
export function AgentCardAction({
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

export function AgentCards({
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
									className="size-20"
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

export function AgentList({
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
		return <SkeletonRows inset="catalog" />;
	}
	if (error && agents.length === 0) {
		return (
			<Empty className="h-full" inset="dense">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Target01Icon} />
					</EmptyMedia>
					<EmptyTitle>Couldn&apos;t load agents</EmptyTitle>
					<EmptyDescription>{STORE_LOAD_ERROR_SENTENCE}</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onRetry} size="sm" variant="outline">
						Try again
					</Button>
					<StoreErrorDetails message={error} />
				</EmptyContent>
			</Empty>
		);
	}
	if (agents.length === 0) {
		return (
			<Empty className="h-full" inset="dense">
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
