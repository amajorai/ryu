import {
	CheckmarkCircle02Icon,
	ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import StoreCatalogLayout, {
	StoreCardGrid,
} from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import StoreItemAction, {
	StoreItemOverflowMenu,
	storeItemContextMenu,
} from "@ryu/marketplace/catalog/chrome/store-item-action";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import InfiniteSentinel from "@/src/components/store/InfiniteSentinel.tsx";
import { McpDetailPanel } from "@/src/components/store/McpCatalogSection-detail-panel.tsx";
import { useMcpCatalog } from "@/src/hooks/useMcpCatalog.ts";
import {
	type PluginSettingsOpener,
	usePluginSettingsOpener,
} from "@/src/hooks/usePluginSettingsOpener.ts";
import type { McpCatalogCard, McpCatalogSource } from "@/src/lib/api/mcp.ts";

/**
 * MCP catalog as an embeddable Store section on the shared App-Store layout:
 * a search + filter toolbar over a 2-column card grid, with a floating preview
 * for the selected server. Browses MCP servers from the active source (the
 * official MCP registry by default), shows each server's launch surface
 * (packages/remotes), and installs a chosen server as a disabled
 * `~/.ryu/state/mcp.json` entry — Core never auto-launches a registry command.
 * Installed-state is derived from the registered server set, not the payload.
 */
export default function McpCatalogSection({
	initialQuery = "",
	initialSelectedId,
}: {
	/** Seed the search box (e.g. carried over from the store-wide search). */
	initialQuery?: string;
	/** Open this item's preview on arrival — the id of a card clicked on the
	 *  Store's Home shelves. */
	initialSelectedId?: string;
} = {}) {
	// An MCP server that ships inside a plugin (the plugin declares `mcp_servers`)
	// is configured through that plugin's settings; a plain registry server has no
	// settings and resolves to null.
	const settingsOpener = usePluginSettingsOpener();
	const {
		servers,
		loading,
		error,
		fetchNextPage,
		hasNextPage,
		loadingMore,
		query,
		setQuery,
		selectedId,
		select,
		detail,
		detailLoading,
		detailError,
		installing,
		install,
		sources,
		activeSource,
		selectSource,
		selectingSource,
		retryList,
	} = useMcpCatalog(initialQuery);

	// The Store shell's "installed only" switch (the retired "Added" tab,
	// inverted). Applied to the rendered list because the MCP registry feed has no
	// server-side installed filter to push it into.
	const installedOnly = useInstalledOnly();
	const visibleServers = useMemo(
		() => (installedOnly ? servers.filter((s) => s.installed) : servers),
		[servers, installedOnly]
	);

	// A Home shelf card opens this section with its item already selected. One
	// shot, latched: the prop is a arrival instruction, not a controlled value, so
	// re-running it would fight the user's own next click (and `select` changes
	// identity on every refetch, which would make a plain dep array do exactly
	// that).
	const preselected = useRef(false);
	useEffect(() => {
		if (!initialSelectedId || preselected.current) {
			return;
		}
		preselected.current = true;
		select(initialSelectedId);
	}, [initialSelectedId, select]);

	// Per-card install without a per-id hook: the hook's install() acts on the
	// SELECTED server, so a card's Install selects its row and defers the call
	// until the selection lands (non-racy — the effect fires only once selectedId
	// matches). MCP has no enable/disable, so install is the only card action.
	const [pendingInstallId, setPendingInstallId] = useState<string | null>(null);

	useEffect(() => {
		if (!pendingInstallId || selectedId !== pendingInstallId) {
			return;
		}
		install().catch(() => {
			// Errors surface through the hook's error state in the detail panel.
		});
		setPendingInstallId(null);
	}, [pendingInstallId, selectedId, install]);

	const cardInstall = (id: string) => {
		setPendingInstallId(id);
		select(id);
	};

	// The source picker folds into the toolbar filter popover, but only when
	// there is a real choice (the official MCP registry plus any registries
	// behind the seam).
	const filter =
		sources.length > 1
			? {
					label: "Source",
					icon: ServerStack01Icon,
					panel: (
						<div className="p-4">
							<McpSourcePicker
								activeSource={activeSource}
								selectingSource={selectingSource}
								selectSource={selectSource}
								sources={sources}
							/>
						</div>
					),
				}
			: undefined;

	return (
		<StoreCatalogLayout
			detail={
				<McpDetailPanel
					detail={detail}
					error={detailError}
					install={install}
					installing={installing}
					loading={detailLoading}
					selectedId={selectedId}
				/>
			}
			detailTitle={detail?.card.name ?? "MCP server"}
			filter={filter}
			hasSelection={Boolean(selectedId)}
			list={
				<McpServerList
					error={error}
					fetchNextPage={fetchNextPage}
					hasNextPage={hasNextPage}
					installing={installing}
					loading={loading}
					loadingMore={loadingMore}
					onClearSearch={() => setQuery("")}
					onInstall={cardInstall}
					onRetry={() => {
						retryList().catch(() => undefined);
					}}
					onSelect={select}
					selectedId={selectedId}
					servers={visibleServers}
					settingsOpener={settingsOpener}
				/>
			}
			onCloseDetail={() => select("")}
			search={{
				value: query,
				onChange: setQuery,
				placeholder: "Search MCP servers…",
			}}
		/>
	);
}

/**
 * Source dropdown (the official MCP registry plus any registries behind the
 * seam). List + select only — mirrors the Models catalog source picker. Only
 * shown when there is a real choice.
 */
function McpSourcePicker({
	sources,
	activeSource,
	selectSource,
	selectingSource,
}: {
	sources: McpCatalogSource[];
	activeSource: string;
	selectSource: (id: string) => void;
	selectingSource: boolean;
}) {
	if (sources.length <= 1) {
		return null;
	}
	const sourceItems = sources.map((s) => ({
		value: s.id,
		label: s.displayName,
	}));
	return (
		<Select
			disabled={selectingSource}
			items={sourceItems}
			onValueChange={(value) => {
				if (value) {
					selectSource(value);
				}
			}}
			value={activeSource}
		>
			<SelectTrigger className="h-8 w-[180px]" size="sm">
				<SelectValue placeholder="Source" />
			</SelectTrigger>
			<SelectContent>
				{sourceItems.map((opt) => (
					<SelectItem key={opt.value} value={opt.value}>
						{opt.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function McpServerList({
	servers,
	loading,
	loadingMore,
	error,
	selectedId,
	installing,
	onSelect,
	onInstall,
	fetchNextPage,
	hasNextPage,
	settingsOpener,
	onClearSearch,
	onRetry,
}: {
	servers: McpCatalogCard[];
	loading: boolean;
	loadingMore: boolean;
	error: string | null;
	selectedId: string | null;
	installing: string | null;
	onSelect: (id: string) => void;
	onInstall: (id: string) => void;
	onClearSearch: () => void;
	onRetry: () => void;
	fetchNextPage: () => void;
	hasNextPage: boolean;
	/** Resolves a server to the settings of the plugin that provides it, when one
	 *  does. A registry server that is not a plugin resolves to null. */
	settingsOpener: PluginSettingsOpener;
}) {
	const tl = useLiteralMessages();
	// The IntersectionObserver root is StoreCatalogLayout's own scroll container,
	// which wraps this list — so the grid must not add a second scroll region.
	const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

	if (loading && servers.length === 0) {
		return (
			<div className="p-8">
				<SkeletonRows />
			</div>
		);
	}
	if (error) {
		return (
			<div className="flex flex-col items-start gap-3 p-4 text-sm">
				<p className="text-status-destructive">
					{tl("Couldn't load MCP servers: {error}", { error })}
				</p>
				<Button onClick={onRetry} size="sm" variant="ghost">
					Try again
				</Button>
			</div>
		);
	}
	if (servers.length === 0) {
		return (
			<Empty className="h-full" inset="dense">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={ServerStack01Icon} />
					</EmptyMedia>
					<EmptyTitle>No MCP servers found</EmptyTitle>
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
		<div ref={setScrollEl}>
			<StoreCardGrid>
				{servers.map((s) => (
					<StoreCatalogCard
						action={
							<McpCardAction
								busy={installing === s.id}
								card={s}
								onInstall={() => onInstall(s.id)}
								onOpenSettings={settingsOpener(s.id)}
							/>
						}
						// An installed MCP server has no enable/uninstall concept (see
						// `McpCardAction`), so its menu holds Settings when the listing
						// declares any and renders nothing at all when it does not.
						contextMenu={storeItemContextMenu({
							installed: s.installed,
							onInstall: () => onInstall(s.id),
							onOpenSettings: settingsOpener(s.id) ?? undefined,
						})}
						description={s.description}
						icon={<HugeiconsIcon className="size-5" icon={ServerStack01Icon} />}
						key={s.id}
						likeNamespace={`mcp:${s.id}`}
						name={s.name}
						onClick={() => onSelect(s.id)}
						seedId={s.id}
						selected={s.id === selectedId}
					/>
				))}
			</StoreCardGrid>
			<InfiniteSentinel
				hasMore={hasNextPage}
				loading={loadingMore}
				onLoadMore={fetchNextPage}
				root={scrollEl}
			/>
		</div>
	);
}

/** Card action for an MCP server. Install writes a disabled `mcp.json` entry;
 *  there is no uninstall/enable, so an installed row shows a plain, inert
 *  "Installed" pill instead of StoreItemAction's install→enable morph (which
 *  would offer a bogus "Enable" MCP has no concept of). */
function McpCardAction({
	card,
	busy,
	onInstall,
	onOpenSettings,
}: {
	card: McpCatalogCard;
	busy: boolean;
	onInstall: () => void;
	/** Set when the server is provided by an installed plugin that declares
	 *  settings; a plain registry server has none and gets no menu. */
	onOpenSettings?: (() => void) | null;
}) {
	if (card.installed) {
		return (
			<div className="flex items-center gap-0.5">
				<Button disabled size="sm" variant="secondary">
					<HugeiconsIcon
						className="size-3.5 text-status-success"
						icon={CheckmarkCircle02Icon}
					/>
					Added
				</Button>
				<StoreItemOverflowMenu onOpenSettings={onOpenSettings ?? undefined} />
			</div>
		);
	}
	return (
		<StoreItemAction
			busy={busy}
			installed={false}
			onInstall={onInstall}
			onOpenSettings={onOpenSettings ?? undefined}
		/>
	);
}
