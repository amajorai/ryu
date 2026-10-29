// The on-screen generative UI window: draws the Island chat's live screen on the
// desktop. Main sizes the window beside the Island and keeps it click-through;
// this page captures the mouse only while the pointer is over the card, hugs the
// card to the window edge facing the Island, and reports submit/close back.

import { IslandLiveSurface } from "@ryu/blocks/island/chat/live-surface";
import { cn } from "@ryu/ui/lib/utils";
import { useCallback, useEffect, useState } from "react";
import type { ScreenSurfaceRenderState } from "../../shared/screen-surface.ts";
import { useIslandTheme } from "../hooks/use-island-theme.ts";

const surfaceApi = window.islandSurface;

export function ScreenSurfaceApp() {
	useIslandTheme(surfaceApi.theme);
	const [state, setState] = useState<ScreenSurfaceRenderState | null>(null);

	useEffect(() => {
		const unsubscribe = surfaceApi.onState(setState);
		surfaceApi.ready();
		return unsubscribe;
	}, []);

	const surface = state?.surface ?? null;
	// A card that animates away never fires pointerleave; release the mouse so
	// the hidden window can never swallow clicks.
	useEffect(() => {
		if (!surface) {
			surfaceApi.setMouseCapture(false);
		}
	}, [surface]);

	const dismiss = useCallback(() => {
		surfaceApi.setMouseCapture(false);
		surfaceApi.dismiss();
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				dismiss();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [dismiss]);

	return (
		<main
			className={cn(
				"flex h-screen w-screen px-6 py-3",
				state?.anchor === "bottom" ? "items-end" : "items-start"
			)}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: pointer capture only toggles click-through; the card's controls carry their own semantics. */}
			<div
				className="flex max-h-full w-full flex-col"
				onPointerEnter={() => surfaceApi.setMouseCapture(true)}
				onPointerLeave={() => surfaceApi.setMouseCapture(false)}
			>
				<IslandLiveSurface
					className="max-h-full bg-popover/95 shadow-2xl backdrop-blur-xl"
					onDismiss={dismiss}
					onSubmit={(value) => surfaceApi.submit(value)}
					surface={surface}
					updating={state?.updating ?? false}
				/>
			</div>
		</main>
	);
}
