// Capability adapter for `browser.control / browser.key` backed by Kernel.
// Injected globals: `input`, `defaults`, `callTool`, and `callNamed`.
// This flat fragment runs inside Core's generated async adapter IIFE.
//
// Kernel has no shared "active tab": each browser is a Kernel session, and the
// session id IS the canonical tab_id that browser.navigate and browser.tabs return.
//
// The canonical verb takes key tokens pressed together (["cmd", "l"]); Kernel
// takes one X11 keysym chord per entry ("Ctrl+l"). Kernel browsers run on Linux,
// where the macOS Command shortcuts are Control shortcuts, so cmd maps to Ctrl.

const sessionId = typeof input.tab_id === "string" ? input.tab_id.trim() : "";
if (!sessionId) {
	return { error: "tab_id is required; it is the Kernel browser session id from browser.navigate or browser.tabs" };
}
if (!Array.isArray(input.keys) || input.keys.length === 0) {
	return { error: "keys must be a non-empty array of key tokens" };
}
const KEYSYMS = {
	cmd: "Ctrl",
	command: "Ctrl",
	ctrl: "Ctrl",
	control: "Ctrl",
	meta: "Super",
	super: "Super",
	win: "Super",
	alt: "Alt",
	option: "Alt",
	shift: "Shift",
	enter: "Return",
	return: "Return",
	esc: "Escape",
	escape: "Escape",
	tab: "Tab",
	space: "space",
	backspace: "BackSpace",
	delete: "Delete",
	del: "Delete",
	up: "Up",
	arrowup: "Up",
	down: "Down",
	arrowdown: "Down",
	left: "Left",
	arrowleft: "Left",
	right: "Right",
	arrowright: "Right",
	home: "Home",
	end: "End",
	pageup: "Page_Up",
	pagedown: "Page_Down",
};
const tokens = [];
for (const key of input.keys) {
	if (typeof key !== "string" || !key.trim()) {
		return { error: "every key token must be a non-empty string" };
	}
	const trimmed = key.trim();
	tokens.push(KEYSYMS[trimmed.toLowerCase()] ?? trimmed);
}
const chord = tokens.join("+");
const raw = await callTool({
	session_id: sessionId,
	actions: [{ type: "press_key", press_key: { keys: [chord] } }],
});
if (!raw || raw.isError === true || raw.error || raw.available === false) {
	return raw;
}
return { ok: true, tab_id: sessionId, chord, raw };
