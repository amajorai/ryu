import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import type { PlanetSystem } from "./planets-model.ts";
import { STAR_ID } from "./planets-overlay.tsx";
import type { PlanetsPanelView } from "./planets-panel.tsx";

/**
 * What the panel shows and where the camera looks, from the selection and
 * the open thread.
 */
export function planetsView({
	activeThreadId,
	selection,
	snapshot,
	system,
	threadOpen,
}: {
	activeThreadId: string | null;
	selection: string | null;
	snapshot: InterfaceSnapshot;
	system: PlanetSystem;
	threadOpen: boolean;
}) {
	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const selectedPlanet = system.planets.find(
		(planet) => planet.id === selection
	);
	// The open thread belongs to the planet it was opened from, else to its
	// first agent's planet.
	const threadPlanet =
		selectedPlanet && activeThread?.agentIds.includes(selectedPlanet.id)
			? selectedPlanet
			: system.planets.find((planet) =>
					activeThread?.agentIds.includes(planet.id)
				);

	let view: PlanetsPanelView | null = null;
	if (threadOpen) {
		view = { kind: "thread", planet: threadPlanet, thread: activeThread };
	} else if (selectedPlanet) {
		view = { kind: "planet", planet: selectedPlanet };
	} else if (selection === STAR_ID) {
		view = { kind: "star" };
	}
	let focusId: string | null = selectedPlanet ? selectedPlanet.id : selection;
	if (threadOpen) {
		focusId = threadPlanet?.id ?? STAR_ID;
	}
	return { focusId, threadPlanet, view };
}
