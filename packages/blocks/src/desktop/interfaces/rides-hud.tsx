import type {
	InterfaceAct,
	InterfaceAgentAct,
} from "@ryuhq/protocol/interfaces";
import { CarFront, Flag, Package, UserRound } from "lucide-react";
import { GameCounter, GameCounters } from "./game-hud.tsx";
import type { ActTotals } from "./game3d-acts.ts";

/**
 * The Rides HUD on the shared game kit: the counters a rider checks at a
 * glance, bottom right over the map (the trip panel holds the rest).
 */
export function RidesCounters({
	arrived,
	enRoute,
	free,
}: {
	arrived: number;
	enRoute: number;
	free: number;
}) {
	return (
		<GameCounters label="Ride counters">
			<GameCounter
				icon={<CarFront strokeWidth={2.5} />}
				label="under way"
				tone="info"
				value={enRoute}
			/>
			<GameCounter
				icon={<Flag strokeWidth={2.5} />}
				label="arrived"
				tone={arrived > 0 ? "warn" : "good"}
				value={arrived}
			/>
			<GameCounter
				icon={<UserRound strokeWidth={2.5} />}
				label={free === 1 ? "driver free" : "drivers free"}
				tone="good"
				value={free}
			/>
		</GameCounters>
	);
}

/**
 * The counters with the act layer: drivers working, parcels (answers)
 * waiting at the kerb, and drivers free. Trips "under way" and "arrived"
 * count conversations, not what the drivers are doing, so they go.
 */
export function RidesActCounters({
	acts,
	answers,
	totals,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	/**
	 * Answers ready to read: the reply asks, as the Queue counts them. The
	 * Arrived tab lists their trips, less any that a newer act (an ask, a
	 * stop, a run) has taken over.
	 */
	answers: number;
	totals: ActTotals;
}) {
	const count = (act: InterfaceAct) =>
		[...acts.values()].filter((item) => item.act === act).length;
	const parcels = answers;
	const free = count("idle");
	return (
		<GameCounters label="Ride counters">
			<GameCounter
				icon={<CarFront strokeWidth={2.5} />}
				label="working"
				tone="info"
				value={totals.working}
			/>
			<GameCounter
				icon={<Package strokeWidth={2.5} />}
				label={parcels === 1 ? "answer" : "answers"}
				tone={parcels > 0 ? "warn" : "good"}
				value={parcels}
			/>
			<GameCounter
				icon={<UserRound strokeWidth={2.5} />}
				label={free === 1 ? "driver free" : "drivers free"}
				tone="good"
				value={free}
			/>
		</GameCounters>
	);
}
