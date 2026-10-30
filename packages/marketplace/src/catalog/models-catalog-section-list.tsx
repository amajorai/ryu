import {
	BrainIcon,
	CheckmarkCircle02Icon,
	Download01Icon,
	FavouriteIcon,
	SquareLock01Icon,
	TextWrapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { useState } from "react";
import { CardBadges, ModalityFlowBadges } from "./chrome/catalog-badges.tsx";
import InfiniteSentinel from "./chrome/infinite-sentinel.tsx";
import { friendlyModelName, parsePipelineModalities } from "./friendly.ts";
import {
	formatAgo,
	formatContext,
	formatCount,
	formatDate,
} from "./models-catalog-section-format.ts";
import type { ModelCard } from "./types.ts";

// ── Left: model selector list ───────────────────────────────────────────────

export function ModelList({
	models,
	loading,
	error,
	selectedId,
	onSelect,
	fetchNextPage,
	hasNextPage,
	loadingMore,
	friendly,
	showTags,
	installedOnly,
	onClearFilters,
	onRetry,
}: {
	models: ModelCard[];
	loading: boolean;
	error: string | null;
	selectedId: string | null;
	onSelect: (id: string) => void;
	fetchNextPage: () => void;
	hasNextPage: boolean;
	loadingMore: boolean;
	friendly: boolean;
	showTags: boolean;
	installedOnly: boolean;
	onClearFilters: () => void;
	onRetry: () => void;
}) {
	// The IntersectionObserver root is this scrollable nav, not the viewport.
	const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
	const tl = useLiteralMessages();

	if (loading && models.length === 0) {
		return (
			<div className="flex items-center justify-center p-8 text-muted-foreground">
				<Spinner className="size-5" />
			</div>
		);
	}
	if (error) {
		return (
			<Empty className="h-full" inset="dense">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={BrainIcon} />
					</EmptyMedia>
					<EmptyTitle>Couldn&apos;t load models</EmptyTitle>
					<EmptyDescription>{error}</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onRetry} size="sm" variant="ghost">
						Try again
					</Button>
				</EmptyContent>
			</Empty>
		);
	}
	if (models.length === 0) {
		return (
			<Empty className="h-full" inset="dense">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={BrainIcon} />
					</EmptyMedia>
					<EmptyTitle>
						{installedOnly ? "No models added yet" : "No models found"}
					</EmptyTitle>
					<EmptyDescription>
						{installedOnly
							? "Turn off “Added only” to browse and add models."
							: "Try a different search."}
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onClearFilters} size="sm" variant="ghost">
						Clear filters
					</Button>
				</EmptyContent>
			</Empty>
		);
	}

	return (
		<nav className="scroll-fade h-full overflow-auto p-2" ref={setScrollEl}>
			<ul className="flex flex-col gap-1">
				{models.map((m) => {
					const isSelected = m.id === selectedId;
					const modality = parsePipelineModalities(m.pipelineTag);
					const updatedAgo = formatAgo(m.lastModified);
					const publishedAgo = formatAgo(m.createdAt);
					return (
						<li key={m.id}>
							<button
								className={`w-full rounded-lg px-3 py-2 text-left transition-colors ${
									isSelected ? "bg-accent" : "hover:bg-accent/50"
								}`}
								onClick={() => onSelect(m.id)}
								type="button"
							>
								<div className="flex items-center gap-2">
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-1.5">
											<span className="min-w-0 truncate font-medium text-sm">
												{friendly ? friendlyModelName(m.name, m.tags) : m.name}
											</span>
											{m.installed && (
												<HugeiconsIcon
													aria-label="Added"
													className="size-3.5 shrink-0 text-status-success"
													icon={CheckmarkCircle02Icon}
												/>
											)}
											{m.gated && (
												<HugeiconsIcon
													className="size-3.5 shrink-0 text-status-warning"
													icon={SquareLock01Icon}
												/>
											)}
										</div>
										<div className="truncate text-muted-foreground text-xs">
											{m.author || "unknown"}
										</div>
									</div>
									{(updatedAgo || publishedAgo) && (
										<div className="flex shrink-0 flex-col items-end justify-center gap-0.5 text-right text-muted-foreground text-xs leading-4">
											{publishedAgo && (
												<ModelDateLine
													date={formatDate(m.createdAt)}
													tooltipLabel="Published"
													value={publishedAgo}
												/>
											)}
											{updatedAgo && (
												<ModelDateLine
													date={formatDate(m.lastModified)}
													tooltipLabel="Updated"
													value={`(updated ${updatedAgo})`}
												/>
											)}
										</div>
									)}
								</div>
								<CardBadges
									friendly={friendly}
									name={m.name}
									showTags={showTags}
									tags={m.tags}
								/>
								{!m.compatible && (
									<Badge appearance="challenge-warning" variant="outline">
										{m.format === "mlx"
											? "macOS only"
											: tl("Needs {engine}", {
													engine: m.needsEngine ?? tl("another engine"),
												})}
									</Badge>
								)}
								<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
									<span className="flex items-center gap-1">
										<HugeiconsIcon className="size-3" icon={Download01Icon} />
										{formatCount(m.downloads)}
									</span>
									<span className="flex items-center gap-1">
										<HugeiconsIcon className="size-3" icon={FavouriteIcon} />
										{formatCount(m.likes)}
									</span>
									{formatContext(m.contextLength) && (
										<Tooltip>
											<TooltipTrigger
												render={
													<span className="flex items-center gap-1 whitespace-nowrap">
														<HugeiconsIcon
															className="size-3"
															icon={TextWrapIcon}
														/>
														{tl("{context} context", {
															context: formatContext(m.contextLength),
														})}
													</span>
												}
											/>
											<TooltipContent>
												Context window (tokens the model can read + write at
												once)
											</TooltipContent>
										</Tooltip>
									)}
									{modality && (
										<span className="min-w-0 shrink basis-full sm:basis-auto">
											<ModalityFlowBadges compact flow={modality} />
										</span>
									)}
								</div>
							</button>
						</li>
					);
				})}
			</ul>
			<InfiniteSentinel
				hasMore={hasNextPage}
				loading={loadingMore}
				onLoadMore={fetchNextPage}
				root={scrollEl}
			/>
		</nav>
	);
}

function ModelDateLine({
	date,
	tooltipLabel,
	value,
}: {
	date: string | null;
	tooltipLabel: string;
	value: string;
}) {
	if (!date) {
		return <span>{value}</span>;
	}
	return (
		<Tooltip>
			<TooltipTrigger render={<span>{value}</span>} />
			<TooltipContent>
				{tooltipLabel} {date}
			</TooltipContent>
		</Tooltip>
	);
}
