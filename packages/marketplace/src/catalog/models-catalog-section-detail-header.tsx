import {
	CheckmarkCircle02Icon,
	CpuIcon,
	Download01Icon,
	FavouriteIcon,
	SquareLock01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import {
	ModalityFlowBadges,
	RawTags,
	SizeBadge,
	TokenBadge,
} from "./chrome/catalog-badges.tsx";
import {
	displayTokens,
	extractTokens,
	friendlyModelName,
	parseModelSize,
	parsePipelineModalities,
} from "./friendly.ts";
import {
	deviceSummaryLines,
	formatAgo,
	formatContext,
	formatCount,
	formatDate,
	formatParams,
} from "./models-catalog-section-format.ts";
import type { ModelCard, ModelDetail } from "./types.ts";

// ── Right: detail panel ───────────────────────────────────────────────────

/** The detail panel's title block: name, org link, badges, size/token row, tags. */
export function ModelDetailHeader({
	card,
	friendly,
	activeTokens,
	onToggleToken,
	onSelectOrg,
}: {
	card: ModelCard;
	friendly: boolean;
	activeTokens: Set<string>;
	onToggleToken: (id: string) => void;
	onSelectOrg: (org: string) => void;
}) {
	const tl = useLiteralMessages();
	const size = parseModelSize(card.name);
	const tokens = displayTokens(extractTokens(card.name, card.tags), friendly);
	return (
		<header className="flex flex-col gap-2">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<h2 className="truncate font-medium text-xl">
						{friendly ? friendlyModelName(card.name, card.tags) : card.name}
					</h2>
					<p className="text-muted-foreground text-sm">
						by{" "}
						{card.author ? (
							<Tooltip>
								<TooltipTrigger
									render={
										<button
											className="underline decoration-dotted underline-offset-2 hover:text-foreground"
											onClick={() => onSelectOrg(card.author)}
											type="button"
										>
											{card.author}
										</button>
									}
								/>
								<TooltipContent>
									{tl("Browse all models by {author}", { author: card.author })}
								</TooltipContent>
							</Tooltip>
						) : (
							"unknown"
						)}
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					{card.gated && (
						<Badge variant="secondary">
							<HugeiconsIcon
								className="size-3.5 text-status-warning"
								icon={SquareLock01Icon}
							/>
							Gated
						</Badge>
					)}
					{card.installed && (
						<Badge variant="secondary">
							<HugeiconsIcon
								className="size-3.5 text-status-success"
								icon={CheckmarkCircle02Icon}
							/>
							Added
						</Badge>
					)}
				</div>
			</div>
			<div className="flex items-center gap-3 text-muted-foreground text-xs">
				<span className="flex items-center gap-1">
					<HugeiconsIcon className="size-3.5" icon={Download01Icon} />
					{tl("{count} downloads", { count: formatCount(card.downloads) })}
				</span>
				<span className="flex items-center gap-1">
					<HugeiconsIcon className="size-3.5" icon={FavouriteIcon} />
					{tl("{count} likes", { count: formatCount(card.likes) })}
				</span>
				<a
					className="underline hover:text-foreground"
					href={`https://huggingface.co/${card.id}`}
					rel="noopener noreferrer"
					target="_blank"
				>
					View on Hugging Face
				</a>
			</div>
			{(card.createdAt || card.lastModified) && (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
					{formatAgo(card.createdAt) && (
						<span>
							{tl("Published {date} ({ago})", {
								date: formatDate(card.createdAt),
								ago: formatAgo(card.createdAt),
							})}
						</span>
					)}
					{formatAgo(card.lastModified) && (
						<span>
							{tl("Updated {date} ({ago})", {
								date: formatDate(card.lastModified),
								ago: formatAgo(card.lastModified),
							})}
						</span>
					)}
				</div>
			)}
			{(size || tokens.length > 0) && (
				<div className="flex flex-wrap items-center gap-1.5">
					{size && <SizeBadge friendly={friendly} size={size} />}
					{tokens.map((t) => (
						<TokenBadge
							active={activeTokens.has(t.id)}
							key={t.id}
							onToggle={onToggleToken}
							token={t}
						/>
					))}
				</div>
			)}
		</header>
	);
}

/**
 * Compact spec strip shown at the top of the detail panel: the model's context
 * window, parameter count, and architecture, read from the Hub's parsed GGUF
 * metadata. Renders nothing when the Hub reported none of these.
 */
export function ModelSpecsRow({ card }: { card: ModelCard }) {
	const ctx = formatContext(card.contextLength);
	const params = formatParams(card.params);
	const arch = card.architecture;
	const specs: { label: string; title?: string; value: string }[] = [];
	if (ctx) {
		specs.push({
			label: "Context window",
			value: `${ctx} tokens`,
			title:
				"The total tokens the model can read and write at once, shared by your prompt and its reply. GGUF models have one window, not separate input/output limits.",
		});
	}
	if (params) {
		specs.push({ label: "Parameters", value: params });
	}
	if (arch) {
		specs.push({ label: "Architecture", value: arch });
	}
	if (specs.length === 0) {
		return null;
	}
	return (
		<section className="flex flex-wrap gap-x-8 gap-y-2 rounded-lg bg-muted/50 px-4 py-3">
			{specs.map((s) => (
				<div className="flex flex-col gap-0.5" key={s.label}>
					{s.title ? (
						<Tooltip>
							<TooltipTrigger
								render={
									<span className="text-muted-foreground text-xs">
										{s.label}
									</span>
								}
							/>
							<TooltipContent>{s.title}</TooltipContent>
						</Tooltip>
					) : (
						<span className="text-muted-foreground text-xs">{s.label}</span>
					)}
					<span className="font-medium text-sm">{s.value}</span>
				</div>
			))}
		</section>
	);
}

export function ModelOverviewGrid({
	card,
	device,
}: {
	card: ModelCard;
	device: ModelDetail["device"];
}) {
	const modalities = parsePipelineModalities(card.pipelineTag);
	const deviceLines = deviceSummaryLines(device);
	let deviceHint =
		"No GPU detected, so downloads are checked against CPU + RAM.";
	if (device.vramBytes) {
		deviceHint = "GPU memory is used first; larger files can share system RAM.";
	} else if (device.unifiedMemory) {
		deviceHint = "CPU and GPU share unified memory on this device.";
	}
	return (
		<section className="grid gap-3 md:grid-cols-3">
			<div className="flex min-w-0 flex-col gap-1.5">
				<div className="font-medium text-muted-foreground text-xs">
					Modalities
				</div>
				<div className="rounded-lg bg-muted/50 p-3">
					{modalities ? (
						<ModalityFlowBadges flow={modalities} />
					) : (
						<div className="text-muted-foreground text-sm">
							No task metadata
						</div>
					)}
				</div>
			</div>
			<div className="flex min-w-0 flex-col gap-1.5">
				<div className="font-medium text-muted-foreground text-xs">
					Your device
				</div>
				<div className="rounded-lg bg-muted/50 p-3">
					<div className="flex items-start gap-2 text-sm">
						<HugeiconsIcon
							className="mt-0.5 size-4 shrink-0 text-muted-foreground"
							icon={CpuIcon}
						/>
						<div className="min-w-0 text-muted-foreground">
							{deviceLines.map((line) => (
								<div className="truncate" key={line}>
									{line}
								</div>
							))}
						</div>
					</div>
					<p className="mt-2 text-muted-foreground text-xs">{deviceHint}</p>
				</div>
			</div>
			<div className="flex min-w-0 flex-col gap-1.5">
				<div className="font-medium text-muted-foreground text-xs">Tags</div>
				<div className="rounded-lg bg-muted/50 p-3">
					{card.tags.length > 0 ? (
						<RawTags limit={18} tags={card.tags} />
					) : (
						<div className="text-muted-foreground text-sm">No tags</div>
					)}
				</div>
			</div>
		</section>
	);
}
