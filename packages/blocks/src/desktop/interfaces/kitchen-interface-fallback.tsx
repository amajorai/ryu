import type { IsoInsets } from "./game3d-stage.tsx";
import type { KitchenService } from "./kitchen-model.ts";
import { KitchenLine, type KitchenLineActs } from "./kitchen-overlay.tsx";

/** Without WebGL the line is shown as a list between the HUD bands. */
export function KitchenLineFallback({
	actLayer,
	insets,
	onSelectChef,
	onServe,
	service,
}: {
	actLayer: KitchenLineActs | null;
	insets: IsoInsets;
	onSelectChef: (agentId: string) => void;
	onServe: (threadId: string) => void;
	service: KitchenService;
}) {
	return (
		<div
			className="absolute inset-x-0 overflow-y-auto bg-(--gk-backdrop) px-4"
			style={{ bottom: insets.bottom, top: insets.top }}
		>
			<KitchenLine
				actLayer={actLayer}
				onSelectChef={onSelectChef}
				onServe={onServe}
				service={service}
			/>
			<p className="mx-auto mt-4 max-w-2xl font-medium text-(--gk-ink-muted) text-sm">
				The 3D kitchen needs WebGL, which is off here, so the line is shown as a
				list.
			</p>
		</div>
	);
}
