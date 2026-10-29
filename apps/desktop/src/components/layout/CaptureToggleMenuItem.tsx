// Future User Nav control for Shadow's device-local capture pipeline.
//
// NavUser keeps the import/render commented while this quick toggle is disabled.
// Reusing useShadowCapture preserves the same persisted pause state and Shadow
// request path used by the Companion and Shadow settings surfaces.

import { DropdownMenuItem } from "@ryu/ui/components/dropdown-menu.tsx";
import { Pause, Play } from "lucide-react";
import { useState } from "react";
import { useShadowCapture } from "@/src/hooks/useShadowCapture.ts";

export function CaptureToggleMenuItem() {
	const { paused, ready, setPaused, shadowReachable } = useShadowCapture();
	const [busy, setBusy] = useState(false);

	if (!ready || shadowReachable !== true) {
		return null;
	}

	const toggle = async () => {
		setBusy(true);
		try {
			await setPaused(!paused);
		} finally {
			setBusy(false);
		}
	};

	return (
		<DropdownMenuItem
			disabled={busy}
			onClick={() => toggle().catch(() => undefined)}
		>
			{paused ? (
				<Play className="mr-2 size-4" />
			) : (
				<Pause className="mr-2 size-4" />
			)}
			{paused ? "Resume Capture" : "Pause Capture"}
		</DropdownMenuItem>
	);
}
