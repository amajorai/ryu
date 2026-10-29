// Capability adapter for `browser.control / browser.snapshot` backed by Steel.
// Injected globals: `input`, `defaults`, `callTool`, and `callNamed`.
// This flat fragment runs inside Core's generated async adapter IIFE.
//
// Steel has no shared "active tab": every page lives in a Steel session, and the
// session handle IS the canonical tab_id that browser.navigate returns.

const sessionId = typeof input.tab_id === "string" ? input.tab_id.trim() : "";
if (!sessionId) {
	return { error: "tab_id is required; it is the Steel session id from browser.navigate" };
}
// Steel's snapshot already carries @eN references in the same shape the
// canonical verb promises, so the provider result passes through unchanged.
return await callTool({ session_id: sessionId });
