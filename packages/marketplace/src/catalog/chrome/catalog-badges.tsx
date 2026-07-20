// packages/marketplace/src/catalog/chrome/catalog-badges.tsx
//
// Shared badge primitives for the Models and Skills catalog sections, moved into
// @ryu/marketplace so both surfaces (desktop + web) render them from one place.
// Token badges double as filter chips; the size badge shows a friendly tier (or
// the raw param count) with the literal value on hover; the chip bar shows the
// active token/org filters with a one-click remove. Each badge carries an icon and
// a real (@ryu/ui) Tooltip — never a native `title` — so hovers match the rest of
// the app. Badges are background-only (no border). Desktop re-exports this module
// so its Models section keeps its import path stable.

import {
	AiBrain01Icon,
	AiNetworkIcon,
	AudioWave01Icon,
	BookOpen01Icon,
	BubbleChatIcon,
	Building01Icon,
	Calculator01Icon,
	Cancel01Icon,
	CpuIcon,
	DistributionIcon,
	File01Icon,
	FlashIcon,
	GitMergeIcon,
	IdeaIcon,
	Image01Icon,
	Message01Icon,
	Package01Icon,
	Pdf01Icon,
	Route01Icon,
	Settings01Icon,
	SourceCodeIcon,
	SparklesIcon,
	SquareUnlock01Icon,
	Tag01Icon,
	Target01Icon,
	TestTube01Icon,
	TextFontIcon,
	TextWrapIcon,
	Video01Icon,
	ViewIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type BadgeTone,
	displayTokens,
	extractTokens,
	type MatchedToken,
	type Modality,
	type ModalityFlow,
	parseModelSize,
	type SizeBadgeInfo,
} from "../friendly.ts";

const BASE_CHIP =
	"inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-3xl px-2 py-0.5 font-medium text-[11px] whitespace-nowrap transition-colors";

/** Subtle, theme-aware background per badge tone (no border — fill only). */
const TONE_CLASS: Record<BadgeTone, string> = {
	neutral: "bg-foreground/8 text-foreground/80",
	blue: "bg-info/12 text-info dark:text-info",
	violet: "bg-violet-500/12 text-violet-600 dark:text-violet-400",
	amber: "bg-warning/12 text-warning dark:text-warning",
	rose: "bg-destructive/12 text-destructive dark:text-destructive",
	emerald: "bg-success/12 text-success dark:text-success",
};

/** Token id → icon. Falls back to a tag icon via {@link tokenIcon}. */
const TOKEN_ICON: Record<string, IconSvgElement> = {
	instruct: Message01Icon,
	chat: BubbleChatIcon,
	base: BookOpen01Icon,
	reasoning: AiBrain01Icon,
	r1: IdeaIcon,
	cot: Route01Icon,
	mtp: FlashIcon,
	uncensored: SquareUnlock01Icon,
	qat: SparklesIcon,
	finetuned: Settings01Icon,
	distilled: DistributionIcon,
	merged: GitMergeIcon,
	vision: ViewIcon,
	coder: SourceCodeIcon,
	math: Calculator01Icon,
	moe: AiNetworkIcon,
	precision: Target01Icon,
	gguf: Package01Icon,
	format: File01Icon,
	preview: TestTube01Icon,
	longcontext: TextWrapIcon,
};

/** Icon for a token id (tag icon when the token has no dedicated one). */
export function tokenIcon(id: string): IconSvgElement {
	return TOKEN_ICON[id] ?? Tag01Icon;
}

/** Icon for the org/owner "browse this org" filter chip. */
export const ORG_ICON: IconSvgElement = Building01Icon;
/** Icon for the tag-filter dropdown trigger. */
export const TAG_ICON: IconSvgElement = Tag01Icon;

/** Icon + label per input/output modality. */
const MODALITY_META: Record<Modality, { icon: IconSvgElement; label: string }> =
	{
		text: { icon: TextFontIcon, label: "Text" },
		image: { icon: Image01Icon, label: "Image" },
		pdf: { icon: Pdf01Icon, label: "PDF" },
		video: { icon: Video01Icon, label: "Video" },
		audio: { icon: AudioWave01Icon, label: "Audio" },
	};

/** One modality chip — icon + label, or icon-only with a tooltip in compact mode. */
function ModalityChip({ m, compact }: { m: Modality; compact?: boolean }) {
	const meta = MODALITY_META[m];
	const chip = (
		<span
			className={cn(
				BASE_CHIP,
				"bg-foreground/8 text-foreground/80",
				compact && "px-1.5"
			)}
		>
			<HugeiconsIcon className="size-3" icon={meta.icon} />
			{compact ? null : meta.label}
		</span>
	);
	if (!compact) {
		return chip;
	}
	return (
		<Tooltip>
			<TooltipTrigger render={chip} />
			<TooltipContent>{meta.label}</TooltipContent>
		</Tooltip>
	);
}

function ModalityChips({
	modalities,
	compact,
}: {
	modalities: Modality[];
	compact?: boolean;
}) {
	return (
		<span className="inline-flex flex-wrap items-center justify-center gap-1">
			{modalities.map((m) => (
				<ModalityChip compact={compact} key={m} m={m} />
			))}
		</span>
	);
}

/**
 * "Input → Output" modality row for a model, derived from its pipeline tag. In
 * `compact` mode (list cards) the chips are icon-only with the name on hover.
 */
