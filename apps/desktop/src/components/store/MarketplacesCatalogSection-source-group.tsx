import {
	ArrowDown01Icon,
	ArrowUp01Icon,
	Delete01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import type {
	CatalogKind,
	CatalogSource,
} from "@/src/lib/api/catalog-sources.ts";

export function MarketplaceSourceGroup({
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
	const tl = useLiteralMessages();
	return (
		<section className="rounded-xl border border-border bg-card">
			<div className="border-border border-b px-4 py-3">
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
										<span
											className="truncate font-medium text-sm"
											title={source.displayName}
										>
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
												aria-label={tl("Move {displayName} up", {
													displayName: source.displayName,
												})}
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
												aria-label={tl("Move {displayName} down", {
													displayName: source.displayName,
												})}
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
												aria-label={tl("Remove {displayName}", {
													displayName: source.displayName,
												})}
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
