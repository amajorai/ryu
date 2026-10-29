// Capability adapter for `browser.control / browser.screenshot` backed by Steel.
// Injected globals: `input`, `defaults`, `callTool`, and `callNamed`.
// This flat fragment runs inside Core's generated async adapter IIFE.
//
// Steel has no shared "active tab": every page lives in a Steel session, and the
// session handle IS the canonical tab_id that browser.navigate returns.

const sessionId = typeof input.tab_id === "string" ? input.tab_id.trim() : "";
if (!sessionId) {
	return { error: "tab_id is required; it is the Steel session id from browser.navigate" };
}
const raw = await callTool({ session_id: sessionId });
if (!raw || raw.isError === true || raw.error || raw.available === false) {
	return { raw };
}
const image = raw.content?.find((item) => item?.type === "image");
if (!image) {
	return { raw };
}
return {
	tab_id: sessionId,
	image: { data: image.data, mimeType: image.mimeType },
	raw,
};
