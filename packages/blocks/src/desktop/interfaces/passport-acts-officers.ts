import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import {
	actBubble,
	actKey,
	type BudgetItem,
	bubbleOverlayId,
	SHORT_BUBBLE_SECONDS,
	WORK_BUBBLE_SECONDS,
} from "./game3d-acts.ts";
import { apprenticeSpecs } from "./game3d-apprentice.tsx";
import {
	LIFE_FACE_CAMERA,
	type LifeAction,
	type LifeScript,
	type LifeStep,
} from "./game3d-life.ts";
import type { Vec3 } from "./game3d-palette.ts";
import type { MemberLooks, VillagerSpec } from "./game3d-villager.tsx";
import type { DeskLayout, DeskStation } from "./passport-desk.tsx";

/** Where an agent's villager stands: on its tab. */
export function officerAt(station: DeskStation): Vec3 {
	return station.at;
}

/** An officer's stance for its act (it stays on its tab). */
function officerAction(act: InterfaceAgentAct): LifeAction {
	switch (act.act) {
		case "asking":
			return act.carry === null ? "wave" : "look";
		case "blocked":
			return "slump";
		case "working":
			return act.stalled ? "idle" : "work";
		case "waiting":
			return "look";
		default:
			return "idle";
	}
}

/**
 * The officer's script: at its tab, its stance and its act's bubble (a
 * work bubble fades after 6 s and is left out under reduced motion). On a
 * phone (`narrow`) a delivery says nothing: its page set down on the
 * customs desk carries it, and its bubble would cover the next tabs.
 */
export function officerLife(
	act: InterfaceAgentAct,
	station: Vec3,
	reduced: boolean,
	narrow = false
): LifeScript {
	const bubble = actBubble(act);
	const steps: LifeStep[] = [
		{ bubble: null, do: "say" },
		{ at: station, do: "place", facing: LIFE_FACE_CAMERA },
		{ action: officerAction(act), do: "pose" },
	];
	const work = act.act === "working";
	// Blocked and limited officers say nothing: their alarm or limit note
	// carries the words (one overlay, spec 4.1 item 2).
	const speaks =
		act.act === "asking" ||
		(act.act === "delivering" && !narrow) ||
		act.act === "waiting" ||
		(work && !reduced && !act.stalled);
	if (bubble && speaks) {
		let seconds: number | undefined;
		if (work || act.act === "waiting") {
			seconds = WORK_BUBBLE_SECONDS;
		} else if (act.act === "delivering") {
			seconds = SHORT_BUBBLE_SECONDS;
		}
		steps.push({ bubble, do: "say", seconds });
	}
	if (act.act === "blocked") {
		steps.push({ do: "effect", effect: "smoke" });
	}
	return {
		idle: [{ do: "wait", seconds: 5 }],
		key: actKey(act, { paths: { links: [], points: {} }, station: "tab" }),
		steps,
	};
}

/** The officers as act villagers (plus their helpers), named by their acts. */
export function actOfficers({
	acts,
	layout,
	looks,
	narrow = false,
	onAsk,
	reduced,
	shown,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	layout: DeskLayout;
	looks: ReadonlyMap<string, MemberLooks>;
	/** A phone's stage: icon plates, and no delivery bubbles. */
	narrow?: boolean;
	onAsk: (askId: string) => void;
	reduced: boolean;
	shown: ReadonlySet<string>;
}): VillagerSpec[] {
	const cast: VillagerSpec[] = [];
	for (const station of layout.stations) {
		const agentId = station.country?.agent.id;
		const act = agentId ? acts.get(agentId) : undefined;
		const look = agentId ? looks.get(agentId) : undefined;
		if (!(act && look)) {
			continue;
		}
		const at = officerAt(station);
		const asking = act.act === "asking" && act.ask ? act.ask : null;
		const bubbleId = bubbleOverlayId(act);
		cast.push({
			actAgent: act.agentId,
			activate: asking ? () => onAsk(asking.id) : undefined,
			bubble: bubbleId ? shown.has(bubbleId) : true,
			// Bubbles hang outward, off the booklet's pages: up from a back
			// tab, to the side from a side tab.
			bubbleSide: station.edge === "top" ? "up" : station.edge,
			facing: LIFE_FACE_CAMERA,
			id: act.agentId,
			label: asking
				? `${act.ariaLabel} Answer their ask.`
				: `${act.ariaLabel} Apply for a visa.`,
			life: officerLife(act, at, reduced, narrow),
			looks: look,
			name: act.agentName,
			pose: "idle",
			position: at,
		});
		cast.push(
			...apprenticeSpecs({
				agentId: act.agentId,
				helpers: act.helpers,
				looks: look,
				station: at,
			})
		);
	}
	return cast;
}

/**
 * The narrowest room (px) where a spread's side tabs have space for a work
 * bubble hung outward and its back row's clip strip for alarm words. A
 * spread squeezed beside a sheet is narrower: its bubble would push the
 * plate onto a page, and alarm words parted in the strip would slide onto
 * the pages.
 */
export const ROOMY_DESK = 1024;

/**
 * Whether the desk keeps an act overlay, so no plate or bubble covers the
 * printed page (the notes' rule). A phone (icon-only plates) drops every
 * work bubble (working, waiting, delivering): an officer stands on a tab
 * hard by the page. A spread short of `ROOMY_DESK` drops a side tab's work
 * bubble, which hangs outward and would push its plate onto a page; a back
 * tab's still rises off the booklet. The words stay in the plate's label.
 */
export function deskKeeps(
	item: BudgetItem,
	layout: DeskLayout,
	{ iconOnly, roomy }: { iconOnly: boolean; roomy: boolean }
): boolean {
	if (item.kind !== "work-bubble") {
		return true;
	}
	if (iconOnly) {
		return false;
	}
	if (roomy) {
		return true;
	}
	const agentId = item.id.slice(item.id.indexOf(":") + 1);
	return !layout.stations.some(
		(station) => station.edge !== "top" && station.country?.agent.id === agentId
	);
}
