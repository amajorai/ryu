// Capability adapter for `browser.control / browser.tabs` backed by Kernel.
// Injected globals: `input`, `defaults`, `callTool`, and `callNamed`.
// This flat fragment runs inside Core's generated async adapter IIFE.
//
// Kernel has no shared "active tab": each browser is a Kernel session, and the
// session id IS the canonical tab_id that browser.navigate and browser.tabs return.

const raw = await callTool({ action: "list", status: "active" });
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
if (!Array.isArray(parsed?.items)) {
	return { raw };
}
const tabs = [];
for (const browser of parsed.items) {
	if (typeof browser?.session_id !== "string") {
		continue;
	}
	tabs.push({
		id: browser.session_id,
		// Kernel reports the session, not its current page, so the start URL is the
		// best URL it knows; a session without a name is titled by its id.
		url: typeof browser.start_url === "string" ? browser.start_url : "",
		title: typeof browser.name === "string" && browser.name ? browser.name : browser.session_id,
	});
}
return { tabs, has_more: parsed.has_more === true };
