// Capability adapter for `browser.control / browser.navigate` backed by Cloudflare Browser Run.
// Injected globals: `input`, `defaults`, `callTool`, and `callNamed`.
// This flat fragment runs inside Core's generated async adapter IIFE.

// Decode the JSON input as a string without coercing numbers, arrays, or objects.
function parseUrl(raw) {
	if (typeof raw !== "string") {
		throw new TypeError("Expected a string");
	}
	return raw.trim();
}

let url;
try {
	url = parseUrl(input.url);
} catch {
	url = "";
}
if (!url) {
	return { error: "url is required" };
}

const raw = await callTool({ url });
if (!raw || raw.isError || raw.error || raw.available === false) {
	return { raw };
}
const text = raw?.content?.find((item) => item?.type === "text")?.text;
if (!text && !raw.structuredContent) {
	return { raw };
}
let snapshot;
try {
	snapshot = raw.structuredContent ?? JSON.parse(text);
} catch {
	snapshot = { content: text ?? "" };
}
return {
	// The capability projects page content, not arbitrary provider-owned fields.
	// Preserve the complete response in raw and an opaque snapshot when it has no content.
	content: snapshot?.content === undefined ? snapshot : snapshot.content,
	// The caller-selected URL is the capability identity. Provider content is
	// untrusted and must not redirect the returned handle by shadowing these keys.
	tab_id: url,
	url,
	raw,
};
