// @ryuhq/protocol - one reading of a Core node base URL for every surface.
//
// A node URL reaches a surface as untrusted text: typed, scanned from a QR, or
// carried by a `ryu://nodes/connect` link a web page fired. Two decisions hang
// on it: what a confirm dialog names as the server, and whether the signed-in
// account's JWT may travel there (`account-jwt-gate.ts`). Both must agree on
// which host the text names, so both read it through this parser.
//
// Written with plain string operations (no `URL`), like `deep-link.ts`, so the
// answer is the same in Node, browsers, the Tauri webview and React
// Native/Hermes, whose `URL` implementations differ on userinfo and
// international host names. The parser is strict: anything a WHATWG parser
// would reinterpret (userinfo, a backslash, whitespace, an escaped host
// character, a numeric host that is not a dotted quad) is refused, not guessed.

export type NodeUrlScheme = "http" | "https";

export interface NodeUrlParts {
	/**
	 * What a confirm dialog shows as the server: the lower-cased host with its
	 * port, IPv6 in brackets. Never userinfo, never a path. A punycode label
	 * (`xn--…`) stays in its ASCII form and is never rendered as the
	 * international name it encodes, so a look-alike name cannot pass as a
	 * trusted one.
	 */
	displayHost: string;
	/** Lower-cased host, IPv6 without brackets. */
	host: string;
	hostKind: "ipv4" | "ipv6" | "name";
	/** This device: `localhost`, `127.0.0.0/8` in dotted form, or `::1`. */
	loopback: boolean;
	/** The host has characters outside ASCII (an unencoded international name). */
	nonAscii: boolean;
	/** `scheme://host[:port]` with a default port dropped: one server, one key. */
	origin: string;
	/** Explicit port digits, or null when the URL names none. */
	port: string | null;
	/** A host label is punycode (`xn--…`). */
	punycode: boolean;
	scheme: NodeUrlScheme;
	/** The URL with scheme and host lower-cased; path, query and hash verbatim. */
	url: string;
}

const HTTP_URL = /^(https?):\/\/([^/?#]*)([/?#].*)?$/i;
const IPV6_BODY = /^[0-9a-f:.]+$/;
const PORT = /^\d{1,5}$/;
const IPV4_OCTET = /^(?:0|[1-9]\d{0,2})$/;
const ASCII_LABEL = /^[a-z0-9_-]+$/;
const NUMERIC_LABEL = /^(?:\d+|0x[0-9a-f]*)$/;
const DEFAULT_PORTS: Record<NodeUrlScheme, string> = {
	http: "80",
	https: "443",
};

/** A space, a control character or a backslash anywhere means "not a URL". */
function hasUnsafeCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code <= 32 || code === 127 || character === "\\") {
			return true;
		}
	}
	return false;
}

function splitAuthority(
	authority: string
): { host: string; ipv6: boolean; port: string | null } | null {
	if (authority.startsWith("[")) {
		const close = authority.indexOf("]");
		if (close <= 1) {
			return null;
		}
		const host = authority.slice(1, close);
		const tail = authority.slice(close + 1);
		if (!(IPV6_BODY.test(host) && host.includes(":"))) {
			return null;
		}
		if (tail === "") {
			return { host, ipv6: true, port: null };
		}
		return tail.startsWith(":")
			? { host, ipv6: true, port: tail.slice(1) }
			: null;
	}
	const colon = authority.indexOf(":");
	if (colon === -1) {
		return { host: authority, ipv6: false, port: null };
	}
	return {
		host: authority.slice(0, colon),
		ipv6: false,
		port: authority.slice(colon + 1),
	};
}

function isDottedQuad(labels: string[]): boolean {
	return (
		labels.length === 4 &&
		labels.every((label) => IPV4_OCTET.test(label) && Number(label) <= 255)
	);
}

/** "ascii", "non-ascii", or null when the label has a character no host has. */
function labelAlphabet(label: string): "ascii" | "non-ascii" | null {
	if (label === "") {
		return null;
	}
	let alphabet: "ascii" | "non-ascii" = "ascii";
	for (const character of label) {
		if (character.charCodeAt(0) > 127) {
			alphabet = "non-ascii";
		} else if (!ASCII_LABEL.test(character)) {
			return null;
		}
	}
	return alphabet;
}

