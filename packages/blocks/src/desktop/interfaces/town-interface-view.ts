import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { type RefObject, useEffect, useMemo } from "react";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { agentSchedule, buildingFor, type Town } from "./town-model.ts";
import type { TownPanelView } from "./town-panel.tsx";
import type { TownCamera } from "./town-scene.tsx";

type TownProps = InterfaceRendererProps<InterfaceParamsByRenderer["town"]>;

/**
 * What the town's sheet is about (an open conversation or a selected
 * building), and the agent the camera keeps in view.
 */
export function useTownPanelView({
	activeThreadId,
	cameraRef,
	selectedId,
	snapshot,
	threadView,
	town,
}: {
	activeThreadId: TownProps["activeThreadId"];
	cameraRef: RefObject<TownCamera | null>;
	selectedId: string | null;
	snapshot: TownProps["snapshot"];
	threadView: TownProps["threadView"];
	town: Town;
}) {
	const threadOpen = threadView !== null;
	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const selected = buildingFor(town, selectedId);
	const threadBuilding =
		selected && activeThread?.agentIds.includes(selected.agent.id)
			? selected
			: buildingFor(town, activeThread?.agentIds[0]);
	const names = useMemo(
		() => new Map(town.districts.map((item) => [item.id, item.name])),
		[town.districts]
	);

	let view: TownPanelView | null = null;
	if (threadOpen) {
		view = {
			building: threadBuilding,
			districtName: threadBuilding
				? names.get(threadBuilding.districtId)
				: undefined,
			kind: "thread",
			thread: activeThread,
		};
	} else if (selected) {
		view = {
			building: selected,
			districtName: names.get(selected.districtId) ?? "",
			kind: "building",
			schedule: agentSchedule(snapshot.events, selected.agent.id),
		};
	}
	const viewKey = view
		? `${view.kind}:${selectedId ?? ""}:${activeThreadId ?? ""}`
		: "";
	// The sheet's building: the camera glides to it when the sheet opens.
	const sheetLot = view?.building?.lot;
	const sheetLotX = sheetLot?.x;
	const sheetLotZ = sheetLot?.z;
	useEffect(() => {
		if (sheetLotX === undefined || sheetLotZ === undefined) {
			return;
		}
		// After the stage has refitted beside the sheet.
		const frame = requestAnimationFrame(() =>
			cameraRef.current?.focus({ x: sheetLotX, z: sheetLotZ, zoom: 2.1 })
		);
		return () => cancelAnimationFrame(frame);
	}, [cameraRef, sheetLotX, sheetLotZ]);
	const focusedId =
		view?.kind === "thread"
			? (view.building?.agent.id ?? null)
			: (selected?.agent.id ?? null);

	return { focusedId, threadBuilding, threadOpen, view, viewKey };
}
