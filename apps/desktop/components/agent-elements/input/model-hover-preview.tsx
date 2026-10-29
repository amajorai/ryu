"use client";

import {
	AudioWave01Icon,
	DollarCircleIcon,
	FlashIcon,
	Image01Icon,
	Pdf01Icon,
	SparklesIcon,
	TextFontIcon,
	Video01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { formatCount, formatCurrency } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ModelInsight } from "@/src/lib/api/model-insight.ts";

type Modality = "text" | "image" | "pdf" | "video" | "audio";

const MODALITY_META = {
	text: { icon: TextFontIcon, label: "Text" },
	image: { icon: Image01Icon, label: "Image" },
	pdf: { icon: Pdf01Icon, label: "PDF" },
	video: { icon: Video01Icon, label: "Video" },
	audio: { icon: AudioWave01Icon, label: "Audio" },
} satisfies Record<Modality, { icon: IconSvgElement; label: string }>;

const KNOWN_MODALITIES = new Set<string>(Object.keys(MODALITY_META));

const BAR_PIPS = [1, 2, 3, 4, 5] as const;

function formatTokens(n: number): string {
	return formatCount(n) ?? "—";
}

function formatUsdPer1m(n: number): string {
	const decimals = n < 0.01 ? 4 : n < 1 ? 3 : 2;
	return formatCurrency(n, "USD", {
		maximumFractionDigits: decimals,
		minimumFractionDigits: decimals,
	});
}

