// Capability adapter for `browser.control / browser.navigate` backed by Kernel.
// Injected globals: `input`, `defaults`, `callTool`, and `callNamed`.
// This flat fragment runs inside Core's generated async adapter IIFE.
//
// Kernel has no shared "active tab": each browser is a Kernel session, and the
// session id IS the canonical tab_id that browser.navigate and browser.tabs return.

const url = typeof input.url === "string" ? input.url.trim() : "";
if (!url) {
	return { error: "url is required" };
}

// The canonical browser.navigate schema takes only `url` and means "open this URL
// in a new tab", so every call creates a new Kernel browser on the URL. Kernel
// bills that browser until it is deleted or times out.
const raw = await callTool({ action: "create", start_url: url });
if (!raw || raw.isError === true || raw.error || raw.available === false) {
	return { raw };
}
const text = raw.content?.find((item) => item?.type === "text")?.text;
let parsed;
try {
	parsed = JSON.parse(text ?? "");
} catch {
	return { raw };
}
const browser = parsed?.browser;
const sessionId = typeof browser?.session_id === "string" ? browser.session_id : "";
if (!sessionId) {
	return { raw };
}
return {
	tab_id: sessionId,
	url,
	live_view_url:
		typeof browser.browser_live_view_url === "string" ? browser.browser_live_view_url : undefined,
	raw,
};
