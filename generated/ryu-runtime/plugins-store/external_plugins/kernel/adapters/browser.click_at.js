// Capability adapter for `browser.control / browser.click_at` backed by Kernel.
// Injected globals: `input`, `defaults`, `callTool`, and `callNamed`.
// This flat fragment runs inside Core's generated async adapter IIFE.
//
// Kernel has no shared "active tab": each browser is a Kernel session, and the
// session id IS the canonical tab_id that browser.navigate and browser.tabs return.

const sessionId = typeof input.tab_id === "string" ? input.tab_id.trim() : "";
if (!sessionId) {
	return { error: "tab_id is required; it is the Kernel browser session id from browser.navigate or browser.tabs" };
}
if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) {
	return { error: "x and y are required viewport coordinates" };
}
const click = { x: input.x, y: input.y };
if (input.button === "left" || input.button === "middle" || input.button === "right") {
	click.button = input.button;
}
if (Number.isInteger(input.count) && input.count >= 1 && input.count <= 3) {
	click.num_clicks = input.count;
}
return await callTool({
	session_id: sessionId,
	actions: [{ type: "click_mouse", click_mouse: click }],
});
