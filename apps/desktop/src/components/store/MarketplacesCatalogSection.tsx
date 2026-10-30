import { Settings01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	addCatalogSource,
	type CatalogKind,
	fetchCatalogSources,
	removeCatalogSource,
	reorderCatalogSource,
	selectCatalogSource,
} from "@/src/lib/api/catalog-sources.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { AddMarketplaceDialog } from "./MarketplacesCatalogSection-add-dialog.tsx";
import { MarketplaceSourceGroup } from "./MarketplacesCatalogSection-source-group.tsx";

const SOURCE_GROUPS: Array<{
	description: string;
	kind: CatalogKind;
	label: string;
}> = [
	{
		kind: "plugin",
		label: "Apps and plugins",
		description: "Companion apps and installable extensions.",
	},
	{
		kind: "skill",
		label: "Skills",
		description: "Agent Skills and GitHub marketplace skill entries.",
	},
	{
		kind: "mcp",
		label: "MCP servers",
		description: "Hosted MCP registries and registry mirrors.",
	},
	{
		kind: "model",
		label: "Models",
		description: "Model indexes and model hubs.",
	},
	{
		kind: "knowledge",
		label: "Knowledge",
		description: "Knowledge bundle sources.",
	},
	{
		kind: "agent",
		label: "Agent Templates",
		description: "Published Agent Templates and hosted catalogs.",
	},
];

const CUSTOM_MARKETPLACE_KINDS: CatalogKind[] = ["plugin", "skill"];

function sourceQueryKey(target: ApiTarget) {
	return ["catalog-sources", target.url] as const;
}

export default function MarketplacesCatalogSection() {
	const node = useActiveNode();
	const target: ApiTarget = {
		token: node.token,
		userJwt: node.userJwt ?? null,
		url: node.url,
	};
	const queryClient = useQueryClient();
	const sourcesQuery = useQuery({
		queryFn: () =>
			Promise.all(
				SOURCE_GROUPS.map(async ({ kind }) => fetchCatalogSources(target, kind))
			),
		queryKey: sourceQueryKey(target),
	});
	const [addOpen, setAddOpen] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);

	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: sourceQueryKey(target) });

	const sourcesByKind = new Map(
		(sourcesQuery.data ?? []).map((result) => [result.kind, result])
	);

	const runMutation = async (
		key: string,
		operation: () => Promise<void>,
		success: string
	): Promise<boolean> => {
		setBusy(key);
		try {
			await operation();
			await refresh();
			toast.success(success);
			return true;
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Marketplace action failed"
			);
			return false;
		} finally {
			setBusy(null);
		}
	};

	if (sourcesQuery.isLoading) {
		return <SkeletonRows rows={6} spacing="library" />;
	}

	if (sourcesQuery.error) {
		return (
			<div className="mx-auto flex max-w-2xl flex-col gap-3 px-4 py-8">
				<h2 className="font-medium text-lg">Could not load marketplaces</h2>
				<p className="text-muted-foreground text-sm">
					{sourcesQuery.error instanceof Error
						? sourcesQuery.error.message
						: "The active Core node did not return marketplace sources."}
				</p>
				<Button
					onClick={() => sourcesQuery.refetch()}
					size="sm"
					variant="outline"
				>
					Try again
				</Button>
			</div>
		);
	}

	return (
		<div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 pt-2 pb-8">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<div className="flex items-center gap-2">
						<HugeiconsIcon
							className="size-5 text-muted-foreground"
							icon={Settings01Icon}
						/>
						<h2 className="font-medium text-lg">Marketplaces</h2>
					</div>
					<p className="mt-1 max-w-2xl text-muted-foreground text-sm">
						One place to review every catalog source. Ryu-hosted registries stay
						managed; custom GitHub marketplaces can be added to Apps and plugins
						or Skills.
					</p>
				</div>
				<AddMarketplaceDialog
					busy={busy === "add"}
					kinds={CUSTOM_MARKETPLACE_KINDS}
					onAdd={async (input) => {
						const succeeded = await runMutation(
							"add",
							async () => {
								for (const kind of input.kinds) {
									await addCatalogSource(target, { ...input, kind });
								}
							},
							"Marketplace added"
						);
						if (!succeeded) {
							throw new Error("Marketplace could not be added.");
						}
						setAddOpen(false);
					}}
					onOpenChange={setAddOpen}
					open={addOpen}
				/>
			</div>

			<div className="rounded-lg border border-border bg-muted/20 p-4 text-sm">
				<p className="font-medium">
					Installed and available items stay in their own tabs.
				</p>
				<p className="mt-1 text-muted-foreground">
					Use the Store’s Installed switch in Apps, Plugins, Skills, MCP,
					Models, and Agents to move between what is installed and what can be
					added. This tab manages the sources behind those lists.
				</p>
			</div>

			<div className="flex flex-col gap-4">
				{SOURCE_GROUPS.map((group) => {
					const result = sourcesByKind.get(group.kind);
					return (
						<MarketplaceSourceGroup
							active={result?.active ?? ""}
							busy={busy}
							description={group.description}
							key={group.kind}
							kind={group.kind}
							label={group.label}
							onMove={(id, direction) =>
								runMutation(
									`${group.kind}:${id}:${direction}`,
									() => reorderCatalogSource(target, group.kind, id, direction),
									"Marketplace order updated"
								)
							}
							onRemove={(id) =>
								runMutation(
									`${group.kind}:${id}:remove`,
									() => removeCatalogSource(target, group.kind, id),
									"Marketplace removed"
								)
							}
							onSelect={(id) =>
								runMutation(
									`${group.kind}:${id}:select`,
									() => selectCatalogSource(target, group.kind, id),
									"Marketplace selected"
								)
							}
							sources={result?.sources ?? []}
						/>
					);
				})}
			</div>
		</div>
	);
}
