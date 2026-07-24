import {
	Add01Icon,
	BookOpen01Icon,
	CheckmarkCircle02Icon,
	Download01Icon,
	GridIcon,
	InformationCircleIcon,
	LayoutGridIcon,
	Link01Icon,
	Menu01Icon,
	PackageIcon,
	Robot01Icon,
	ServerStack01Icon,
	SquareLock01Icon,
	WorkflowSquare01Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { type ReactNode, useEffect, useId, useState } from "react";
import CommunityTrustNotice from "./chrome/community-trust-notice.tsx";
import InfiniteSentinel from "./chrome/infinite-sentinel.tsx";
import StoreCatalogCard from "./chrome/store-catalog-card.tsx";
import StoreCatalogLayout, {
	StoreCardGrid,
} from "./chrome/store-catalog-layout.tsx";
import StoreItemAction from "./chrome/store-item-action.tsx";
import { grantDescription, grantLabel } from "./grant-labels.ts";
import {
	type CatalogHost,
	type CatalogInstall,
	type CatalogNode,
	useCatalogHost,
} from "./host.tsx";
import { resolveCardIcon } from "./icon-url.ts";
import { REALM_ICONS } from "./realm-icons.ts";
import type {
	AddMarketplaceParams,
	AppCatalogItem,
	CatalogBanner,
	CatalogEntry,
	PluginCatalogDetail,
	PluginCatalogSource,
} from "./types.ts";

/** Which slice of the plugin catalog a section instance browses. An "app" is a
 *  plugin that bundles a Companion runnable (a full-page UI surface); a "plugin"
 *  is everything else (tools/agents/channels/policies). "all" = the historical
 *  unsplit tab, which web still uses. */
export type AppsCatalogVariant = "apps" | "plugins" | "all" | "community";

/** True when a catalog entry is an "app". Prefers the explicit `type` discriminator
 *  the catalog now emits; falls back to the legacy "ships a Companion runnable"
 *  derivation for older wires that don't carry `type`.
 *  Exported for unit tests (the detail-panel helpers below run only inside the
 *  Dialog-portaled preview, which `renderToStaticMarkup` cannot emit). */
export function isCompanionApp(item: AppCatalogItem): boolean {
	if (item.entry.type) {
		return item.entry.type === "app";
	}
	return item.entry.kinds.includes("companion");
}

/** True when a listing was discovered from a public GitHub topic rather than
 *  published to a first-party catalog — i.e. nobody at Ryu reviewed it.
 *
 *  Keys on the snake_case `origin` the Core projector stamps (see
 *  `plugin_marketplace_item_to_entry`); `reviewed === false` is accepted as a
 *  secondary signal so a source that stamps only the trust flag still gets the
 *  notice. Absent/null ⇒ first-party: deliberately fail-safe in that direction so
 *  an older wire never gains a scary label, which makes the notice opt-in from the
 *  producer. Exported for unit tests. */
export function isCommunityEntry(item: AppCatalogItem): boolean {
	return item.entry.origin === "community" || item.entry.reviewed === false;
}

const VARIANT_COPY: Record<
	AppsCatalogVariant,
	{ noun: string; nounPlural: string; searchPlaceholder: string }
> = {
	apps: {
		noun: "app",
		nounPlural: "apps",
		searchPlaceholder: "Search apps…",
	},
	plugins: {
		noun: "plugin",
		nounPlural: "plugins",
		searchPlaceholder: "Search plugins…",
	},
	all: {
		noun: "plugin",
		nounPlural: "plugins",
		searchPlaceholder: "Search plugins…",
	},
	community: {
		noun: "listing",
		nounPlural: "community listings",
		searchPlaceholder: "Search community apps and plugins…",
	},
};

/**
 * Plugins catalog Store section, shared by desktop and web. Browses the active
 * catalog source (Ryu Marketplace by default, or integrations.sh) joined with
 * live lifecycle records, and drives install → enable → disable for signed
 * plugins. Integration descriptors are browse-only with an outbound link.
 *
 * Desktop mounts it twice — variant "apps" (companion-UI apps) and "plugins"
 * (everything else) — while web keeps the unsplit "all" default. A third mount,
 * variant "community", browses GitHub topic-discovered third-party listings; it
 * is a SEPARATE fetch (Core keeps unreviewed listings out of the first-party
 * catalog) and always renders the "not reviewed by Ryu" notice.
 *
 * Desktop injects its real Core-node catalog hook + install layer through the
 * {@link CatalogHost}; web injects a federated adapter with `install: null`, so
 * the install/enable/source touchpoints collapse to an "Open in Ryu" affordance.
 */
export default function AppsCatalogSection({
	initialQuery = "",
	variant = "all",
}: {
	/** Seed the search box (e.g. carried over from the store-wide search). */
	initialQuery?: string;
	/** Catalog slice: companion "apps", non-companion "plugins", "all", or
	 *  "community" (unreviewed GitHub topic-discovered listings — a separate
	 *  fetch, always rendered with the trust notice). */
	variant?: AppsCatalogVariant;
} = {}) {
	const host = useCatalogHost();
	const {
		items,
		loading,
		loadingMore,
		error,
		fetchNextPage,
		hasNextPage,
		query,
		setQuery,
		selectedId,
		select,
		selectedItem,
		detail,
		detailLoading,
		detailError,
		install,
		installing,
		setEnabled,
		lifecyclePending,
		installFromUrl,
		sources,
		activeSource,
		selectSource,
		selectingSource,
		addMarketplace,
		addingMarketplace,
	} = host.useAppsCatalog(
		initialQuery,
		variant === "community" ? { origin: "community" } : undefined
	);

	// The apps/plugins split is presentational: one shared catalog fetch, filtered
	// per variant. Integration descriptors (integrations.sh) stay on the plugins side.
	//
	// Community is NOT part of that split — it is a separate FETCH (see the
	// `origin` option above), because unreviewed topic-discovered listings are
	// deliberately absent from the first-party pages. The extra `isCommunityEntry`
	// guards below are belt-and-braces: if a community row ever did leak into a
	// first-party page, it must not render there without its trust notice.
	const visibleItems =
		variant === "community"
			? items.filter(isCommunityEntry)
			: items.filter((it) => {
					if (isCommunityEntry(it)) {
						return false;
					}
					if (variant === "all") {
						return true;
					}
					return variant === "apps" ? isCompanionApp(it) : !isCompanionApp(it);
				});
	const copy = VARIANT_COPY[variant];

	// Per-card lifecycle without a per-id hook: the hook's install()/setEnabled()
	// act on the SELECTED item, so a card action selects its item and defers the
	// call until the selection lands (non-racy — the effect fires only once
	// selectedId matches). Install + Disable run inline; Enable routes to the
	// preview so its grant-confirmation dialog is never bypassed.
	const [pending, setPending] = useState<{
		id: string;
		action: "install" | "disable";
	} | null>(null);

	useEffect(() => {
		if (!pending || selectedId !== pending.id) {
			return;
		}
		const run =
			pending.action === "install" ? install : () => setEnabled(false);
		run().catch(() => {
			// Errors surface through the hook's error state in the detail panel.
		});
		setPending(null);
	}, [pending, selectedId, install, setEnabled]);

	const cardInstall = (id: string) => {
		setPending({ id, action: "install" });
		select(id);
	};
	const cardDisable = (id: string) => {
		setPending({ id, action: "disable" });
		select(id);
	};

	const filter = host.install
		? {
				label: "Source & install",
				icon: Link01Icon,
				panel: (
					<div className="flex flex-col gap-4 p-4">
						<PluginSourcePicker
							activeSource={activeSource}
							addingMarketplace={addingMarketplace}
							addMarketplace={addMarketplace}
							selectingSource={selectingSource}
							selectSource={selectSource}
							sources={sources}
						/>
						<InstallFromUrl install={installFromUrl} />
					</div>
				),
			}
		: undefined;

	return (
		<StoreCatalogLayout
			detail={
				<AppDetailPanel
					detail={detail}
					detailError={detailError}
					detailLoading={detailLoading}
					error={error}
					install={install}
					installing={installing}
					installLayer={host.install}
					item={selectedItem}
					lifecyclePending={lifecyclePending}
					noun={copy.noun}
					renderAffordance={host.renderAffordance}
					selectedId={selectedId}
					setEnabled={setEnabled}
				/>
			}
			detailTitle={selectedItem?.entry.name ?? copy.noun}
			filter={filter}
			hasSelection={selectedItem != null}
			list={
				<AppList
					canInstall={host.install != null}
					error={error}
					fallbackIcon={REALM_ICONS[variant === "plugins" ? "plugins" : "apps"]}
					fetchNextPage={fetchNextPage}
					hasNextPage={hasNextPage}
					items={visibleItems}
					loading={loading}
					loadingMore={loadingMore}
					notice={
						variant === "community" ? (
							<CommunityTrustNotice tone="banner" />
						) : null
					}
					nounPlural={copy.nounPlural}
					onDisable={cardDisable}
					onInstall={cardInstall}
					onSelect={select}
					pendingId={pending?.id ?? null}
					selectedId={selectedId}
				/>
			}
			onCloseDetail={() => select("")}
			search={{
				value: query,
				onChange: setQuery,
				placeholder:
					activeSource === "integrations-sh"
						? "Search integrations (MCP, OpenAPI, GraphQL, CLI)…"
						: copy.searchPlaceholder,
			}}
		/>
	);
}

/**
 * Source dropdown (Ryu Marketplace + any custom Claude plugin marketplaces) plus
 * an "Add marketplace" popover. A marketplace is just a repo/URL pointing at a
 * `.claude-plugin/marketplace.json`.
 */
function PluginSourcePicker({
	sources,
	activeSource,
	selectSource,
	selectingSource,
	addMarketplace,
	addingMarketplace,
}: {
	sources: PluginCatalogSource[];
	activeSource: string;
	selectSource: (id: string) => void;
	selectingSource: boolean;
	addMarketplace: (params: AddMarketplaceParams) => Promise<void>;
	addingMarketplace: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [repo, setRepo] = useState("");
	const [name, setName] = useState("");
	const [addError, setAddError] = useState<string | null>(null);

	const sourceItems = sources.map((s) => ({
		value: s.id,
		label: s.displayName,
	}));

	const submit = async () => {
		const trimmedRepo = repo.trim();
		if (!trimmedRepo) {
			setAddError("Enter a repo or marketplace.json URL");
			return;
		}
		const displayName = name.trim() || trimmedRepo;
		// Derive a stable, safe id from the display name / repo.
		const id = `mp-${displayName
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")}`;
		setAddError(null);
		try {
			await addMarketplace({ id, displayName, baseUrl: trimmedRepo });
			setRepo("");
			setName("");
			setOpen(false);
		} catch (e) {
			setAddError(e instanceof Error ? e.message : "Failed to add marketplace");
		}
	};

	return (
		<div className="flex flex-col gap-1.5">
			<span className="font-medium text-muted-foreground text-xs">
				Catalog source
			</span>
			{sources.length > 1 && (
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
					<SelectTrigger className="h-8 w-full text-sm" size="sm">
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
			)}
			<Popover onOpenChange={setOpen} open={open}>
				<TooltipProvider delay={0}>
					<Tooltip>
						<TooltipTrigger
							render={
								<PopoverTrigger className="inline-flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground">
									<HugeiconsIcon className="size-4" icon={Add01Icon} />
									Add marketplace
								</PopoverTrigger>
							}
						/>
						<TooltipContent>Add a Claude plugin marketplace</TooltipContent>
					</Tooltip>
				</TooltipProvider>
				<PopoverContent className="w-80">
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1">
							<Label htmlFor="plugin-mp-repo">
								Repo or marketplace.json URL
							</Label>
							<Input
								id="plugin-mp-repo"
								onChange={(e) => setRepo(e.target.value)}
								placeholder="owner/repo or https://…/marketplace.json"
								value={repo}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Label htmlFor="plugin-mp-name">Display name (optional)</Label>
							<Input
								id="plugin-mp-name"
								onChange={(e) => setName(e.target.value)}
								placeholder="My Marketplace"
								value={name}
							/>
						</div>
						{addError && <p className="text-destructive text-xs">{addError}</p>}
						<Button
							disabled={addingMarketplace}
							onClick={() => {
								submit().catch(() => undefined);
							}}
							size="sm"
						>
							{addingMarketplace ? (
								<Spinner className="size-4" />
							) : (
								<HugeiconsIcon className="size-4" icon={Add01Icon} />
							)}
							{addingMarketplace ? "Adding…" : "Add marketplace"}
						</Button>
					</div>
				</PopoverContent>
			</Popover>
		</div>
	);
}

function InstallFromUrl({
	install,
}: {
	install: (url: string) => Promise<void>;
}) {
	const [url, setUrl] = useState("");
	const [busy, setBusy] = useState(false);

	// Fire-and-forget: all errors are handled inside, so the returned promise
	// never rejects and callers can invoke it without awaiting or `void`.
	const submit = () => {
		const trimmed = url.trim();
		if (!trimmed || busy) {
			return;
		}
		setBusy(true);
		install(trimmed)
			.then(() => setUrl(""))
			.catch(() => {
				// Error surfaces via the hook's error state in the detail panel; the
				// input stays populated so the user can correct the URL.
			})
			.finally(() => setBusy(false));
	};

	return (
		<div className="flex items-center gap-2">
			<div className="relative flex-1">
				<HugeiconsIcon
					className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
					icon={Link01Icon}
				/>
				<Input
					className="pl-9"
					onChange={(e) => setUrl(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							submit();
						}
					}}
					placeholder="https://…/manifest.json"
					value={url}
				/>
			</div>
			<Button
				disabled={busy || url.trim().length === 0}
				onClick={submit}
				size="sm"
				variant="outline"
			>
				{busy ? <Spinner className="size-4" /> : "Install from URL"}
			</Button>
		</div>
	);
}

function AppList({
	items,
	loading,
	loadingMore,
	error,
	selectedId,
	onSelect,
	onInstall,
	onDisable,
	pendingId,
	canInstall,
	fetchNextPage,
	hasNextPage,
	nounPlural,
	fallbackIcon,
	notice,
}: {
	items: AppCatalogItem[];
	loading: boolean;
	loadingMore: boolean;
	error: string | null;
	selectedId: string | null;
	onSelect: (id: string) => void;
	onInstall: (id: string) => void;
	onDisable: (id: string) => void;
	pendingId: string | null;
	canInstall: boolean;
	fetchNextPage: () => void;
	hasNextPage: boolean;
	nounPlural: string;
	/** Realm glyph shown when an item has no icon of its own (apps→grid,
	 *  plugins→puzzle), sourced from the shared REALM_ICONS so it matches the tab. */
	fallbackIcon: IconSvgElement;
	/** Rendered above the grid in EVERY state (loading/error/empty/populated), so
	 *  the community trust disclosure is never hidden by a slow or empty fetch.
	 *  It lives here rather than in StoreCatalogLayout because that layout is
	 *  shared by Models/Skills/MCP/Agents and must not grow a notice slot. */
	notice?: ReactNode;
}) {
	const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

	if (loading && items.length === 0) {
		return (
			<div className="flex flex-col gap-3">
				{notice}
				<div className="flex items-center justify-center p-8 text-muted-foreground">
					<Spinner className="size-5" />
				</div>
			</div>
		);
	}
	if (error && items.length === 0) {
		return (
			<div className="flex flex-col gap-3">
				{notice}
				<div className="p-4 text-destructive text-sm">
					Couldn't load {nounPlural}: {error}
				</div>
			</div>
		);
	}
	if (items.length === 0) {
		return (
			<div className="flex flex-col gap-3">
				{notice}
				<Empty className="h-full p-6">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HugeiconsIcon icon={fallbackIcon} />
						</EmptyMedia>
						<EmptyTitle>No {nounPlural} found</EmptyTitle>
						<EmptyDescription>Try a different search.</EmptyDescription>
					</EmptyHeader>
				</Empty>
			</div>
		);
	}

	return (
		<div ref={setScrollEl}>
			{notice ? <div className="mb-3">{notice}</div> : null}
			<StoreCardGrid>
				{items.map((it) => (
					<StoreCatalogCard
						action={
							<AppCardAction
								canInstall={canInstall}
								item={it}
								onDisable={() => onDisable(it.entry.id)}
								onInstall={() => onInstall(it.entry.id)}
								onOpen={() => onSelect(it.entry.id)}
								pending={pendingId === it.entry.id}
							/>
						}
						description={it.entry.description}
						dither={it.entry.icon_dither}
						icon={<HugeiconsIcon className="size-5" icon={fallbackIcon} />}
						iconBackground={it.entry.icon_background ?? undefined}
						iconId={it.entry.icon}
						iconUrl={it.entry.icon_url}
						key={it.entry.id}
						name={it.entry.name}
						onClick={() => onSelect(it.entry.id)}
						seedId={it.entry.id}
						selected={it.entry.id === selectedId}
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

/** Card action for an app: Install (inline), Enabled↔Disable morph (Disable
 *  inline), or Disabled→Enable which opens the preview so its grant dialog runs.
 *  Descriptor-only rows + read-only surfaces just open the preview. */
function AppCardAction({
	item,
	canInstall,
	pending,
	onInstall,
	onDisable,
	onOpen,
}: {
	item: AppCatalogItem;
	canInstall: boolean;
	pending: boolean;
	onInstall: () => void;
	onDisable: () => void;
	onOpen: () => void;
}) {
	if (item.entry.descriptor_only || !canInstall) {
		return (
			<Button onClick={onOpen} size="sm" variant="outline">
				Details
			</Button>
		);
	}
	return (
		<StoreItemAction
			busy={pending}
			enabled={item.enabled}
			installed={item.installed}
			onDisable={onDisable}
			onEnable={onOpen}
			onInstall={onInstall}
		/>
	);
}

/** Import an integrations.sh API entry (REST `openapi` or `graphql`) as
 *  gateway-governed `http` tools via the Core import endpoints. Core resolves +
 *  parses server-side and installs a disabled plugin (one tool per operation for
 *  REST, one query tool for GraphQL); the user enables it from Tools to activate. */
function ImportToolsAction({
	node,
	endpoint,
	body,
}: {
	node: CatalogNode;
	endpoint: string;
	body: Record<string, unknown>;
}) {
	const [state, setState] = useState<"idle" | "busy" | "done" | "error">(
		"idle"
	);
	const [message, setMessage] = useState<string | null>(null);

	const run = () => {
		setState("busy");
		setMessage(null);
		const base = node.url.replace(/\/$/, "");
		fetch(`${base}${endpoint}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(node.token ? { Authorization: `Bearer ${node.token}` } : {}),
			},
			body: JSON.stringify(body),
		})
			.then(async (res) => {
				const json = (await res.json().catch(() => ({}))) as {
					dropped?: number;
					error?: string;
					success?: boolean;
					tools?: number;
				};
				if (res.ok && json.success) {
					const dropped = json.dropped
						? ` (${json.dropped} more not imported)`
						: "";
					setMessage(
						`Installed ${json.tools ?? 0} tool${json.tools === 1 ? "" : "s"}${dropped}. Enable it from Tools to use them.`
					);
					setState("done");
				} else {
					setMessage(json.error ?? `HTTP ${res.status}`);
					setState("error");
				}
			})
			.catch((err: unknown) => {
				setMessage(err instanceof Error ? err.message : String(err));
				setState("error");
			});
	};

	if (state === "done") {
		return <p className="text-muted-foreground text-sm">{message}</p>;
	}
	return (
		<div className="flex flex-col gap-1">
			<Button disabled={state === "busy"} onClick={run} size="sm">
				<HugeiconsIcon className="size-4" icon={Download01Icon} />
				{state === "busy" ? "Installing…" : "Install as tools"}
			</Button>
			{state === "error" && message ? (
				<p className="text-destructive text-xs">{message}</p>
			) : null}
		</div>
	);
}

/** The Install / Enable / Disable button cluster plus inline action error.
 *  Enable is gated behind a grant-confirmation dialog because enable is where
 *  the Gateway validates (and may deny) the app's declared grants. On a
 *  read-only surface (installLayer === null) this renders the host's affordance
 *  (Open in Ryu) instead of the lifecycle buttons. */
function AppActions({
	item,
	install,
	installing,
	setEnabled,
	lifecyclePending,
	error,
	installLayer,
	renderAffordance,
}: {
	item: AppCatalogItem;
	install: () => Promise<void>;
	installing: boolean;
	setEnabled: (enabled: boolean) => Promise<void>;
	lifecyclePending: boolean;
	error: string | null;
	installLayer: CatalogInstall | null;
	renderAffordance: CatalogHost["renderAffordance"];
}) {
	const host = useCatalogHost();
	const node = host.useActiveNode();
	const [confirmOpen, setConfirmOpen] = useState(false);
	const { entry, grants, installed, enabled } = item;

	// Rejections are captured into the hook's `error` state (rendered below), so
	// these fire-and-forget handlers swallow them to avoid a floating promise.
	const noop = () => {
		// intentionally empty: error is surfaced via the hook
	};
	const runDisable = () => {
		setEnabled(false).catch(noop);
	};
	const runInstall = () => {
		install().catch(noop);
	};
	const confirmEnable = () => {
		setConfirmOpen(false);
		setEnabled(true).catch(noop);
	};

	let action: ReactNode;
	if (entry.descriptor_only) {
		// integrations.sh ships only a docs link, never a runnable config. For an
		// MCP directory entry we can still reach a real one-click install: hand off
		// to the in-app MCP catalog (backed by the official MCP registry),
		// pre-filtered by name, which resolves + installs the server. Desktop only
		// (an install layer + a navigate seam present); web keeps the docs link.
		if (entry.integration_kind === "mcp" && installLayer && host.navigate) {
			const openMcpCatalog = () =>
				host.navigate?.(`/store/mcp/q/${encodeURIComponent(entry.name)}`);
			action = (
				<Button onClick={openMcpCatalog} size="sm">
					<HugeiconsIcon className="size-4" icon={Download01Icon} />
					Find in MCP catalog
				</Button>
			);
		} else if (entry.integration_kind === "openapi" && installLayer) {
			// A REST API directory entry: import its OpenAPI spec as gateway-governed
			// `http` tools (resolved server-side via apis.guru from the entry id).
			action = (
				<ImportToolsAction
					body={{ id: entry.id }}
					endpoint="/api/tools/import/openapi"
					node={node}
				/>
			);
		} else if (
			entry.integration_kind === "graphql" &&
			installLayer &&
			entry.integration_url
		) {
			// A GraphQL endpoint: import it as a single gateway-governed query tool.
			action = (
				<ImportToolsAction
					body={{ name: entry.name, url: entry.integration_url }}
					endpoint="/api/tools/import/graphql"
					node={node}
				/>
			);
		} else {
			const href = safeHttpUrl(entry.integration_url);
			action = href ? (
				<Button
					render={<a href={href} rel="noopener noreferrer" target="_blank" />}
					size="sm"
					variant="outline"
				>
					<HugeiconsIcon className="size-4" icon={Link01Icon} />
					View setup docs
				</Button>
			) : (
				<p className="text-muted-foreground text-sm">
					Browse-only descriptor — no install URL on file.
				</p>
			);
		}
	} else if (!installLayer) {
		// Read-only surface: no local install; deep-link into the Ryu app instead.
		action =
			renderAffordance?.({
				id: entry.id,
				name: entry.name,
				realm: "app",
			}) ?? null;
	} else if (!installed) {
		const InstallButton = installLayer.InstallButton;
		action = (
			<InstallButton
				installing={installing}
				onClick={runInstall}
				progress={{ kinds: ["tool", "other"], name: entry.name }}
			>
				<HugeiconsIcon className="size-4" icon={Download01Icon} />
				Install
			</InstallButton>
		);
	} else if (enabled) {
		action = (
			<Button
				disabled={lifecyclePending}
				onClick={runDisable}
				size="sm"
				variant="outline"
			>
				{lifecyclePending ? <Spinner className="size-4" /> : null}
				Disable
			</Button>
		);
	} else {
		action = (
			<Button
				disabled={lifecyclePending}
				onClick={() => setConfirmOpen(true)}
				size="sm"
			>
				{lifecyclePending ? <Spinner className="size-4" /> : null}
				Enable
			</Button>
		);
	}

	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-2">{action}</div>
			{error && <p className="text-destructive text-sm">{error}</p>}

			{/* Enable confirmation: list grants before enabling. Install-only. */}
			{installLayer ? (
				<AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Enable {entry.name}?</AlertDialogTitle>
							<AlertDialogDescription>
								{grants.length === 0
									? "This plugin requests no special permissions."
									: "Enabling grants this plugin the following permissions. They are validated by the Gateway."}
							</AlertDialogDescription>
						</AlertDialogHeader>
						{grants.length > 0 && <GrantList grants={grants} />}
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction onClick={confirmEnable}>
								Allow
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			) : null}
		</div>
	);
}

/** A list of permission grants in plain English (label + one-line description),
 *  so a non-technical user understands what they're approving. */
function GrantList({ grants }: { grants: string[] }) {
	return (
		<ul className="flex flex-col gap-1.5">
			{grants.map((g) => {
				const description = grantDescription(g);
				return (
					<li className="rounded-md border px-3 py-1.5" key={g}>
						<div className="font-medium text-sm">{grantLabel(g)}</div>
						{description ? (
							<div className="text-muted-foreground text-xs">{description}</div>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

function AppDetailPanel({
	selectedId,
	item,
	detail,
	detailLoading,
	detailError,
	install,
	installing,
	setEnabled,
	lifecyclePending,
	error,
	installLayer,
	noun,
	renderAffordance,
}: {
	selectedId: string | null;
	item: AppCatalogItem | null;
	detail: PluginCatalogDetail | null;
	detailLoading: boolean;
	detailError: string | null;
	install: () => Promise<void>;
	installing: boolean;
	setEnabled: (enabled: boolean) => Promise<void>;
	lifecyclePending: boolean;
	error: string | null;
	installLayer: CatalogInstall | null;
	noun: string;
	renderAffordance: CatalogHost["renderAffordance"];
}) {
	if (!(selectedId && item)) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={GridIcon} />
					</EmptyMedia>
					<EmptyTitle>No {noun} selected</EmptyTitle>
					<EmptyDescription>
						Pick a {noun} on the left to read what it does, review its
						permissions, and install it.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	const { entry, grants, installed, enabled } = item;
	const integrationUrl =
		entry.integration_url ?? detail?.url ?? detail?.descriptor?.url ?? null;
	const showHero =
		!entry.descriptor_only &&
		Boolean(entry.banner || entry.icon_url || entry.icon_background);

	return (
		<div className="flex flex-col gap-6 p-4">
			{showHero ? <AppHero entry={entry} /> : null}
			<header className="flex flex-col gap-3">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<h2 className="truncate font-semibold text-xl">{entry.name}</h2>
						<p className="text-muted-foreground text-sm">
							{entry.descriptor_only
								? (entry.integration_kind?.toUpperCase() ?? "Integration")
								: `v${entry.version}`}
						</p>
					</div>
					{entry.descriptor_only ? (
						<Badge className="shrink-0" variant="outline">
							Descriptor
						</Badge>
					) : (
						<AppStatusBadge enabled={enabled} installed={installed} />
					)}
				</div>
				{entry.descriptor_only && entry.description ? (
					<p className="text-muted-foreground text-sm">{entry.description}</p>
				) : null}
				<div className="flex flex-wrap items-center gap-1">
					{entry.built_in && (
						<Badge className="text-xs" variant="outline">
							Built-in
						</Badge>
					)}
					{isCommunityEntry(item) ? (
						<Badge
							className="border-amber-500/40 text-amber-600 text-xs"
							variant="outline"
						>
							Community
						</Badge>
					) : null}
					{entry.kinds.map((k) => (
						<Badge className="text-xs" key={k} variant="secondary">
							{k.toUpperCase()}
						</Badge>
					))}
					{entry.tags.map((t) => (
						<Badge className="font-normal text-xs" key={t} variant="outline">
							{t}
						</Badge>
					))}
				</div>
			</header>

			{/* Load-bearing placement: unavoidable in the reading path before any
			    install action, in both the side-pane and the dialog preview. */}
			{isCommunityEntry(item) ? (
				<CommunityTrustNotice
					tone="inline"
					topic={detail?.discoveredFrom?.topic}
				/>
			) : null}

			<AppActions
				error={error}
				install={install}
				installing={installing}
				installLayer={installLayer}
				item={item}
				lifecyclePending={lifecyclePending}
				renderAffordance={renderAffordance}
				setEnabled={setEnabled}
			/>

			{entry.descriptor_only ? (
				<DescriptorDetail
					detail={detail}
					detailError={detailError}
					detailLoading={detailLoading}
					integrationUrl={integrationUrl}
				/>
			) : (
				<>
					{entry.description ? (
						<section className="flex flex-col gap-2">
							<h3 className="flex items-center gap-1.5 font-medium text-sm">
								<HugeiconsIcon
									className="size-4 text-muted-foreground"
									icon={InformationCircleIcon}
								/>
								About
							</h3>
							<p className="text-muted-foreground text-sm leading-relaxed">
								{entry.description}
							</p>
						</section>
					) : null}

					<AppIncludedSection
						runnables={detail?.runnables ?? entry.runnables}
					/>

					<RequiredAppsSection requires={entry.requires} />

					<section className="flex flex-col gap-2">
						<h3 className="flex items-center gap-1.5 font-medium text-sm">
							<HugeiconsIcon
								className="size-4 text-muted-foreground"
								icon={SquareLock01Icon}
							/>
							Permissions
						</h3>
						{grants.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								This plugin requests no special permissions.
							</p>
						) : (
							<GrantList grants={grants} />
						)}
					</section>

					<AppInformationSection detail={detail} entry={entry} />
				</>
			)}
		</div>
	);
}

/** Presentational icon per bundled-runnable kind. Falls back to a package glyph
 *  for unknown kinds so an unrecognized runnable still renders a row. */
const RUNNABLE_KIND_ICONS: Record<string, typeof PackageIcon> = {
	agent: Robot01Icon,
	companion: LayoutGridIcon,
	mcp: ServerStack01Icon,
	skill: BookOpen01Icon,
	tool: Wrench01Icon,
	workflow: WorkflowSquare01Icon,
};

/** Short human label per runnable kind (falls back to a capitalized kind). */
const RUNNABLE_KIND_LABELS: Record<string, string> = {
	agent: "Agent",
	companion: "Companion",
	mcp: "MCP",
	skill: "Skill",
	tool: "Tool",
	workflow: "Workflow",
};

function runnableKindIcon(kind: string): typeof PackageIcon {
	return RUNNABLE_KIND_ICONS[kind] ?? PackageIcon;
}

/** Exported for unit tests — see the note on {@link isCompanionApp}. */
export function runnableKindLabel(kind: string): string {
	return (
		RUNNABLE_KIND_LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1)
	);
}

/** "What's included": a read-only list of the bundled runnables a full app ships
 *  (desktop-only — `detail.runnables` is absent on the web read-only host, so the
 *  section renders nothing there). Informational rows, not functional toggles. */
function AppIncludedSection({
	runnables,
}: {
	runnables?: PluginCatalogDetail["runnables"];
}) {
	if (!runnables || runnables.length === 0) {
		return null;
	}
	return (
		<section className="flex flex-col gap-2">
			<h3 className="flex items-center gap-1.5 font-medium text-sm">
				<HugeiconsIcon
					className="size-4 text-muted-foreground"
					icon={PackageIcon}
				/>
				What&apos;s included
			</h3>
			<ul className="flex flex-col gap-1.5">
				{runnables.map((runnable) => (
					<li
						className="flex items-center gap-2.5 rounded-md border px-3 py-2"
						key={runnable.id}
					>
						<HugeiconsIcon
							className="size-4 shrink-0 text-muted-foreground"
							icon={runnableKindIcon(runnable.kind)}
						/>
						<span className="min-w-0 flex-1 truncate text-sm">
							{runnable.name ?? runnable.id}
						</span>
						<Badge className="shrink-0 text-xs" variant="secondary">
							{runnableKindLabel(runnable.kind)}
						</Badge>
					</li>
				))}
			</ul>
		</section>
	);
}

/** Prettify a plugin id ("com.ryu.spaces" → "Spaces") for display.
 *  Exported for unit tests — see the note on {@link isCompanionApp}. */
export function prettyPluginId(id: string): string {
	const leaf = id.split(".").pop() ?? id;
	return leaf.charAt(0).toUpperCase() + leaf.slice(1);
}

/** The app's plugin dependencies (`requires`) — the apps that must be enabled for
 *  this one to run. Rendered before install so the dependency chain is clear:
 *  enabling this app auto-enables these, and uninstalling one of these later prompts
 *  the disable cascade. Absent/empty ⇒ nothing rendered (self-contained app). */
function RequiredAppsSection({
	requires,
}: {
	requires?: CatalogEntry["requires"];
}) {
	const apps = requires?.apps ?? [];
	if (apps.length === 0) {
		return null;
	}
	return (
		<section className="flex flex-col gap-2">
			<h3 className="flex items-center gap-1.5 font-medium text-sm">
				<HugeiconsIcon
					className="size-4 text-muted-foreground"
					icon={Link01Icon}
				/>
				Requires these apps
			</h3>
			<ul className="flex flex-col gap-1.5">
				{apps.map((dep) => (
					<li
						className="flex items-center gap-2.5 rounded-md border px-3 py-2"
						key={dep.id}
					>
						<HugeiconsIcon
							className="size-4 shrink-0 text-muted-foreground"
							icon={Link01Icon}
						/>
						<span className="min-w-0 flex-1 truncate text-sm">
							{prettyPluginId(dep.id)}
						</span>
						{dep.min_version ? (
							<span className="shrink-0 truncate text-muted-foreground text-xs">
								≥ {dep.min_version}
							</span>
						) : null}
						<span className="shrink-0 truncate font-mono text-muted-foreground text-xs">
							{dep.id}
						</span>
					</li>
				))}
			</ul>
			<p className="text-muted-foreground text-xs">
				Enabling this app turns these on automatically.
			</p>
		</section>
	);
}

/** Return `u` only when it parses as an http(s) URL, else null — a render-layer
 *  guard so an untrusted publisher's `javascript:`/`data:` link never reaches an
 *  `<a href>` even if a backend source forgot to allowlist the scheme.
 *  Exported for unit tests — see the note on {@link isCompanionApp}. */
export function safeHttpUrl(u?: string | null): string | null {
	if (!u) {
		return null;
	}
	try {
		const parsed = new URL(u);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") {
			return parsed.toString();
		}
		return null;
	} catch {
		return null;
	}
}

/** One label/value row in the Information table. Renders the value as a safe
 *  external link only when `href` is a valid http(s) URL; otherwise plain text. */
function InfoRow({
	href,
	label,
	value,
}: {
	href?: string | null;
	label: string;
	value: string;
}) {
	const safeHref = safeHttpUrl(href);
	return (
		<div className="flex items-start justify-between gap-3 py-2 text-sm">
			<span className="shrink-0 text-muted-foreground">{label}</span>
			{safeHref ? (
				<a
					className="min-w-0 truncate text-right text-foreground hover:underline"
					href={safeHref}
					rel="noopener noreferrer"
					target="_blank"
				>
					{value}
				</a>
			) : (
				<span className="min-w-0 truncate text-right text-foreground">
					{value}
				</span>
			)}
		</div>
	);
}

/** "Information": a compact key/value table. Rows come from `detail` (desktop)
 *  falling back to `entry` (present on every surface), so on the web host — where
 *  `detail` is null — it still shows Developer/Category/Version from the entry and
 *  simply omits the detail-only rows (homepage/license/privacy/terms). */
function AppInformationSection({
	detail,
	entry,
}: {
	detail: PluginCatalogDetail | null;
	entry: CatalogEntry;
}) {
	const developer = detail?.developer ?? entry.developer ?? null;
	const category = detail?.category ?? entry.category ?? null;
	const version = entry.descriptor_only ? null : (entry.version ?? null);
	const license = detail?.license ?? null;
	const website = detail?.website ?? null;
	const privacy = detail?.privacyPolicyUrl ?? null;
	const terms = detail?.termsOfServiceUrl ?? null;

	const hasRows = Boolean(
		developer || category || version || license || website || privacy || terms
	);
	if (!hasRows) {
		return null;
	}

	return (
		<section className="flex flex-col gap-2">
			<h3 className="flex items-center gap-1.5 font-medium text-sm">
				<HugeiconsIcon
					className="size-4 text-muted-foreground"
					icon={Menu01Icon}
				/>
				Information
			</h3>
			<div className="flex flex-col divide-y rounded-lg border px-3">
				{developer ? <InfoRow label="Developer" value={developer} /> : null}
				{category ? <InfoRow label="Category" value={category} /> : null}
				{version ? <InfoRow label="Version" value={version} /> : null}
				{license ? <InfoRow label="License" value={license} /> : null}
				{website ? (
					<InfoRow href={website} label="Website" value={website} />
				) : null}
				{privacy ? (
					<InfoRow href={privacy} label="Privacy Policy" value={privacy} />
				) : null}
				{terms ? (
					<InfoRow href={terms} label="Terms of Service" value={terms} />
				) : null}
			</div>
		</section>
	);
}

/** A default gradient used when an entry carries no banner colors / accent. */
const DEFAULT_HERO_GRADIENT = "linear-gradient(135deg, #6366f1, #4338ca)";

/** Self-contained hero background: a smooth gradient from `banner.colors` (or a
 *  solid/gradient fallback), with an optional ordered-noise "dither" overlay
 *  rendered by an inline SVG `feTurbulence` filter. No external dependency;
 *  pure presentational, safe in a plain browser (web) and desktop alike. */
function DitherBanner({
	banner,
	fallback,
}: {
	banner?: CatalogBanner | null;
	fallback?: string | null;
}) {
	const filterId = useId();
	const colors = banner?.colors?.length ? banner.colors : null;
	const gradient = colors
		? `linear-gradient(135deg, ${colors.join(", ")})`
		: (fallback ?? DEFAULT_HERO_GRADIENT);
	const isDither = banner?.style === "dither";

	return (
		<div
			aria-hidden="true"
			className="absolute inset-0"
			style={{ background: gradient }}
		>
			{isDither ? (
				<svg
					className="absolute inset-0 size-full opacity-30 mix-blend-overlay"
					preserveAspectRatio="none"
				>
					<title>Dither texture</title>
					<filter id={filterId}>
						<feTurbulence
							baseFrequency="0.9"
							numOctaves={2}
							seed={banner?.seed ?? 0}
							type="fractalNoise"
						/>
						<feColorMatrix type="saturate" values="0" />
					</filter>
					<rect filter={`url(#${filterId})`} height="100%" width="100%" />
				</svg>
			) : null}
		</div>
	);
}

/** The app detail hero: a banner background overlaid with the icon square, the
 *  name, and the tagline. Rendered only for full (non-descriptor) apps that
 *  carry banner/icon/accent presentation metadata. */
function AppHero({ entry }: { entry: CatalogEntry }) {
	const fallback = entry.icon_background ?? entry.accent_color ?? null;
	// Raster logo for the hero: `icon_url` (any https host), or a GitHub-image URL
	// pasted into the `icon` field (mirrors the card's {@link resolveCardIcon} rule).
	const { iconUrl: previewIconUrl } = resolveCardIcon({
		icon: entry.icon,
		iconUrl: entry.icon_url,
	});
	return (
		<div className="relative h-32 overflow-hidden rounded-t-xl rounded-b-lg">
			<DitherBanner banner={entry.banner} fallback={fallback} />
			<div className="absolute inset-0 flex items-end gap-3 p-3">
				<span
					className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-background/20 text-white shadow-sm ring-1 ring-white/20"
					style={
						entry.icon_background
							? { background: entry.icon_background }
							: undefined
					}
				>
					{previewIconUrl ? (
						<img
							alt=""
							className="size-full object-cover"
							loading="lazy"
							src={previewIconUrl}
						/>
					) : (
						<HugeiconsIcon className="size-6" icon={GridIcon} />
					)}
				</span>
				<div className="min-w-0 pb-1">
					<div className="truncate font-semibold text-base text-white drop-shadow">
						{entry.name}
					</div>
					{entry.tagline ? (
						<div className="truncate text-white/80 text-xs drop-shadow">
							{entry.tagline}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}

function DescriptorDetail({
	detail,
	detailLoading,
	detailError,
	integrationUrl,
}: {
	detail: PluginCatalogDetail | null;
	detailLoading: boolean;
	detailError: string | null;
	integrationUrl: string | null;
}) {
	return (
		<section className="flex flex-col gap-3">
			<h3 className="font-medium text-sm">Integration details</h3>
			{detailLoading ? <Spinner className="size-4" /> : null}
			{detailError ? (
				<p className="text-destructive text-sm">{detailError}</p>
			) : null}
			{integrationUrl ? (
				<p className="break-all font-mono text-muted-foreground text-xs">
					{integrationUrl}
				</p>
			) : null}
			{detail?.domain ? (
				<p className="text-muted-foreground text-sm">
					Domain: <span className="text-foreground">{detail.domain}</span>
				</p>
			) : null}
			{detail?.feeds && detail.feeds.length > 0 ? (
				<div className="flex flex-wrap gap-1">
					{detail.feeds.map((feed) => (
						<Badge className="text-xs" key={feed} variant="outline">
							{feed}
						</Badge>
					))}
				</div>
			) : null}
			<p className="text-muted-foreground text-sm">
				Descriptors are reference entries from integrations.sh — open the link
				to configure MCP, OpenAPI, or other surfaces in your agent stack.
			</p>
		</section>
	);
}

/** Status pill in the detail header: Enabled > Installed > nothing. */
function AppStatusBadge({
	enabled,
	installed,
}: {
	enabled: boolean;
	installed: boolean;
}) {
	if (enabled) {
		return (
			<Badge className="shrink-0 gap-1" variant="secondary">
				<HugeiconsIcon
					className="size-3.5 text-success"
					icon={CheckmarkCircle02Icon}
				/>
				Enabled
			</Badge>
		);
	}
	if (installed) {
		return (
			<Badge className="shrink-0" variant="outline">
				Installed
			</Badge>
		);
	}
	return null;
}
