import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import type { OffStage, YouSpotSlot } from "./game3d-acts.ts";
import { type LifePaths, type LifePlace, placeAt } from "./game3d-life.ts";
import type { Vec3 } from "./game3d-palette.ts";
import { CRAMPED_STAGE } from "./game3d-plates.ts";

/** The act layer's overlay budget: which bubbles and badges a stage shows. */

/** A status text overlay competing for the budget. */
export interface BudgetItem {
	/** Within work bubbles: the focus agent's goes first. */
	focus?: boolean;
	id: string;
	kind: "ask-bubble" | "limit" | "tally" | "text" | "work-bubble";
}

/** How many status overlays a stage may draw, and how plates collapse. */
export interface OverlayBudget {
	/** Ask bubbles allowed for queued villagers (none on narrow stages). */
	askBubbles: number;
	/** Budgeted status overlays allowed in all. */
	cap: number;
	/**
	 * The stage is short (a thread view squeezes it): the budget halves again
	 * and board "Next:" lines go first.
	 */
	cramped: boolean;
	/** Picks the overlays to draw, in the fill order, up to the caps. */
	fill: (items: readonly BudgetItem[]) => Set<string>;
	/** Exempt props are DOM keyboard targets (pass as their `focusable`). */
	focusable: boolean;
	/** Exempt plates (other than queue plates) collapse to a glyph. */
	iconOnly: boolean;
	narrow: boolean;
}

/** Below this stage width plates go icon-only and the budget halves. */
export const NARROW_STAGE = 640;
/** Below this stage height the budget halves again ("Next:" lines first). */
export { CRAMPED_STAGE };

const KIND_ORDER: BudgetItem["kind"][] = [
	"tally",
	"limit",
	"ask-bubble",
	"work-bubble",
	"text",
];
const KIND_CAP: Record<BudgetItem["kind"], number> = {
	"ask-bubble": 4,
	limit: 2,
	tally: 2,
	text: Number.POSITIVE_INFINITY,
	"work-bubble": Number.POSITIVE_INFINITY,
};

/**
 * The overlay budget for a stage `width` px wide. Focus and pointer
 * targets (plates, alarm and notice plates, queue plates, tray, marks,
 * notes) are exempt and never dropped; on narrow stages all but the queue
 * plates collapse to `iconOnly`, and with `domTargets` they are also the
 * keyboard targets (`focusable`). Status text
 * overlays are capped at 16 (8 narrow), filled tallies, limit plates, ask
 * bubbles (none narrow), work bubbles (focus first), then other text.
 * With the stage's measured `height` (`useStageSize`), a stage shorter
 * than CRAMPED_STAGE (squeezed beside a thread view) halves the cap again
 * and fills board "Next:" lines last, so they go first. Without it, as
 * before.
 */
export function overlayBudget(
	width: number,
	{ domTargets, height }: { domTargets: boolean; height?: number }
): OverlayBudget {
	const narrow = width < NARROW_STAGE;
	const cramped = height !== undefined && height > 0 && height < CRAMPED_STAGE;
	const cap = (narrow ? 8 : 16) / (cramped ? 2 : 1);
	const askBubbles = narrow ? 0 : KIND_CAP["ask-bubble"];
	return {
		askBubbles,
		cap,
		fill: (items) => {
			const chosen = new Set<string>();
			for (const kind of KIND_ORDER) {
				const limit = kind === "ask-bubble" ? askBubbles : KIND_CAP[kind];
				const group = items
					.filter((item) => item.kind === kind)
					.sort(
						(a, b) =>
							Number(Boolean(b.focus)) - Number(Boolean(a.focus)) ||
							(cramped ? nextLast(a) - nextLast(b) : 0)
					);
				let taken = 0;
				for (const item of group) {
					if (chosen.size >= cap || taken >= limit) {
						break;
					}
					chosen.add(item.id);
					taken += 1;
				}
			}
			return chosen;
		},
		cramped,
		focusable: domTargets,
		iconOnly: narrow,
		narrow,
	};
}

/** 1 for a board "Next:" line (dropped first on a cramped stage), else 0. */
function nextLast(item: BudgetItem): number {
	return item.id.startsWith("next:") ? 1 : 0;
}

/**
 * The status text overlays an act stage would draw, for `overlayBudget`,
 * with ids a game looks up when it draws them:
 * - `tally:you`, `tally:off`: the you-spot and off-stage tallies;
 * - `limit:<agent>`: limit plates;
 * - `ask:<ask>`: ask bubbles of queued villagers;
 * - `work:<agent>` (none under reduced motion, where `actLife` scripts no
 *   work bubble), `done:<agent>`, `wait:<agent>`: the other bubbles;
 * - `progress:`, `next:`, `elapsed:`, `cue:` (longer than usual or
 *   stalled) and `count:<agent>` (the tray sticker): station text.
 * Hide a villager's bubble with `VillagerSpec.bubble: false` when its id
 * is not chosen; the life script stays the same.
 */
export function actOverlays(
	onStage: readonly InterfaceAgentAct[],
	slots: { overflow: number; slots: readonly YouSpotSlot[] },
	offStage: Pick<OffStage, "count">,
	focusAgentId: string | null = null,
	{ reduced = false }: { reduced?: boolean } = {}
): BudgetItem[] {
	const items: BudgetItem[] = [];
	if (slots.overflow > 0) {
		items.push({ id: "tally:you", kind: "tally" });
	}
	if (offStage.count > 0) {
		items.push({ id: "tally:off", kind: "tally" });
	}
	for (const act of onStage) {
		if (act.act === "limited") {
			items.push({ id: `limit:${act.agentId}`, kind: "limit" });
		}
	}
	for (const slot of slots.slots) {
		if (slot.carrier === "villager") {
			items.push({ id: `ask:${slot.ask.id}`, kind: "ask-bubble" });
		}
	}
	for (const act of onStage) {
		const focus = act.agentId === focusAgentId;
		if (act.act === "working" && act.bubble && !act.stalled && !reduced) {
			items.push({ focus, id: `work:${act.agentId}`, kind: "work-bubble" });
		}
		if (act.act === "delivering" && act.bubble) {
			items.push({ focus, id: `done:${act.agentId}`, kind: "work-bubble" });
		}
		if (act.act === "waiting" && act.bubble) {
			items.push({ focus, id: `wait:${act.agentId}`, kind: "work-bubble" });
		}
		if (act.progress) {
			items.push({ id: `progress:${act.agentId}`, kind: "text" });
		}
		if (act.next) {
			items.push({ id: `next:${act.agentId}`, kind: "text" });
		}
		if (act.elapsed) {
			items.push({ id: `elapsed:${act.agentId}`, kind: "text" });
		}
		if (act.stalled || act.longerThanUsual) {
			items.push({ id: `cue:${act.agentId}`, kind: "text" });
		}
		if (act.act === "delivering") {
			items.push({ id: `count:${act.agentId}`, kind: "text" });
		}
	}
	return items;
}

/** The budget id of a villager's bubble for its act, or null for none. */
export function bubbleOverlayId(act: InterfaceAgentAct): string | null {
	switch (act.act) {
		case "asking":
			return act.ask ? `ask:${act.ask.id}` : null;
		case "working":
			return `work:${act.agentId}`;
		case "delivering":
			return `done:${act.agentId}`;
		case "waiting":
			return `wait:${act.agentId}`;
		default:
			return null;
	}
}

/** A world point for a waypoint id or point (station lookups for props). */
export function spotPoint(paths: LifePaths, place: LifePlace): Vec3 | null {
	return placeAt(place, paths);
}
