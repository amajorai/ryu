import { useEffect } from "react";

// Bridges the main process's global cursor poll into the DOM so the logo "eyes"
// can track the pointer across the entire screen.
//
// The shared logo component (`@ryu/ui` <Logo variant="eyes">) gazes by listening
// for window `mousemove` events. A click-through window only receives those while
// the pointer is physically over it, so the eyes would freeze the moment the
// cursor leaves the small island. The main process polls the OS cursor and pushes
// window-relative coordinates here; we replay each as a synthetic `mousemove` with
// matching `clientX`/`clientY`, which the logo's existing listener consumes with
// no change to the shared component. When the pointer really is over the window
// the native move also fires with identical coords, so the two agree.
export function useEyeCursor(): void {
	useEffect(() => {
		const unsubscribe = window.island.window.onCursorMove(({ x, y }) => {
			window.dispatchEvent(
				new MouseEvent("mousemove", {
					clientX: x,
					clientY: y,
					bubbles: true,
				})
			);
		});
		return unsubscribe;
	}, []);
}
