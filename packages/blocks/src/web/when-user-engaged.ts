/**
 * Inputs that show a visitor is engaging with the page. Captured on `window`, so
 * a scroll inside any scroller counts too; passive, so none of them delays the
 * browser's own handling.
 */
const ENGAGEMENT_EVENTS = [
	"keydown",
	"pointerdown",
	"pointermove",
	"scroll",
	"touchstart",
	"wheel",
] as const;

const LISTENER_OPTIONS: AddEventListenerOptions = {
	capture: true,
	passive: true,
};

/**
 * Run `task` once the visitor first interacts with the page (moves or presses a
 * pointer, touches, types, or scrolls), so decorative motion starts on
 * engagement instead of competing with the page load. A page that already has
 * sticky user activation (the visitor clicked or typed earlier in this document,
 * for example to reach it through a client-side navigation) runs `task` right
 * away. Returns a cancel function, and is a no-op on the server.
 */
export function whenUserEngaged(task: () => void): () => void {
	if (typeof window === "undefined") {
		return noop;
	}
	if (navigator.userActivation?.hasBeenActive === true) {
		task();
		return noop;
	}
	const stopListening = () => {
		for (const type of ENGAGEMENT_EVENTS) {
			window.removeEventListener(type, onEngage, LISTENER_OPTIONS);
		}
	};
	function onEngage() {
		stopListening();
		task();
	}
	for (const type of ENGAGEMENT_EVENTS) {
		window.addEventListener(type, onEngage, LISTENER_OPTIONS);
	}
	return stopListening;
}

function noop(): void {
	// Nothing was scheduled.
}
