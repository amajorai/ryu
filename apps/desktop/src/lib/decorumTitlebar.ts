// Tauri decorum injects Windows/Linux caption buttons as a sibling DOM overlay
// (`[data-tauri-decorum-tb]`), separate from the React title bar. Auto-hide only
// slides the React chrome unless we mirror that peek state onto this overlay.
// Decorum also re-asserts a full-width native titlebar on focus/maximize/resize,
// so the layout fix must re-run on those events and preserve tuck visibility.

export const TITLEBAR_HIDDEN_CLASS = "ryu-titlebar-hidden";

const DECORUM_TRANSITION =
	"opacity 240ms ease-out, transform 280ms cubic-bezier(0.34,1.2,0.64,1)";

/** Toggle the document flag that tucks Decorum caption buttons with the title bar. */
export function setTitlebarHidden(hidden: boolean): void {
	document.documentElement.classList.toggle(TITLEBAR_HIDDEN_CLASS, hidden);
	applyDecorumChrome();
}

/** Reposition Decorum's overlay and sync opacity with auto-hide tuck state. */
export function applyDecorumChrome(): void {
	const container = document.querySelector("[data-tauri-decorum-tb]");
	const dragRegion = document.querySelector(
		"[data-tauri-decorum-tb] [data-tauri-drag-region]"
	);
	if (dragRegion) {
		dragRegion.remove();
	}
	if (!(container instanceof HTMLElement)) {
		return;
	}

	const hidden = document.documentElement.classList.contains(
		TITLEBAR_HIDDEN_CLASS
	);

	container.style.setProperty("top", "16px", "important");
	container.style.setProperty("right", "12px", "important");
	container.style.setProperty("left", "auto", "important");
	container.style.setProperty("width", "auto", "important");
	container.style.setProperty("pointer-events", "none", "important");
	container.style.setProperty("transition", DECORUM_TRANSITION, "important");
	container.style.setProperty("opacity", hidden ? "0" : "1", "important");
	container.style.setProperty(
		"transform",
		hidden ? "translateY(calc(-100% - 12px))" : "none",
		"important"
	);

	const buttonEvents = hidden ? "none" : "auto";
	for (const btn of container.querySelectorAll<HTMLElement>(
		"button, .decorum-tb-btn"
	)) {
		btn.style.setProperty("pointer-events", buttonEvents, "important");
	}
}
