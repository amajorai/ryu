// Capability adapter for `browser.control / browser.navigate` backed by Steel.
// Injected globals: `input`, `defaults`, `callTool`, and `callNamed`.
// This flat fragment runs inside Core's generated async adapter IIFE.
//
// Steel has no shared "active tab": every page lives in a Steel session, and the
// session handle IS the canonical tab_id that browser.navigate returns.

const url = typeof input.url === "string" ? input.url.trim() : "";
if (!url) {
	return { error: "url is required" };
}
const failed = (result) =>
	!result || result.isError === true || Boolean(result.error) || result.available === false;

// The canonical browser.navigate schema takes only `url` and means "open this URL
// in a new tab", so every call starts a new Steel session. Steel bills it until it
// is released or reaches its inactivity timeout.
const created = await callNamed("steel.steel_session_create", {});
if (failed(created)) {
	return { raw: created };
}
const sessionId = created.structuredContent?.session_id;
if (typeof sessionId !== "string" || !sessionId) {
	return { raw: created };
}

const raw = await callTool({ session_id: sessionId, url });
if (failed(raw)) {
	return { tab_id: sessionId, raw };
}
const structured = raw.structuredContent ?? {};
return {
	tab_id: sessionId,
	url: typeof structured.final_url === "string" ? structured.final_url : url,
	title: typeof structured.title === "string" ? structured.title : undefined,
	navigated: structured.navigated,
	raw,
};
