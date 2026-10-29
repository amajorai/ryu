// Capability adapter for `browser.control / browser.screenshot` backed by Cloudflare Browser Run.
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
	url = parseUrl(input.tab_id);
} catch {
	url = "";
}
if (!url) {
	return { error: "tab_id is required; Cloudflare Browser Run uses the URL as the tab id" };
}

const raw = await callTool({ url });
if (!raw || raw.isError || raw.error || raw.available === false) {
	return { raw };
}
const image = raw?.content?.find((item) => item?.type === "image");
if (!image) {
	return { raw };
}
return {
	tab_id: url,
	url,
	image: image
		? { data: image.data, mimeType: image.mimeType }
		: undefined,
	raw,
};
