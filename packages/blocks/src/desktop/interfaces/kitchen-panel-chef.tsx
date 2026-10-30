import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import { ChefAvatar } from "./kitchen-avatar.tsx";
import type { TicketState } from "./kitchen-model.ts";

export const STATION_NAMES = {
	board: "Chopping board",
	grill: "Grill",
	stove: "Stove",
} as const;

/** The chef's face in a sheet header. */
export function ChefLeading({ agentId }: { agentId: string }) {
	return (
		<span className="grid size-11 place-items-center rounded-full border-(--gk-edge) border-2 bg-(--gk-plate-sunk)">
			<ChefAvatar agentId={agentId} size={34} />
		</span>
	);
}

/** A chef's status words and mark from its act (the line and its pane). */
export function chefActStatus(act: InterfaceAgentAct): {
	label: string;
	state: TicketState;
} {
	switch (act.act) {
		case "asking":
			return { label: "Needs you", state: "needs" };
		case "working":
			return { label: act.stalled ? "Stalled?" : "Cooking", state: "cooking" };
		case "blocked":
			return act.blockers[0]?.kind === "interrupted"
				? { label: "Pulled", state: "burnt" }
				: { label: "Burnt order", state: "burnt" };
		case "limited":
			return { label: "86'd", state: "limited" };
		case "delivering":
			return { label: "Dish ready", state: "ready" };
		case "waiting":
			return { label: "Waiting", state: "queued" };
		default:
			return { label: "Idle", state: "served" };
	}
}
