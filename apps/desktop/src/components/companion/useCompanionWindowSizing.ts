import { useEffect, useState } from "react";
import { isTauriReady } from "@/src/lib/tauri-ready.ts";
import {
	createCompanionSizingController,
	logicalCompanionFrame,
} from "./window-sizing.ts";

/** Observe intrinsic content, rather than the already constrained native viewport. */
export function useCompanionWindowSizing() {
	const [content, setContent] = useState<HTMLDivElement | null>(null);
	const [sizingError, setSizingError] = useState<string | null>(null);
	useEffect(() => {
		if (!content) {
			return;
		}
		let stopped = false;
		let frameId = 0;
		let disposeController: (() => void) | undefined;
		let unlistenMoved: (() => void) | undefined;
		const observer = new ResizeObserver(() => schedule());
		// A clipped element's border box can stay unchanged while its scroll
		// content grows (settings switch, streamed answer, Ghost confirmation).
		const mutations = new MutationObserver(() => schedule());
		const schedule = () => {
			cancelAnimationFrame(frameId);
			frameId = requestAnimationFrame(() => {
				if (stopped || !isTauriReady()) {
					return;
				}
				void initialize().catch(() => {
					if (!stopped) {
						setSizingError(
							"Companion could not fit its window. Reopen the overlay to retry."
						);
					}
				});
			});
		};
		let initialized:
			| Promise<ReturnType<typeof createCompanionSizingController>>
			| undefined;
		const initialize = async () => {
			initialized ??= import("@tauri-apps/api/window").then(
				async ({
					currentMonitor,
					getCurrentWindow,
					LogicalPosition,
					LogicalSize,
				}) => {
					const nativeWindow = getCurrentWindow();
					const controller = createCompanionSizingController({
						async readFrame() {
							const [monitor, position, size, scale] = await Promise.all([
								currentMonitor(),
								nativeWindow.outerPosition(),
								nativeWindow.innerSize(),
								nativeWindow.scaleFactor(),
							]);
							if (!(monitor && Number.isFinite(scale)) || scale <= 0) {
								throw new Error("Companion monitor is unavailable");
							}
							return logicalCompanionFrame(
								{
									position,
									size,
									workArea: {
										...monitor.workArea.position,
										...monitor.workArea.size,
									},
								},
								scale
							);
						},
						setSize: ({ width, height }) =>
							nativeWindow.setSize(new LogicalSize(width, height)),
						setPosition: ({ x, y }) =>
							nativeWindow.setPosition(new LogicalPosition(x, y)),
					});
					disposeController = controller.dispose;
					if (stopped) {
						controller.dispose();
						return controller;
					}
					const stopObservingMoves = await nativeWindow.onMoved(schedule);
					unlistenMoved = stopObservingMoves;
					if (stopped) {
						stopObservingMoves();
						controller.dispose();
					}
					return controller;
				}
			);
			const controller = await initialized;
			if (stopped) {
				return;
			}
			await controller.request(content.scrollHeight);
			if (!stopped) {
				setSizingError(null);
			}
		};
		observer.observe(content);
		mutations.observe(content, {
			subtree: true,
			childList: true,
			characterData: true,
			attributes: true,
			attributeFilter: ["hidden", "class"],
		});
		schedule();
		// Covers a bridge injected just after React mounts without polling forever.
		const readyRetry = window.setTimeout(schedule, 2000);
		return () => {
			stopped = true;
			observer.disconnect();
			mutations.disconnect();
			cancelAnimationFrame(frameId);
			window.clearTimeout(readyRetry);
			unlistenMoved?.();
			disposeController?.();
		};
	}, [content]);
	return { sizingRef: setContent, sizingError };
}
