import {
	CheckmarkCircle02Icon,
	Download01Icon,
	ServerStack01Icon,
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import { useEffect, useState } from "react";
import InfiniteSentinel from "@/src/components/store/InfiniteSentinel.tsx";
import { useMcpCatalog } from "@/src/hooks/useMcpCatalog.ts";
import type {
	McpCatalogCard,
	McpCatalogDetail,
	McpCatalogSource,
} from "@/src/lib/api/mcp.ts";
import { useInstallProgress } from "@/src/store/useDownloadsStore.ts";

/**
 * MCP catalog as an embeddable Store section on the shared App-Store layout:
 * a search + filter toolbar over a 2-column card grid, with a floating preview
 * for the selected server. Browses MCP servers from the active source (the
 * official MCP registry by default), shows each server's launch surface
 * (packages/remotes), and installs a chosen server as a disabled
 * `~/.ryu/mcp.json` entry — Core never auto-launches a registry command.
 * Installed-state is derived from the registered server set, not the payload.
 */
export default function McpCatalogSection({
	initialQuery = "",
}: {
	/** Seed the search box (e.g. carried over from the store-wide search). */
	initialQuery?: string;
} = {}) {
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
	} = useMcpCatalog(initialQuery);

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
					onInstall={cardInstall}
					onSelect={select}
					selectedId={selectedId}
					servers={servers}
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
			<SelectTrigger className="h-8 w-[180px] text-sm" size="sm">
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
}: {
	servers: McpCatalogCard[];
	loading: boolean;
	loadingMore: boolean;
	error: string | null;
	selectedId: string | null;
	installing: string | null;
	onSelect: (id: string) => void;
	onInstall: (id: string) => void;
	fetchNextPage: () => void;
	hasNextPage: boolean;
}) {
	// The IntersectionObserver root is StoreCatalogLayout's own scroll container,
	// which wraps this list — so the grid must not add a second scroll region.
	const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

	if (loading && servers.length === 0) {
		return (
			<div className="flex items-center justify-center p-8 text-muted-foreground">
				<Spinner className="size-5" />
			</div>
		);
	}
	if (error) {
		return (
			<div className="p-4 text-destructive text-sm">
				Couldn't load MCP servers: {error}
			</div>
		);
	}
	if (servers.length === 0) {
		return (
			<Empty className="h-full p-6">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={ServerStack01Icon} />
					</EmptyMedia>
					<EmptyTitle>No MCP servers found</EmptyTitle>
					<EmptyDescription>Try a different search.</EmptyDescription>
				</EmptyHeader>
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
							/>
						}
						description={s.description}
						icon={<HugeiconsIcon className="size-5" icon={ServerStack01Icon} />}
						key={s.id}
						name={s.name}
						onClick={() => onSelect(s.id)}
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
}: {
	card: McpCatalogCard;
	busy: boolean;
	onInstall: () => void;
}) {
	if (card.installed) {
		return (
			<Button disabled size="sm" variant="secondary">
				<HugeiconsIcon
					className="size-3.5 text-success"
					icon={CheckmarkCircle02Icon}
				/>
				Installed
			</Button>
		);
	}
	return (
		<StoreItemAction busy={busy} installed={false} onInstall={onInstall} />
	);
}

function McpDetailPanel({
	selectedId,
	detail,
	loading,
	error,
	install,
	installing,
}: {
	selectedId: string | null;
	detail: McpCatalogDetail | null;
	loading: boolean;
	error: string | null;
	install: () => Promise<void>;
	installing: string | null;
}) {
	if (!selectedId) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={ServerStack01Icon} />
					</EmptyMedia>
					<EmptyTitle>No server selected</EmptyTitle>
					<EmptyDescription>
						Pick an MCP server on the left to review what it launches before
						adding it.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}
	if (loading && !detail) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground">
				<Spinner className="size-5" />
			</div>
		);
	}
	if (error) {
		return (
			<div className="p-4 text-destructive text-sm">
				Couldn't load this server: {error}
			</div>
		);
	}
	if (!detail) {
		return null;
	}

	const { card, packages, remotes } = detail;
	const isInstalling = installing === card.id;
	const { percent } = useInstallProgress(["tool", "other"], card.name);

	return (
		<div className="scroll-fade-effect-y flex h-full flex-col gap-6 overflow-auto p-4">
			<header className="flex flex-col gap-3">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<h2 className="truncate font-semibold text-xl">{card.name}</h2>
						{card.version && (
							<p className="text-muted-foreground text-sm">v{card.version}</p>
						)}
					</div>
					{card.installed ? (
						<Badge className="shrink-0 gap-1" variant="secondary">
							<HugeiconsIcon
								className="size-3.5 text-success"
								icon={CheckmarkCircle02Icon}
							/>
							Installed
						</Badge>
					) : (
						<InstallProgressButton
							installing={isInstalling}
							onClick={() => {
								install().catch(() => undefined);
							}}
							percent={percent}
						>
							<HugeiconsIcon className="size-4" icon={Download01Icon} />
							Install server
						</InstallProgressButton>
					)}
				</div>
				{card.description && (
					<p className="text-muted-foreground text-sm">{card.description}</p>
				)}
				{card.installed && (
					<p className="text-muted-foreground text-xs">
						Added to your MCP servers (disabled). Enable and start it from the
						Tools page — Ryu never auto-launches a registry command.
					</p>
				)}
			</header>

			{packages.length > 0 && (
				<section className="flex flex-col gap-2">
					<h3 className="font-medium text-sm">Packages ({packages.length})</h3>
					<div className="flex flex-col gap-2">
						{packages.map((p) => (
							<div
								className="rounded-md border px-3 py-2"
								key={`${p.registryType}:${p.identifier}:${p.version}`}
							>
								<div className="flex items-center gap-2">
									{p.registryType && (
										<Badge className="text-[10px]" variant="secondary">
											{p.registryType}
										</Badge>
									)}
									{p.transport && (
										<Badge className="text-[10px]" variant="outline">
											{p.transport}
										</Badge>
									)}
								</div>
								<div className="mt-1 truncate font-mono text-sm">
									{p.identifier ?? "—"}
									{p.version ? `@${p.version}` : ""}
								</div>
							</div>
						))}
					</div>
				</section>
			)}

			{remotes.length > 0 && (
				<section className="flex flex-col gap-2">
					<h3 className="font-medium text-sm">Remotes ({remotes.length})</h3>
					<div className="flex flex-col gap-2">
						{remotes.map((r) => (
							<div
								className="rounded-md border px-3 py-2"
								key={`${r.transportType}:${r.url}`}
							>
								{r.transportType && (
									<Badge className="text-[10px]" variant="secondary">
										{r.transportType}
									</Badge>
								)}
								<div className="mt-1 break-all font-mono text-sm">
									{r.url ?? "—"}
								</div>
							</div>
						))}
					</div>
				</section>
			)}

			{packages.length === 0 && remotes.length === 0 && (
				<p className="text-muted-foreground text-sm">
					This server advertises no launchable package or remote endpoint.
				</p>
			)}
		</div>
	);
}