function formatScore(score: number): string {
	return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

function ScoreBar({
	icon,
	label,
	score,
	hint,
}: {
	icon?: IconSvgElement;
	label: string;
	score: number | null | undefined;
	hint?: string | null;
}) {
	const value =
		isNativeNumber(score) && Number.isFinite(score) && score >= 1
			? Math.min(score, 5)
			: null;
	const filledPips = value === null ? 0 : Math.round(value);
	const scoreLabel =
		value === null
			? `${label}: unknown`
			: `${label}: ${formatScore(value)} of 5${hint ? `, ${hint}` : ""}`;
	return (
		<div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3">
			<span className="type-caption flex min-w-0 items-center gap-1 font-medium text-muted-foreground">
				{icon ? (
					<HugeiconsIcon
						aria-hidden="true"
						className="size-3 shrink-0 text-status-warning"
						icon={icon}
					/>
				) : null}
				{label}
			</span>
			<span
				aria-label={scoreLabel}
				className="flex min-w-0 flex-1 items-center gap-1.5"
				data-filled-pips={filledPips}
				data-score={value === null ? undefined : value}
				data-slot="model-score-bar"
				role="img"
			>
				{BAR_PIPS.map((level) => (
					<span
						aria-hidden="true"
						className={cn(
							"h-1.5 min-w-0 flex-1 rounded-full",
							level <= filledPips
								? "bg-foreground/85"
								: "bg-muted-foreground/45"
						)}
						data-filled={level <= filledPips}
						data-slot="model-score-pip"
						key={level}
					/>
				))}
			</span>
		</div>
	);
}

function ModalityRow({
	inputs,
	outputs,
}: {
	inputs: string[];
	outputs: string[];
}) {
	const inMods = inputs.filter((m): m is Modality => KNOWN_MODALITIES.has(m));
	const outMods = outputs.filter((m): m is Modality => KNOWN_MODALITIES.has(m));
	if (inMods.length === 0 && outMods.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<span className="type-caption text-muted-foreground">Modalities</span>
			<div className="flex flex-wrap items-center gap-1">
				{inMods.map((m) => (
					<span
						className="type-compact inline-flex items-center gap-1 rounded-md bg-foreground/8 px-1.5 py-0.5 text-foreground/80"
						key={`in-${m}`}
						title={MODALITY_META[m].label}
					>
						<HugeiconsIcon className="size-3" icon={MODALITY_META[m].icon} />
						{MODALITY_META[m].label}
					</span>
				))}
				<span className="type-compact text-muted-foreground">→</span>
				{outMods.map((m) => (
					<span
						className="type-compact inline-flex items-center gap-1 rounded-md bg-foreground/8 px-1.5 py-0.5 text-foreground/80"
						key={`out-${m}`}
						title={MODALITY_META[m].label}
					>
						<HugeiconsIcon className="size-3" icon={MODALITY_META[m].icon} />
						{MODALITY_META[m].label}
					</span>
				))}
			</div>
		</div>
	);
}

/**
 * Compact model insight card for the agent/model picker hover.
 * Stacked five-pip score bars (speed / intelligence / cost / context) plus price,
 * context tokens, and modality chips — filled from Core's insight cascade.
 */
export function ModelHoverPreview({ insight }: { insight: ModelInsight }) {
	const tl = useLiteralMessages();
	const inputPrice = isNativeNumber(insight.costInputPer1m)
		? formatUsdPer1m(insight.costInputPer1m)
		: null;
	const outputPrice = isNativeNumber(insight.costOutputPer1m)
		? formatUsdPer1m(insight.costOutputPer1m)
		: null;
	const contextHint = isNativeNumber(insight.contextTokens)
		? formatTokens(insight.contextTokens)
		: null;
	const speedHint = isNativeNumber(insight.outputTokensPerSecond)
		? `${Math.round(insight.outputTokensPerSecond)} tok/s`
		: null;
	const intelHint = isNativeNumber(insight.intelligenceIndex)
		? insight.intelligenceIndex.toFixed(0)
		: null;
	const costHint =
		inputPrice && outputPrice
			? `${inputPrice} / ${outputPrice}`
			: (inputPrice ?? outputPrice);

	return (
		<div className="flex w-[16.5rem] flex-col gap-3">
			<div className="flex flex-col gap-0.5">
				<div className="flex items-start gap-2">
					<HugeiconsIcon
						className="mt-0.5 size-3.5 shrink-0 text-status-warning"
						icon={SparklesIcon}
					/>
					<div className="min-w-0 flex-1">
						<p className="text-(length:--text-detail) truncate font-medium leading-tight">
							{insight.name}
						</p>
						{insight.description ? (
							<p className="type-caption mt-0.5 line-clamp-2 text-muted-foreground leading-snug">
								{insight.description}
							</p>
						) : null}
					</div>
				</div>
			</div>

			<div className="flex flex-col gap-2.5 border-border/40 border-t pt-3">
				<ScoreBar hint={speedHint} label="Speed" score={insight.scoreSpeed} />
				<ScoreBar
					hint={intelHint}
					label="Intelligence"
					score={insight.scoreIntelligence}
				/>
				<ScoreBar
					hint={costHint}
					icon={DollarCircleIcon}
					label="Cost"
					score={insight.scoreCost}
				/>
				<ScoreBar
					hint={contextHint}
					label="Context"
					score={insight.scoreContext}
				/>
			</div>

			{(inputPrice || outputPrice || contextHint) && (
				<div className="flex flex-col gap-1 border-border/40 border-t pt-2">
					{(inputPrice || outputPrice) && (
						<div className="type-caption flex items-center gap-1.5 text-muted-foreground">
							<HugeiconsIcon
								className="size-3 shrink-0"
								icon={DollarCircleIcon}
							/>
							<span className="font-mono tabular-nums">
								{inputPrice ? (
									<>
										{tl("In {inputPrice}", { inputPrice })}
										<span className="text-muted-foreground/70"> /1M</span>
									</>
								) : null}
								{inputPrice && outputPrice ? " · " : null}
								{outputPrice ? (
									<>
										{tl("Out {outputPrice}", { outputPrice })}
										<span className="text-muted-foreground/70"> /1M</span>
									</>
								) : null}
							</span>
						</div>
					)}
					{contextHint ? (
						<div className="type-caption flex items-center gap-1.5 text-muted-foreground">
							<HugeiconsIcon className="size-3 shrink-0" icon={FlashIcon} />
							<span>
								{isNativeNumber(insight.maxOutputTokens)
									? tl("{contextHint} context · {maxOutput} out", {
											contextHint,
											maxOutput: formatTokens(insight.maxOutputTokens),
										})
									: tl("{contextHint} context", { contextHint })}
							</span>
						</div>
					) : null}
				</div>
			)}

			<ModalityRow
				inputs={insight.modalitiesInput}
				outputs={insight.modalitiesOutput}
			/>

			<p className="type-compact text-muted-foreground/70">
				{insight.source === "openrouter"
					? "Current OpenRouter transaction price"
					: tl("via {source}", { source: insight.source })}
				{insight.aaMatchedName ? ` · AA: ${insight.aaMatchedName}` : null}
			</p>
		</div>
	);
}
