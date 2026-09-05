import {
	Add01Icon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	Delete01Icon,
	Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	addCatalogSource,
	type CatalogKind,
	type CatalogSource,
	fetchCatalogSources,
	removeCatalogSource,
	reorderCatalogSource,
	selectCatalogSource,
} from "@/src/lib/api/catalog-sources.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";

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
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
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

			<div className="rounded-lg border border-border/60 bg-muted/20 p-4 text-sm">
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

function MarketplaceSourceGroup({
	active,
	busy,
	description,
	kind,
	label,
	onMove,
	onRemove,
	onSelect,
	sources,
}: {
	active: string;
	busy: string | null;
	description: string;
	kind: CatalogKind;
	label: string;
	onMove: (id: string, direction: "down" | "up") => void;
	onRemove: (id: string) => void;
	onSelect: (id: string) => void;
	sources: CatalogSource[];
}) {
	return (
		<section className="rounded-xl border border-border/60 bg-card">
			<div className="border-border/60 border-b px-4 py-3">
				<h3 className="font-medium">{label}</h3>
				<p className="mt-0.5 text-muted-foreground text-xs">{description}</p>
			</div>
			<div className="divide-y divide-border/60">
				{sources.length === 0 ? (
					<p className="px-4 py-5 text-muted-foreground text-sm">
						No sources registered.
					</p>
				) : (
					sources.map((source, index) => {
						const sourceBusy =
							busy?.startsWith(`${kind}:${source.id}:`) ?? false;
						return (
							<div
								className="flex flex-wrap items-center gap-3 px-4 py-3"
								key={source.id}
							>
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="truncate font-medium text-sm">
											{source.displayName}
										</span>
										{source.builtin ? (
											<Badge variant="secondary">Built-in</Badge>
										) : (
											<Badge variant="outline">Custom</Badge>
										)}
										{active === source.id ? <Badge>Active</Badge> : null}
										{source.hasAuth ? (
											<Badge variant="outline">Auth configured</Badge>
										) : null}
									</div>
									<p className="mt-1 truncate text-muted-foreground text-xs">
										{source.baseUrl ?? "Hosted by Ryu"}
									</p>
								</div>
								<div className="flex items-center gap-1">
									<Button
										disabled={sourceBusy || active === source.id}
										loading={sourceBusy && busy?.endsWith(":select") === true}
										onClick={() => onSelect(source.id)}
										size="sm"
										variant="outline"
									>
										{active === source.id ? "Selected" : "Use source"}
									</Button>
									{source.builtin ? null : (
										<>
											<Button
												aria-label={`Move ${source.displayName} up`}
												disabled={sourceBusy || index === 0}
												onClick={() => onMove(source.id, "up")}
												size="icon-sm"
												variant="ghost"
											>
												<HugeiconsIcon
													className="size-4"
													icon={ArrowUp01Icon}
												/>
											</Button>
											<Button
												aria-label={`Move ${source.displayName} down`}
												disabled={sourceBusy || index === sources.length - 1}
												onClick={() => onMove(source.id, "down")}
												size="icon-sm"
												variant="ghost"
											>
												<HugeiconsIcon
													className="size-4"
													icon={ArrowDown01Icon}
												/>
											</Button>
											<Button
												aria-label={`Remove ${source.displayName}`}
												disabled={sourceBusy}
												onClick={() => onRemove(source.id)}
												size="icon-sm"
												variant="ghost"
											>
												<HugeiconsIcon className="size-4" icon={Delete01Icon} />
											</Button>
										</>
									)}
								</div>
							</div>
						);
					})
				)}
			</div>
		</section>
	);
}

function AddMarketplaceDialog({
	busy,
	kinds,
	onAdd,
	onOpenChange,
	open,
}: {
	busy: boolean;
	kinds: CatalogKind[];
	onAdd: (input: {
		authEnvVar?: string;
		baseUrl: string;
		displayName: string;
		id: string;
		kinds: CatalogKind[];
	}) => Promise<void>;
	onOpenChange: (open: boolean) => void;
	open: boolean;
}) {
	const [displayName, setDisplayName] = useState("");
	const [id, setId] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [authEnvVar, setAuthEnvVar] = useState("");
	const [selectedKinds, setSelectedKinds] = useState<CatalogKind[]>(kinds);
	const [error, setError] = useState<string | null>(null);

	const reset = () => {
		setDisplayName("");
		setId("");
		setBaseUrl("");
		setAuthEnvVar("");
		setSelectedKinds(kinds);
		setError(null);
	};

	const submit = async () => {
		if (!(displayName.trim() && id.trim() && baseUrl.trim())) {
			setError("Name, id, and repository or URL are required.");
			return;
		}
		if (selectedKinds.length === 0) {
			setError("Choose at least one catalog section.");
			return;
		}
		try {
			await onAdd({
				authEnvVar: authEnvVar.trim() || undefined,
				baseUrl: baseUrl.trim(),
				displayName: displayName.trim(),
				id: id.trim(),
				kinds: selectedKinds,
			});
			reset();
		} catch (submitError) {
			setError(
				submitError instanceof Error
					? submitError.message
					: "Failed to add marketplace"
			);
		}
	};

	return (
		<Dialog
			onOpenChange={(value) => {
				if (!value) {
					reset();
				}
				onOpenChange(value);
			}}
			open={open}
		>
			<DialogTrigger render={<Button size="sm" />}>
				<HugeiconsIcon className="size-4" icon={Add01Icon} />
				Add marketplace
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Add a marketplace</DialogTitle>
					<DialogDescription>
						Add a public or private GitHub-style marketplace. Private auth is
						stored as an environment-variable reference, never as a token in the
						UI.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4 py-2">
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="marketplace-name">Name</Label>
							<Input
								id="marketplace-name"
								onChange={(event) => setDisplayName(event.target.value)}
								value={displayName}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="marketplace-id">Id</Label>
							<Input
								id="marketplace-id"
								onChange={(event) => setId(event.target.value)}
								placeholder="owner/repository"
								value={id}
							/>
						</div>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="marketplace-url">Repository or manifest URL</Label>
						<Input
							id="marketplace-url"
							onChange={(event) => setBaseUrl(event.target.value)}
							placeholder="https://github.com/owner/repository"
							value={baseUrl}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="marketplace-auth-env">
							Auth environment variable (optional)
						</Label>
						<Input
							id="marketplace-auth-env"
							onChange={(event) => setAuthEnvVar(event.target.value)}
							placeholder="GITHUB_TOKEN"
							value={authEnvVar}
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label>List this marketplace under</Label>
						<div className="flex flex-wrap gap-2">
							{kinds.map((kind) => {
								const selected = selectedKinds.includes(kind);
								return (
									<Button
										key={kind}
										onClick={() =>
											setSelectedKinds((current) =>
												current.includes(kind)
													? current.filter((value) => value !== kind)
													: [...current, kind]
											)
										}
										size="sm"
										variant={selected ? "default" : "outline"}
									>
										{kind === "plugin" ? "Apps and plugins" : "Skills"}
									</Button>
								);
							})}
						</div>
					</div>
					{error ? <p className="text-destructive text-sm">{error}</p> : null}
				</div>
				<DialogFooter>
					<Button onClick={() => onOpenChange(false)} variant="ghost">
						Cancel
					</Button>
					<Button loading={busy} onClick={submit}>
						Add marketplace
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
