// Sidecar status + capture controls wrapper. The presentational body now lives
// in @ryu/blocks/island (`SidecarStatusView`); this file wires the live sidecar
// snapshot + start/pause handlers from the island bridge.

import { SidecarStatusView } from "@ryu/blocks/island/sidecar-status";
import { useCallback, useState } from "react";
import { useSidecarStatus } from "../hooks/use-sidecar-status.ts";

/** Status + capture controls. `contextReadAllowed` gates all Shadow access. */
export function SidecarStatus({
	contextReadAllowed,
}: {
	contextReadAllowed: boolean;
}) {
	const { snapshot, startShadow, starting, refresh } =
		useSidecarStatus(contextReadAllowed);
	const [pausing, setPausing] = useState(false);

	const togglePause = useCallback(async (): Promise<void> => {
		setPausing(true);
		try {
			await window.island.shadow.setCaptureControl({
				paused: !snapshot.paused,
			});
			await refresh();
		} finally {
			setPausing(false);
		}
	}, [snapshot.paused, refresh]);

	return (
		<SidecarStatusView
			contextReadAllowed={contextReadAllowed}
			onStartShadow={() => startShadow()}
			onTogglePause={() => togglePause()}
			pausing={pausing}
			snapshot={{
				coreUp: snapshot.coreUp,
				shadowUp: snapshot.shadowUp,
				recording: snapshot.recording,
				paused: snapshot.paused,
			}}
			starting={starting}
		/>
	);
}