interface HostClass {
	kind: NodeUrlParts["hostKind"];
	nonAscii: boolean;
	punycode: boolean;
}

/** Classify a non-IPv6 host, or null when it is not a host name we accept. */
function classifyHost(host: string): HostClass | null {
	// One trailing dot is the fully qualified spelling of the same name.
	const dotted = host.endsWith(".");
	const labels = (dotted ? host.slice(0, -1) : host).split(".");
	const alphabets = labels.map(labelAlphabet);
	if (alphabets.includes(null)) {
		return null;
	}
	if (!dotted && isDottedQuad(labels)) {
		return { kind: "ipv4", nonAscii: false, punycode: false };
	}
	// `2130706433`, `127.1` and `0x7f.1` are IPv4 addresses to a WHATWG parser.
	// Refuse them so the host shown is always the host connected to.
	if (NUMERIC_LABEL.test(labels.at(-1) ?? "")) {
		return null;
	}
	return {
		kind: "name",
		nonAscii: alphabets.includes("non-ascii"),
		punycode: labels.some((label) => label.startsWith("xn--")),
	};
}

function validPort(port: string | null): boolean {
	return port === null || (PORT.test(port) && Number(port) <= 65_535);
}

function isLoopbackHost(host: string, kind: HostClass["kind"]): boolean {
	if (kind === "ipv6") {
		return host === "::1";
	}
	return kind === "ipv4" ? host.startsWith("127.") : host === "localhost";
}

/** Split a trimmed URL into scheme, authority and the verbatim remainder. */
function splitHttpUrl(
	value: string
): { authority: string; rest: string; scheme: NodeUrlScheme } | null {
	if (!value || hasUnsafeCharacter(value)) {
		return null;
	}
	const match = HTTP_URL.exec(value);
	const authority = match?.[2];
	// Userinfo is refused outright: the text before `@` is not the server.
	if (!authority || authority.includes("@")) {
		return null;
	}
	return {
		authority: authority.toLowerCase(),
		rest: match?.[3] ?? "",
		scheme: match?.[1]?.toLowerCase() === "https" ? "https" : "http",
	};
}

/**
 * Read an `http(s)` node base URL, or null when it is not one this module can
 * read without guessing. A URL with userinfo (`https://trusted@evil.tld`) is
 * always refused.
 */
export function parseNodeUrl(raw: string): NodeUrlParts | null {
	const url = splitHttpUrl(raw.trim());
	const split = url ? splitAuthority(url.authority) : null;
	if (!(url && split && validPort(split.port))) {
		return null;
	}
	const { host, ipv6, port } = split;
	const classified: HostClass | null = ipv6
		? { kind: "ipv6", nonAscii: false, punycode: false }
		: classifyHost(host);
	if (!classified) {
		return null;
	}
	const bracketed = ipv6 ? `[${host}]` : host;
	const displayHost = port === null ? bracketed : `${bracketed}:${port}`;
	const defaultPort = port === null || port === DEFAULT_PORTS[url.scheme];
	return {
		displayHost,
		host,
		hostKind: classified.kind,
		loopback: isLoopbackHost(host, classified.kind),
		nonAscii: classified.nonAscii,
		origin: `${url.scheme}://${defaultPort ? bracketed : displayHost}`,
		port,
		punycode: classified.punycode,
		scheme: url.scheme,
		url: `${url.scheme}://${displayHost}${url.rest}`,
	};
}

/**
 * The node URL a `ryu://nodes/connect` link may carry, or null. Stricter than
 * {@link parseNodeUrl}: the host must be ASCII, so an international name has to
 * arrive as punycode and is shown as punycode.
 */
export function parseLinkedNodeUrl(raw: string): NodeUrlParts | null {
	const parts = parseNodeUrl(raw);
	return parts && !parts.nonAscii ? parts : null;
}

/** The host a confirm dialog shows for a node URL, or null when unreadable. */
export function nodeDisplayHost(url: string): string | null {
	return parseLinkedNodeUrl(url)?.displayHost ?? null;
}

/** Whether two node URLs name the same server (scheme, host and port). */
export function sameNodeOrigin(left: string, right: string): boolean {
	const a = parseNodeUrl(left)?.origin;
	return a !== undefined && a === parseNodeUrl(right)?.origin;
}
