import {
	Alert01Icon,
	CheckmarkCircle02Icon,
	Download01Icon,
	Link01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	contributionSourceRequest,
	renderContributionActionHttp,
	type StoreCatalogItem,
	storeDetailObject,
	storeGraphFromResponse,
	type ViewAction,
} from "@ryu/app-host/views";
import { InstallProgressButton } from "@ryu/blocks/desktop/install-button.tsx";
import {
	ListingAsideCard,
	ListingDetailShell,
	ListingHero,
	ListingSection,
	ListingStatStrip,
} from "@ryu/marketplace/catalog/detail/listing-detail-shell";
import { safeHttpUrl } from "@ryu/marketplace/catalog/safe-url";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { z } from "zod";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { apiUrl, requestHeaders, toTarget } from "@/src/lib/api/client.ts";
import { pluginStoreSpec } from "@/src/lib/api/plugin-contribution-specs.ts";
import type { PluginStoreTab } from "@/src/lib/api/plugins.ts";
import { TabIcon } from "./ContributedStoreSection-tab-icon.tsx";
import StoreDetailGraph from "./StoreDetailGraph.tsx";

function InstalledPill() {
	return (
		<Badge variant="secondary">
			<HugeiconsIcon className="size-3" icon={CheckmarkCircle02Icon} />
			Added
		</Badge>
	);
}

export function DetailPanel({
	tab,
	item,
	busy,
	installed,
	error,
	onInstall,
	runAction,
}: {
	busy: boolean;
	error: string | null;
	installed: boolean;
	item: StoreCatalogItem | null;
	onInstall: () => void;
	runAction: (action: ViewAction, item: StoreCatalogItem) => void;
	tab: PluginStoreTab;
}) {
	if (!item) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<TabIcon icon={tab.icon} />
					</EmptyMedia>
					<EmptyTitle>Nothing selected</EmptyTitle>
					<EmptyDescription>
						Pick an item on the left to review it before installing.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}
	const installSpec = pluginStoreSpec(tab)?.install;
	const installable = installSpec != null;
	const sourceHref = safeHttpUrl(item.sourceUrl);
	return (
		<ListingDetailShell
			actions={
				<>
					{installSpec ? (
						<InstallAction
							busy={busy}
							installed={installed}
							label={installSpec.label}
							onInstall={onInstall}
						/>
					) : null}
					{/* Declared per-item extras (Preview, Duplicate, …) fire against the
					    SELECTED row, so they live here rather than on the card — a
					    card-level slot would have to pick a row before the user did. */}
					{pluginStoreSpec(tab)?.itemActions?.map((action) => (
						<Button
							key={action.id}
							onClick={() => runAction(action, item)}
							size="sm"
							variant={action.style === "danger" ? "destructive" : "outline"}
						>
							{action.label}
						</Button>
					))}
					{sourceHref ? (
						<Button
							render={
								<a
									href={sourceHref}
									rel="noopener noreferrer"
									target="_blank"
								/>
							}
							size="sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={Link01Icon} />
							Source
						</Button>
					) : null}
					{error ? (
						<span className="ml-auto flex items-center gap-1.5 text-sm text-status-destructive">
							<HugeiconsIcon className="size-4 shrink-0" icon={Alert01Icon} />
							{error}
						</span>
					) : null}
				</>
			}
			aside={
				item.tags.length > 0 ? (
					<ListingAsideCard title="Tags">
						<div className="flex flex-wrap gap-1">
							{item.tags.map((tag) => (
								<Badge key={tag} typography="normal" variant="outline">
									{tag}
								</Badge>
							))}
						</div>
					</ListingAsideCard>
				) : null
			}
			hero={
				<ListingHero
					badges={[
						item.badge ?? null,
						installable && installed ? "Added" : null,
					].filter((b): b is string => Boolean(b))}
					icon={<TabIcon className="size-8" icon={item.icon ?? tab.icon} />}
					name={item.title}
					tagline={item.description}
				/>
			}
			stats={
				<ListingStatStrip
					items={[
						{ label: "Catalog", value: tab.title },
						{
							label: "Status",
							value: installable
								? installed
									? "Added"
									: "Not added"
								: "Available",
						},
						{ label: "Tags", value: `${item.tags.length}` },
					]}
				/>
			}
		>
			<ListingSection title="About">
				<p className="text-muted-foreground text-sm leading-relaxed">
					{item.description || "No description provided."}
				</p>
			</ListingSection>
			<ContributedDetailGraph item={item} tab={tab} />
		</ListingDetailShell>
	);
}

/** The declared per-item detail picture (a graph today), for tabs whose spec
 *  carries `detail.graph`. Rendered as its own component rather than inline in
 *  {@link DetailPanel} because that function early-returns on `item === null`,
 *  so a hook called after it would change order between renders.
 *
 *  Renders nothing at all unless the tab DECLARES a graph — a contributed tab
 *  that says nothing about detail keeps exactly the panel it had before. */
function ContributedDetailGraph({
	tab,
	item,
}: {
	item: StoreCatalogItem;
	tab: PluginStoreTab;
}) {
	const node = useActiveNode();
	const spec = useMemo(() => pluginStoreSpec(tab), [tab]);
	const source = spec?.detail?.source;
	const sourceRequest =
		source?.http.method === "GET"
			? contributionSourceRequest(tab, {
					http: { method: "GET", path: source.http.path },
				})
			: null;
	const detail = useQuery({
		queryKey: [
			"store-tab-detail",
			tab.plugin,
			tab.id,
			item.id,
			node.url,
			node.token,
			sourceRequest?.path ?? "",
		],
		enabled: sourceRequest !== null,
		queryFn: async () => {
			if (!(source && sourceRequest)) {
				return null;
			}
			const rendered = renderContributionActionHttp(tab, source.http, {
				item: item.raw,
			});
			const target = toTarget(node);
			const resp = await fetch(apiUrl(target, rendered.path), {
				method: sourceRequest.method,
				headers: await requestHeaders(target),
			});
			if (!resp.ok) {
				throw new Error(`${rendered.path} failed: ${resp.status}`);
			}
			return z.json().parse(await resp.json());
		},
	});

	const graph = useMemo(() => {
		const graphSpec = spec?.detail?.graph;
		if (!graphSpec) {
			return null;
		}
		// No declared source means the row itself already carries the shape.
		const payload = source ? detail.data : item.raw;
		return storeGraphFromResponse(
			graphSpec,
			storeDetailObject(spec?.detail ?? {}, payload)
		);
	}, [spec, source, detail.data, item.raw]);

	if (!graph || graph.nodes.length === 0) {
		return null;
	}
	return (
		<ListingSection title={spec?.detail?.graph?.title ?? "Graph"}>
			<StoreDetailGraph edges={graph.edges} nodes={graph.nodes} />
		</ListingSection>
	);
}

/** Add affordance in the detail pane: a button until installed, then a
 *  non-interactive "Added" pill (a contributed catalog declares no uninstall, so
 *  surfacing one would be a promise the spec cannot keep). */
function InstallAction({
	installed,
	busy,
	label,
	onInstall,
}: {
	busy: boolean;
	installed: boolean;
	label?: string;
	onInstall: () => void;
}) {
	if (installed) {
		return <InstalledPill />;
	}
	return (
		<InstallProgressButton
			idleVariant="ghost"
			installing={busy}
			onClick={onInstall}
		>
			<HugeiconsIcon className="size-4" icon={Download01Icon} />
			{label ?? "Add"}
		</InstallProgressButton>
	);
}
