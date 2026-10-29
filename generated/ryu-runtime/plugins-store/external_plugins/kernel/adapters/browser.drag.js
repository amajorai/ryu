// Capability adapter for `browser.control / browser.drag` backed by Kernel.
// Injected globals: `input`, `defaults`, `callTool`, and `callNamed`.
// This flat fragment runs inside Core's generated async adapter IIFE.
//
// Kernel has no shared "active tab": each browser is a Kernel session, and the
// session id IS the canonical tab_id that browser.navigate and browser.tabs return.

const sessionId = typeof input.tab_id === "string" ? input.tab_id.trim() : "";
if (!sessionId) {
	return { error: "tab_id is required; it is the Kernel browser session id from browser.navigate or browser.tabs" };
}
const point = (value) =>
	value && Number.isFinite(value.x) && Number.isFinite(value.y) ? [value.x, value.y] : undefined;
const from = point(input.from);
const to = point(input.to);
if (!from || !to) {
	return { error: "from and to must both be {x, y} viewport coordinates" };
}
return await callTool({
	session_id: sessionId,
	actions: [{ type: "drag_mouse", drag_mouse: { path: [from, to] } }],
});
