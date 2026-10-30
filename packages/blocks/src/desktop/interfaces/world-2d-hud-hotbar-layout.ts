/** Hotbar slot sizes (CSS px): full, and compact for a narrowed stage. */
export const SLOT_SIZE = { compact: 42, full: 54 } as const;
export type SlotSize = keyof typeof SLOT_SIZE;

/** Gap between hotbar slots (CSS px). */
export const SLOT_GAP = 2;
/** Width of a page-turn arrow (CSS px). */
export const PAGE_TURN_WIDTH = 28;
/** The hotbar's wooden frame, both sides together (CSS px), per size. */
const HOTBAR_CHROME: Record<SlotSize, number> = { compact: 20, full: 30 };
/** Screen pixels per frame pixel for slots and the bar, per size. */
export const SLOT_FRAME_SCALE: Record<SlotSize, number> = {
	compact: 1,
	full: 2,
};
export const BAR_FRAME_SCALE: Record<SlotSize, number> = {
	compact: 2,
	full: 3,
};

/** Fewest villagers a hotbar page holds, however narrow the stage. */
const MIN_PAGE = 4;
const MAX_PAGE = 10;

export interface HotbarLayout {
	/** The controls slot sits in the hotbar (else beside the place name). */
	helpInBar: boolean;
	pageSize: number;
	size: SlotSize;
	/** The hotbar's rendered width in CSS px (for placing the hint). */
	width: number;
}

/** The hotbar's width for a layout and a page of `slots` villagers. */
function barWidth(
	size: SlotSize,
	slots: number,
	helpInBar: boolean,
	paged: boolean
): number {
	const step = SLOT_SIZE[size] + SLOT_GAP;
	const fixed = (helpInBar ? 2 : 1) * step;
	const arrows = paged ? 2 * (PAGE_TURN_WIDTH + SLOT_GAP) : 0;
	return HOTBAR_CHROME[size] + fixed + arrows + slots * step;
}

/**
 * Fits the hotbar to the stage: full-size slots when they all fit (or the
 * stage is wide), compact ones on a narrowed stage, and the controls slot
 * moves up beside the place name when the stage is narrow, so at least
 * four portraits always fit on a page.
 */
export function hotbarLayout(stageWidth: number, agents: number): HotbarLayout {
	const slotsThatFit = (
		size: SlotSize,
		fixedSlots: number,
		arrows: boolean
	) => {
		const available = Math.max(0, stageWidth - 24 - HOTBAR_CHROME[size]);
		const step = SLOT_SIZE[size] + SLOT_GAP;
		const fixed =
			fixedSlots * step + (arrows ? 2 * (PAGE_TURN_WIDTH + SLOT_GAP) : 0);
		return Math.floor((available - fixed) / step);
	};
	const sizes: SlotSize[] = stageWidth >= 900 ? ["full"] : ["full", "compact"];
	for (const size of sizes) {
		if (agents <= MAX_PAGE && slotsThatFit(size, 2, false) >= agents) {
			return {
				helpInBar: true,
				pageSize: MAX_PAGE,
				size,
				width: barWidth(size, agents, true, false),
			};
		}
	}
	const size: SlotSize = stageWidth >= 900 ? "full" : "compact";
	const withHelp = slotsThatFit(size, 2, true);
	const helpInBar = withHelp >= MIN_PAGE;
	const pageSize = Math.min(
		MAX_PAGE,
		Math.max(MIN_PAGE, helpInBar ? withHelp : slotsThatFit(size, 1, true))
	);
	return {
		helpInBar,
		pageSize,
		size,
		width: barWidth(size, Math.min(pageSize, agents), helpInBar, true),
	};
}

/** A hotbar slot; keyboard focus gets the same thick red frame as selection. */
export const SLOT_BUTTON =
	"relative flex shrink-0 items-center justify-center outline-none focus-visible:shadow-[inset_0_0_0_3px_var(--sv-red-dark),inset_0_0_0_6px_var(--sv-red)]";
