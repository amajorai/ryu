// packages/services/src/transport/user-agent.ts
//
// `User-Agent: ryu-services/<version> (<runtime>)`, sent only from server
// runtimes (Node, Bun, Deno, Cloudflare workerd). Browsers never get it: a
// custom User-Agent is not CORS-safelisted everywhere and would trigger a
// preflight, and the browser's own value is more useful to the server anyway.

import { SDK_VERSION } from "../version.ts";

/** The globals the runtime check reads; injectable for tests. */
export interface RuntimeGlobals {
	Bun?: { version?: string };
	Deno?: { version?: { deno?: string } };
	document?: unknown;
	/** Present in dedicated, shared and service workers (WorkerGlobalScope). */
	importScripts?: unknown;
	navigator?: { userAgent?: string };
	process?: { versions?: { node?: string } };
	window?: unknown;
}

/** The server runtime and version, such as `node/22.1.0`, or null in a browser or unknown host. */
export function detectServerRuntime(
	globals: RuntimeGlobals = globalThis as RuntimeGlobals
): string | null {
	if (globals.Bun) {
		return `bun/${globals.Bun.version ?? "unknown"}`;
	}
	if (globals.Deno) {
		return `deno/${globals.Deno.version?.deno ?? "unknown"}`;
	}
	if (globals.navigator?.userAgent === "Cloudflare-Workers") {
		return "workerd";
	}
	if (
		globals.process?.versions?.node &&
		!(globals.window !== undefined && globals.document !== undefined)
	) {
		return `node/${globals.process.versions.node}`;
	}
	return null;
}

/**
 * Whether the code runs in a browser: a page (a window with a document) or a
 * web worker (`importScripts`), and no server runtime. Code in a web or
 * service worker ships to the visitor just as page code does.
 */
export function isBrowserRuntime(
	globals: RuntimeGlobals = globalThis as RuntimeGlobals
): boolean {
	const page = globals.window !== undefined && globals.document !== undefined;
	const worker = typeof globals.importScripts === "function";
	return (page || worker) && detectServerRuntime(globals) === null;
}

/**
 * The User-Agent to send, or null when none should be sent: in a browser, on
 * an unknown runtime, or when the caller passed `userAgent: false`. A string
 * `extra` is appended after the SDK's own product token.
 */
export function serverUserAgent(
	extra: string | false | undefined,
	globals: RuntimeGlobals = globalThis as RuntimeGlobals
): string | null {
	if (extra === false) {
		return null;
	}
	const runtime = detectServerRuntime(globals);
	if (runtime === null) {
		return null;
	}
	const base = `ryu-services/${SDK_VERSION} (${runtime})`;
	return extra ? `${base} ${extra}` : base;
}
