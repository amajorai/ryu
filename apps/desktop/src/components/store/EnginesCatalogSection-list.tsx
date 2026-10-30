import { LayerIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { EngineFootnote } from "@ryu/blocks/desktop/store-engines.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import { StoreCardGrid } from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import StoreItemAction, {
	StoreItemOverflowMenu,
	storeItemContextMenu,
} from "@ryu/marketplace/catalog/chrome/store-item-action";
import StoreShelfHeading from "@ryu/marketplace/catalog/chrome/store-shelf-heading";
import { engineLogoProps } from "@ryu/marketplace/catalog/engine-logos";
import { safeHttpUrl } from "@ryu/marketplace/catalog/safe-url";
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
import { StatusBadge } from "@ryu/ui/components/status-badge.tsx";
import type { PluginSettingsOpener } from "@/src/hooks/usePluginSettingsOpener.ts";
import { useInstallProgress } from "@/src/store/useDownloadsStore.ts";
import {
	type EngineListItem,
	type EngineListKind,
	type EngineToggleLabel,
	GROUP_LABELS,
	type RowState,
	SANDBOX_INSTALL_DOCS,
	TOGGLE_LABELS,
} from "./EnginesCatalogSection-model.ts";

/**
 * The inline lifecycle control on an engine card — the SAME {@link StoreItemAction}
 * Apps, Plugins, Skills, MCP and Agents cards use, so an engine installs from the
 * list without first opening its preview.
 *
 * Its own component (not a node built in the list's `useMemo`) because the live
 * download percent comes from a hook, which can't run per-item inside a memo.
 *
 * Rows with nothing to offer render a status Badge instead of an empty 3-dot menu:
 * an engine this node can't run, and one whose only action would be a toggle it is
 * already in (the resident text engine, the default sandbox — neither can be
 * switched off, only swapped away from by picking another row).
 */
/**
 * The right-click rows for an engine card — the same branches
 * {@link EngineCardAction} takes, restated for the context-menu primitive.
 *
 * `undefined` (no menu at all) for the two rows that genuinely have no verb: an
 * engine this platform cannot run, and a sandbox runtime Ryu only DETECTS. Both
 * already say so in their status badge, and a menu whose single row is greyed
 * out teaches nothing the badge did not.
 */
export function engineCardContextMenu({
	busy,
	item,
	onInstall,
	onOpenSettings,
	onToggle,
	onUninstall,
}: {
	busy: boolean;
	item: EngineListItem;
	onInstall: (item: EngineListItem) => void;
	onOpenSettings?: (() => void) | null;
	onToggle: (item: EngineListItem, next: boolean) => void;
	onUninstall: (item: EngineListItem) => void;
}) {
	if (busy || item.toggleKnown === false) {
		return undefined;
	}
	if (!item.available) {
		// A node that can no longer run an installed engine can still reclaim its
		// disk space: Remove is the only action left on offer.
		return item.installed && item.canUninstall
			? storeItemContextMenu({
					installed: true,
					onUninstall: () => onUninstall(item),
				})
			: undefined;
	}
	const labels: EngineToggleLabel = TOGGLE_LABELS[item.kind];
	if (!item.installed) {
		if (item.installState === null) {
			return undefined;
		}
		return storeItemContextMenu({
			installed: false,
			onInstall: () => onInstall(item),
			onOpenSettings: onOpenSettings ?? undefined,
		});
	}
	// `toggleKnown === false` already returned above, so only the toggle state
	// itself decides which direction is on offer.
	const canToggleOn = !item.toggled;
	const canToggleOff = item.toggled && Boolean(labels.disable);
	return storeItemContextMenu({
		disableLabel: labels.disable,
		enabled: item.toggled,
		enableLabel: labels.enable,
		installed: true,
		onDisable: canToggleOff ? () => onToggle(item, false) : undefined,
		onEnable: canToggleOn ? () => onToggle(item, true) : undefined,
		onOpenSettings: onOpenSettings ?? undefined,
		onUninstall: item.canUninstall ? () => onUninstall(item) : undefined,
	});
}

