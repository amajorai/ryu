import { useLiteralMessages } from "@ryu/i18n/react";
import { Line, Solid } from "../../kit/react/draw.tsx";
import { DECK_ART, DECK_CART, SHELF_ART, SHELF_CARTS } from "./geometry.ts";
import { CoreEnginesLive } from "./live.tsx";
import {
	ALONGSIDE,
	DEFAULT_ENGINE,
	ENGINE_COUNT,
	engineAt,
	HEALTH_INTERVAL_S,
	SWEEP_SPEEDUP,
} from "./model.ts";
import { slotOf } from "./view.ts";

const SHELF = (
	<g key="shelf">
		<Solid crease="none" flat paths={SHELF_ART.body} tone="lo" />
		<Line d={SHELF_ART.slots} tone="faint" />
	</g>
);

const SLOTS = SHELF_CARTS.map((paths, slot) => (
	<g
		data-slot={slot}
		key={`slot-${slot}`}
		style={slot === slotOf(DEFAULT_ENGINE) ? { display: "none" } : undefined}
	>
		<Solid className="ce-body" crease="none" paths={paths} tone="lo" />
	</g>
));

const DECK = (
	<g key="deck">
		<Solid crease="none" flat paths={DECK_ART.body} tone="lo" />
	</g>
);

const CARRIED = <Solid crease="none" lit paths={DECK_CART} tone="hi" />;

const ALONGSIDE_NAMES = ALONGSIDE.map(
	(slot) => `${slot.name.toLowerCase()} (${slot.detail})`
).join(", ");

export function CoreEnginesArt() {
	const tl = useLiteralMessages();
	const description = tl(
		"A shelf of cartridges standing for the {engineCount} local chat engines Ryu Core supports (a few are drawn), and beside it a player holding the one engine that is loaded, {defaultEngineName} by default. Core keeps at most one local chat engine loaded: choosing another first takes the loaded one back to its slot, then brings the new one to the player. Engines for {alongsideNames} run alongside the chat engine and are never swapped, so they are not on the shelf. A faint ring on the player pulses once per health check; Core checks every {healthIntervalSeconds} seconds, shown {sweepSpeedup} times faster. Arrow keys choose an engine and Enter loads it.",
		{
			alongsideNames: ALONGSIDE_NAMES,
			defaultEngineName: engineAt(DEFAULT_ENGINE).name,
			engineCount: String(ENGINE_COUNT),
			healthIntervalSeconds: String(HEALTH_INTERVAL_S),
			sweepSpeedup: String(SWEEP_SPEEDUP),
		}
	);
	return (
		<CoreEnginesLive
			carried={CARRIED}
			deck={DECK}
			description={description}
			pulse={DECK_ART.pulse}
			pulseCentre={DECK_ART.pulseCentre}
			shelf={SHELF}
			slots={SLOTS}
		/>
	);
}
