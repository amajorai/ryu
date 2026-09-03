// Capability adapter for `browser.control / browser.navigate` backed by Cloudflare Browser Run.
// Injected globals: `input`, `defaults`, `callTool`, and `callNamed`.
// This flat fragment runs inside Core's generated async adapter IIFE.

const url = typeof input.url === "string" ? input.url.trim() : "";
if (!url) {
	return { error: "url is required" };
}

const raw = await callTool({ url });
const text = raw?.content?.find((item) => item?.type === "text")?.text;
let snapshot;
try {
	snapshot = text ? JSON.parse(text) : raw;
} catch {
	snapshot = { content: text ?? "" };
}
return {
	tab_id: url,
	url,
	...(snapshot && typeof snapshot === "object" ? snapshot : { content: snapshot }),
	raw,
};
