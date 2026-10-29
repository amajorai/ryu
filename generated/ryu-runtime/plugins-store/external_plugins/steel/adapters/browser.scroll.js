// Capability adapter for `browser.control / browser.scroll` backed by Steel.
// Injected globals: `input`, `defaults`, `callTool`, and `callNamed`.
// This flat fragment runs inside Core's generated async adapter IIFE.
//
// Steel has no shared "active tab": every page lives in a Steel session, and the
// session handle IS the canonical tab_id that browser.navigate returns.
//
// Steel's scroll action is a vertical mouse wheel whose `value` is a signed
// pixel distance; it has no horizontal axis, so left/right are refused.

const sessionId = typeof input.tab_id === "string" ? input.tab_id.trim() : "";
if (!sessionId) {
	return { error: "tab_id is required; it is the Steel session id from browser.navigate" };
}
if (input.direction !== "up" && input.direction !== "down") {
	return { error: "Steel scrolls vertically only; direction must be up or down" };
}
const amount =
	typeof input.amount === "number" && Number.isFinite(input.amount) && input.amount > 0
		? Math.round(input.amount)
		: 600;
const signed = input.direction === "up" ? -amount : amount;
return await callTool({ session_id: sessionId, action: "scroll", value: String(signed) });
