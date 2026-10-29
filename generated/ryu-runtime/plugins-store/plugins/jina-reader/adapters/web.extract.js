// Capability adapter for `web.extract / web.extract`, run in Core's plugin sandbox.
// Injected globals: `input`, `defaults`, `callTool(args)` and `callNamed(id, args)`.
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE.

if (parsePrimitiveText(input.url) === undefined) {
	throw new TypeError("web.extract requires an HTTP or HTTPS URL");
}
let target;
try {
	target = new URL(input.url);
} catch {
	throw new TypeError("web.extract requires an HTTP or HTTPS URL");
}
if (
	(target.protocol !== "http:" && target.protocol !== "https:") ||
	target.username ||
	target.password
) {
	throw new TypeError("web.extract requires an HTTP or HTTPS URL without credentials");
}
const host = target.hostname.toLowerCase().replace(/\.+$/, "");
const octets = host.split(".").map(Number);
const privateIpv4 =
	octets.length === 4 &&
	octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
	(octets[0] === 0 ||
		octets[0] === 10 ||
		octets[0] === 127 ||
		octets[0] >= 224 ||
		(octets[0] === 169 && octets[1] === 254) ||
		(octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
		(octets[0] === 192 && octets[1] === 168));
if (
	privateIpv4 ||
	host === "localhost" ||
	host.endsWith(".localhost") ||
	host.endsWith(".local") ||
	host.endsWith(".internal") ||
	host === "[::]" ||
	host === "[::1]" ||
	host.startsWith("[fc") ||
	host.startsWith("[fd") ||
	host.startsWith("[::ffff:") ||
	/^\[fe[89ab][0-9a-f]:/.test(host) ||
	host.startsWith("[ff")
) {
	throw new TypeError("web.extract cannot send a local or private URL to Jina Reader");
}

// Core decodes tool replies with native JSON.parse. The string content parser
// below establishes the extract payload contract directly.
const request = { url: target.href, Accept: "application/json" };
// Reader selects its output with `X-Respond-With`. Its default (no header) is
// already main-content Markdown, so only the two other canonical formats are
// forwarded; `markdown` keeps that default rather than switching to Reader's
// non-readability `markdown` mode.
if (input.format === "html" || input.format === "text") {
	request["X-Respond-With"] = input.format;
}
const res = await callTool(request);
if (
	!res ||
	res.code !== 200 ||
	!res.data ||
	(parsePrimitiveText(res.data.warning) !== undefined &&
		/^Target URL returned error [45]\d\d/.test(res.data.warning)) ||
	parsePrimitiveText(res.data.content) === undefined
) {
	return { raw: res };
}
return {
	results: [{
		url: parsePrimitiveText(res.data.url) !== undefined ? res.data.url : target.href,
		title: parsePrimitiveText(res.data.title) !== undefined ? res.data.title : null,
		content: res.data.content,
		raw: res.data,
	}],
};

// Decode with the native String internal-slot check; boxed strings remain
// non-text inputs. This flat sandbox fragment needs no module imports.
function parsePrimitiveText(value) {
	try {
		const parsed = String.prototype.valueOf.call(value);
		return parsed === value ? parsed : undefined;
	} catch {
		return undefined;
	}
}
