import { useLiteralMessages } from "@ryu/i18n/react";
import { Landmark } from "lucide-react";
import { GameSheet } from "./game-shell.tsx";
import { TownDeskBody } from "./town-desk.tsx";
import type { TownInterfaceHudProps } from "./town-interface-hud.tsx";
import { plural, upcomingRuns } from "./town-model.ts";

/** City Hall as the kit sheet: the petitions (or the asks) and the town. */
export function TownHallSheet({
	activeThreadId,
	actsOn,
	dataView,
	deskQueue,
	focusedId,
	hear,
	loading,
	palette,
	petitionsRef,
	sceneTown,
	selectBuilding,
	setDeskOpen,
	showDistrict,
	showHall,
	snapshot,
	tally,
	town,
}: Pick<
	TownInterfaceHudProps,
	| "activeThreadId"
	| "actsOn"
	| "dataView"
	| "deskQueue"
	| "focusedId"
	| "hear"
	| "loading"
	| "palette"
	| "petitionsRef"
	| "sceneTown"
	| "selectBuilding"
	| "setDeskOpen"
	| "showDistrict"
	| "showHall"
	| "snapshot"
	| "tally"
	| "town"
>) {
	const tl = useLiteralMessages();
	return (
		<GameSheet
			closeLabel="Close City Hall"
			data-town-panel="hall"
			label="City Hall"
			leading={
				<span
					aria-hidden="true"
					className="grid size-9 place-items-center rounded-xl border-(--gk-edge) border-2 bg-(--gk-accent) text-(--gk-accent-ink)"
				>
					<Landmark className="size-5" strokeWidth={2.25} />
				</span>
			}
			onClose={() => setDeskOpen(false)}
			subtitle={
				actsOn
					? tl("{needYou} need you", { needYou: String(tally.needYou) })
					: plural(town.petitions.length, "petition")
			}
			title="City Hall"
		>
			<div className="flex min-h-full flex-col">
				<TownDeskBody
					activeThreadId={activeThreadId}
					actQueue={deskQueue}
					dataView={dataView}
					headingRef={petitionsRef}
					loading={loading}
					onAgent={selectBuilding}
					onDistrict={showDistrict}
					onHall={showHall}
					onHear={hear}
					palette={palette}
					selectedId={focusedId}
					town={sceneTown}
					upcoming={upcomingRuns(snapshot.events)}
				/>
			</div>
		</GameSheet>
	);
}