export function ModalityFlowBadges({
	flow,
	compact,
}: {
	flow: ModalityFlow;
	compact?: boolean;
}) {
	if (compact) {
		return (
			<span className="inline-flex min-w-0 items-center justify-center gap-1 align-middle">
				<ModalityChips compact modalities={flow.inputs} />
				<span className="shrink-0 text-muted-foreground text-xs">→</span>
				<ModalityChips compact modalities={flow.outputs} />
			</span>
		);
	}
	return (
		<div className="flex flex-col items-center gap-1 text-xs">
			<ModalityChips modalities={flow.inputs} />
			<span aria-hidden="true" className="text-muted-foreground">
				↓
			</span>
			<ModalityChips modalities={flow.outputs} />
		</div>
	);
}

/**
 * Raw Hugging Face tags as a leading-icon row of background-only chips (no
 * borders). Capped at `limit` with a "+N" overflow note so the card stays sane.
 */
export function RawTags({
	tags,
	limit = 12,
}: {
	tags: string[];
	limit?: number;
}) {
	if (tags.length === 0) {
		return null;
	}
	const shown = tags.slice(0, limit);
	const extra = tags.length - shown.length;
	return (
		<div className="flex flex-wrap items-center gap-1">
			<HugeiconsIcon
				className="size-3 shrink-0 text-muted-foreground"
				icon={Tag01Icon}
			/>
			{shown.map((t) => (
				<span
					className={cn(
						BASE_CHIP,
						"bg-foreground/8 font-normal text-foreground/80"
					)}
					key={t}
				>
					{t}
				</span>
			))}
			{extra > 0 && (
				<span
					className={cn(
						BASE_CHIP,
						"bg-foreground/8 font-normal text-foreground/80"
					)}
				>
					+{extra}
				</span>
			)}
		</div>
	);
}

/**
 * A recognized name-token rendered as a badge. When `onToggle` is supplied the
 * badge becomes a filter button (and shows its active state); otherwise it is a
 * static, hover-explained label.
 */
export function TokenBadge({
	token,
	active = false,
	onToggle,
}: {
	token: MatchedToken;
	active?: boolean;
	onToggle?: (id: string) => void;
}) {
	const className = cn(
		BASE_CHIP,
		TONE_CLASS[token.tone],
		onToggle && "cursor-pointer hover:brightness-105",
		active && "ring-2 ring-ring/50"
	);
	const inner = (
		<>
			<HugeiconsIcon className="size-3" icon={tokenIcon(token.id)} />
			{token.label}
		</>
	);
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					onToggle ? (
						<button
							aria-pressed={active}
							className={className}
							onClick={() => onToggle(token.id)}
							type="button"
						>
							{inner}
						</button>
					) : (
						<span className={className}>{inner}</span>
					)
				}
			/>
			<TooltipContent>{token.tooltip}</TooltipContent>
		</Tooltip>
	);
}

/**
 * Param-size badge. In friendly mode shows the tier word (Small/Medium/Large); in
 * raw mode shows the literal count (e.g. "27B"). Either way the exact value and any
 * active/effective-param note live in the hover.
 */
export function SizeBadge({
	size,
	friendly,
}: {
	size: SizeBadgeInfo;
	friendly: boolean;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span className={cn(BASE_CHIP, "bg-foreground/8 text-foreground/80")}>
						<HugeiconsIcon className="size-3" icon={CpuIcon} />
						{friendly ? size.tier : size.raw}
					</span>
				}
			/>
			<TooltipContent>{size.tooltip}</TooltipContent>
		</Tooltip>
	);
}

/**
 * List-card badge stack: a row of size + tokens, and — when `showTags` is on — a
 * second row of raw Hugging Face tags.
 */
export function CardBadges({
	name,
	tags,
	friendly,
	showTags = false,
}: {
	name: string;
	tags: string[];
	friendly: boolean;
	showTags?: boolean;
}) {
	const size = parseModelSize(name);
	const tokens = displayTokens(extractTokens(name, tags), friendly);
	const hasTopRow = Boolean(size) || tokens.length > 0;
	const tagsRow = showTags && tags.length > 0;
	if (!(hasTopRow || tagsRow)) {
		return null;
	}
	return (
		<div className="mt-1 flex flex-col gap-1">
			{hasTopRow && (
				<div className="flex flex-wrap items-center gap-1">
					{size ? <SizeBadge friendly={friendly} size={size} /> : null}
					{tokens.map((t) => (
						<TokenBadge key={t.id} token={t} />
					))}
				</div>
			)}
			{tagsRow && <RawTags tags={tags} />}
		</div>
	);
}

/** One active filter as a removable chip. */
export interface ActiveChip {
	icon: IconSvgElement;
	/** Unique key, e.g. `token:instruct` or `org:google`. */
	key: string;
	label: string;
	onRemove: () => void;
}

/** Renders the active token + org filter chips with a per-chip remove button. */
export function FilterChipBar({ chips }: { chips: ActiveChip[] }) {
	if (chips.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<span className="text-muted-foreground text-xs">Filters:</span>
			{chips.map((chip) => (
				<span
					className={cn(BASE_CHIP, "bg-primary/12 text-foreground")}
					key={chip.key}
				>
					<HugeiconsIcon className="size-3" icon={chip.icon} />
					{chip.label}
					<button
						aria-label={`Remove filter ${chip.label}`}
						className="-mr-1 rounded-full p-0.5 hover:bg-foreground/10"
						onClick={chip.onRemove}
						type="button"
					>
						<HugeiconsIcon className="size-3" icon={Cancel01Icon} />
					</button>
				</span>
			))}
		</div>
	);
}