export function EngineCardAction({
	item,
	busy,
	onInstall,
	onUninstall,
	onToggle,
	onOpenSettings,
}: {
	busy: boolean;
	item: EngineListItem;
	onInstall: (item: EngineListItem) => void;
	onToggle: (item: EngineListItem, next: boolean) => void;
	onUninstall: (item: EngineListItem) => void;
	/** Set for an engine that is ALSO an installed plugin with settings (a voice
	 *  or sandbox backend shipped as an app); null for the rest. */
	onOpenSettings?: (() => void) | null;
}) {
	const { percent } = useInstallProgress(
		["engine", "voice", "media", "embedding"],
		item.name
	);
	const tl = useLiteralMessages();
	const labels: EngineToggleLabel = TOGGLE_LABELS[item.kind];

	if (item.toggleKnown === false) {
		return (
			<span className="text-muted-foreground text-xs">Status unknown</span>
		);
	}

	if (!item.available) {
		return (
			// The glyph's hover label carries the node's reason when the row has
			// one; the detail hero and footnote repeat it in full.
			<div className="flex items-center gap-1">
				<StatusBadge
					kind="unavailable"
					label={item.unavailableReason ?? "Not supported on this platform"}
				/>
				{/* Remove stays available for an installed engine this node can no
				    longer run, so its disk space can be reclaimed. */}
				{item.installed && item.canUninstall ? (
					<StoreItemAction
						busy={busy}
						installed
						onUninstall={() => onUninstall(item)}
					/>
				) : null}
			</div>
		);
	}

	if (!item.installed) {
		// A sandbox backend has no install lifecycle in Ryu — its CLI is detected on
		// the node or it isn't — so it gets a status, not an Install button that
		// could not do anything.
		if (item.installState === null) {
			// Not a bare chip: this row can never gain an Install button (Ryu is
			// detection-only for sandbox runtimes), so a dead badge is the ONLY thing
			// the user would ever see here. The glyph carries the reason on hover and
			// the link is the action the row is actually able to offer.
			const docs = SANDBOX_INSTALL_DOCS.get(item.name);
			return (
				<div className="flex items-center gap-1">
					<StatusBadge
						kind="unavailable"
						label={
							docs
								? (docs.notDetected ??
									tl(
										"Not detected. Ryu does not install {displayName} — it needs elevated privileges on every platform. Install {what} and it is picked up automatically.",
										{ displayName: item.displayName, what: docs.what }
									))
								: "Not detected on this node"
						}
					/>
					{docs ? (
						<Button
							render={
								<a
									href={safeHttpUrl(docs.href) ?? undefined}
									rel="noopener noreferrer"
									target="_blank"
								/>
							}
							size="sm"
							variant="ghost"
						>
							How to install
						</Button>
					) : null}
				</div>
			);
		}
		return (
			<StoreItemAction
				busy={busy || item.installState === "installing"}
				installed={false}
				onInstall={() => onInstall(item)}
				onOpenSettings={onOpenSettings ?? undefined}
				percent={percent}
			/>
		);
	}

	// `toggleKnown === false` already returned above, so only the toggle state
	// itself decides which direction is on offer.
	const canToggleOn = !item.toggled;
	const canToggleOff = item.toggled && Boolean(labels.disable);
	// Nothing left to offer (the resident text engine and the default sandbox can
	// only be swapped away from, by picking another row) → render nothing rather
	// than a 3-dot menu that opens empty. The row's status badge, which such a row
	// always carries ("Active" / "Default"), already says where it stands.
	if (!(canToggleOn || canToggleOff || item.canUninstall)) {
		// …unless it is configurable, in which case the menu is not empty after all.
		return onOpenSettings ? (
			<StoreItemOverflowMenu onOpenSettings={onOpenSettings} />
		) : null;
	}

	return (
		<StoreItemAction
			busy={busy}
			disableLabel={labels.disable}
			enabled={item.toggled}
			enableLabel={labels.enable}
			installed
			onDisable={canToggleOff ? () => onToggle(item, false) : undefined}
			onEnable={canToggleOn ? () => onToggle(item, true) : undefined}
			onOpenSettings={onOpenSettings ?? undefined}
			onUninstall={item.canUninstall ? () => onUninstall(item) : undefined}
			percent={percent}
		/>
	);
}

export function EngineList({
	groups,
	loading,
	error,
	selectedId,
	onSelect,
	rowState,
	onInstall,
	onUninstall,
	onToggle,
	onClearSearch,
	settingsOpener,
}: {
	/** Resolves a row to its settings tab; null for an engine that is not an
	 *  installed plugin, which is most of them. */
	settingsOpener: PluginSettingsOpener;
	groups: { kind: EngineListKind; items: EngineListItem[] }[];
	loading: boolean;
	error: string | null;
	selectedId: string | null;
	onInstall: (item: EngineListItem) => void;
	onSelect: (id: string) => void;
	onToggle: (item: EngineListItem, next: boolean) => void;
	onUninstall: (item: EngineListItem) => void;
	onClearSearch: () => void;
	rowState: (name: string) => RowState;
}) {
	const tl = useLiteralMessages();
	const total = groups.reduce((n, g) => n + g.items.length, 0);

	if (loading && total === 0) {
		return <SkeletonRows inset="catalog" />;
	}
	if (error && total === 0) {
		return (
			<div className="p-4 text-sm text-status-destructive">
				{tl("Couldn't load engines: {error}", { error })}
			</div>
		);
	}
	if (total === 0) {
		return (
			<Empty className="h-full" inset="dense">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={LayerIcon} />
					</EmptyMedia>
					<EmptyTitle>No engines found</EmptyTitle>
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

	return (
		<div className="flex flex-col gap-6 pt-2">
			{groups.map((group) => (
				<section key={group.kind}>
					<StoreShelfHeading>{GROUP_LABELS[group.kind]}</StoreShelfHeading>
					<StoreCardGrid>
						{group.items.map((item) => {
							const errorMessage = rowState(item.name).error;
							return (
								<StoreCatalogCard
									action={
										<div className="flex flex-col items-end gap-1">
											<div className="flex items-center gap-2">
												{item.status ? (
													<StatusBadge
														kind={item.status.kind}
														label={item.status.label}
													/>
												) : null}
												<EngineCardAction
													busy={rowState(item.name).pending !== null}
													item={item}
													onInstall={onInstall}
													onOpenSettings={settingsOpener(item.name)}
													onToggle={onToggle}
													onUninstall={onUninstall}
												/>
											</div>
											{errorMessage ? (
												<div role="alert">
													<EngineFootnote tone="destructive">
														{errorMessage}
													</EngineFootnote>
												</div>
											) : null}
										</div>
									}
									contextMenu={engineCardContextMenu({
										busy: rowState(item.name).pending !== null,
										item,
										onInstall,
										onOpenSettings: settingsOpener(item.name),
										onToggle,
										onUninstall,
									})}
									description={item.description}
									// An engine that cannot run on this platform is dimmed, never
									// hidden — the platform answer is exactly what the user came to
									// find. Its status glyph carries the reason.
									dimmed={!item.available}
									key={item.id}
									{...engineLogoProps(item.name)}
									name={item.displayName}
									onClick={() => onSelect(item.id)}
									selected={item.id === selectedId}
								/>
							);
						})}
					</StoreCardGrid>
				</section>
			))}
		</div>
	);
}
