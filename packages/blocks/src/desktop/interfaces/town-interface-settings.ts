import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { useEffect, useState } from "react";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { SPEED_OF, speedName } from "./town-interface-layout.tsx";
import type { TownDataView } from "./town-palette.ts";

type TownProps = InterfaceRendererProps<InterfaceParamsByRenderer["town"]>;

/**
 * The town's data view and speed settings.
 */
export function useTownSettings(
	params: TownProps["params"],
	port: TownProps["port"]
) {
	// The data view and the speed are settings: the HUD's controls change them
	// at once and save them through the port, and a change from Settings
	// (new params) takes over.
	const paramDataView: TownDataView = params?.dataView ?? "none";
	const paramSpeed = params?.speed ?? "auto";
	const [dataView, setDataView] = useState<TownDataView>(paramDataView);
	const [speed, setSpeed] = useState<number | null>(
		paramSpeed === "auto" ? null : SPEED_OF[paramSpeed]
	);
	useEffect(() => {
		setDataView(paramDataView);
	}, [paramDataView]);
	useEffect(() => {
		// A choice the mayor just made (and saved) stands; only "auto" leaves the
		// speed to the reduced-motion default.
		setSpeed((current) => {
			if (current !== null && speedName(current) === paramSpeed) {
				return current;
			}
			return paramSpeed === "auto" ? null : SPEED_OF[paramSpeed];
		});
	}, [paramSpeed]);
	const chooseDataView = (next: TownDataView) => {
		setDataView(next);
		port.updateSettings?.({ dataView: next });
	};
	const chooseSpeed = (next: number) => {
		setSpeed(next);
		port.updateSettings?.({ speed: speedName(next) });
	};
	return { chooseDataView, chooseSpeed, dataView, speed };
}
