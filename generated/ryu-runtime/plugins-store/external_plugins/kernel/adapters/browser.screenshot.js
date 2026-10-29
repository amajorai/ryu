// Capability adapter for `browser.control / browser.screenshot` backed by Kernel.
// Injected globals: `input`, `defaults`, `callTool`, and `callNamed`.
// This flat fragment runs inside Core's generated async adapter IIFE.
//
// Kernel has no shared "active tab": each browser is a Kernel session, and the
// session id IS the canonical tab_id that browser.navigate and browser.tabs return.

const sessionId = typeof input.tab_id === "string" ? input.tab_id.trim() : "";
if (!sessionId) {
	return { error: "tab_id is required; it is the Kernel browser session id from browser.navigate or browser.tabs" };
}
const raw = await callTool({ session_id: sessionId, actions: [{ type: "screenshot" }] });
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
