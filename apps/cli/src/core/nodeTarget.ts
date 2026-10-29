// Which Core node one CLI invocation (or the TUI) talks to, resolved through the
// saved node registry (`<data dir>/state/nodes.json`, see nodes.ts) so that
// `ryu node use <name>` and the TUI node picker actually change the target.
//
// Precedence:
//   1. `--node <ref>`: a saved node whose name is `ref`, then one whose URL is
//      `ref` (each with its own saved token); otherwise an http(s) URL used as
//      given with the RYU_CORE_TOKEN bearer. Anything else is an
//      UnknownNodeError, never a bogus URL.
//   2. RYU_CORE_URL (with RYU_CORE_TOKEN): the explicit per-process override.
//   3. The active node (`default` in nodes.json), falling back like
//      resolveActive to the first saved node or the synthesized local node.
//
// A saved node with no token of its own is sent RYU_CORE_TOKEN only when its URL
// is one the env token was already sent to before node resolution existed: this
// profile's local Core (DEFAULT_CORE_URL) or RYU_CORE_URL. RYU_CORE_TOKEN is a
// per-node admittance secret, so any other tokenless saved node gets no bearer,
// the same as when it is picked in the TUI node picker (nodeToTarget).

import type { ApiTarget } from "@ryuhq/core-client/client";
import { withCoreIdentityCheck } from "./coreIdentity.ts";
import { DEFAULT_CORE_URL } from "./defaultCoreUrl.ts";
import {
	loadNodes,
	type Node,
	type NodesConfig,
	nodeToTarget,
	resolveActive,
} from "./nodes.ts";

export interface NodeTargetEnvironment {
	readonly RYU_CORE_TOKEN?: string;
	readonly RYU_CORE_URL?: string;
	readonly [key: string]: string | undefined;
}

/** A `--node` value that names no saved node and is not an http(s) URL. */
export class UnknownNodeError extends Error {
	readonly configured: readonly string[];
	readonly ref: string;

	constructor(ref: string, configured: readonly string[]) {
		const saved = configured.length > 0 ? configured.join(", ") : "none";
		super(
			`No saved node named or at '${ref}'. Saved nodes: ${saved}. Pass a saved node name (see 'ryu node ls') or an http(s) URL.`
		);
		this.name = "UnknownNodeError";
		this.ref = ref;
		this.configured = configured;
	}
}

/** True for an absolute `http:` or `https:` URL with a host. */
export function isHttpNodeUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			url.host.length > 0
		);
	} catch {
		return false;
	}
}

const comparableUrl = (url: string): string => url.trim().replace(/\/+$/, "");

/** The saved node `ref` names: exact name first, then URL (trailing `/` ignored). */
export function findSavedNode(
	ref: string,
	config: NodesConfig
): Node | undefined {
	const byName = config.nodes.find((node) => node.name === ref);
	if (byName) {
		return byName;
	}
	const wanted = comparableUrl(ref);
	return config.nodes.find((node) => comparableUrl(node.url) === wanted);
}

function envToken(environment: NodeTargetEnvironment): string | null {
	return environment.RYU_CORE_TOKEN?.trim() || null;
}

/** True when `url` is a target RYU_CORE_TOKEN was meant for (see file header). */
function isEnvTokenTarget(
	url: string,
	environment: NodeTargetEnvironment
): boolean {
	const wanted = comparableUrl(url);
	if (wanted === comparableUrl(DEFAULT_CORE_URL)) {
		return true;
	}
	const envUrl = environment.RYU_CORE_URL?.trim();
	return envUrl ? wanted === comparableUrl(envUrl) : false;
}

function savedNodeTarget(
	node: Node,
	environment: NodeTargetEnvironment
): ApiTarget {
	const target = nodeToTarget(node);
	if (target.token === null && isEnvTokenTarget(node.url, environment)) {
		// Re-wrap with the env token: the transport nodeToTarget built was
		// gated for a tokenless target.
		const { fetch: _tokenlessTransport, ...bare } = target;
		return withCoreIdentityCheck({ ...bare, token: envToken(environment) });
	}
	return target;
}

/** Resolve the target for an optional `--node <name|url>` (see file header). */
export function resolveNodeTarget(
	nodeRef: string | null,
	config: NodesConfig = loadNodes(),
	environment: NodeTargetEnvironment = process.env
): ApiTarget {
	const ref = nodeRef?.trim() ?? "";
	if (ref) {
		const saved = findSavedNode(ref, config);
		if (saved) {
			return savedNodeTarget(saved, environment);
		}
		if (isHttpNodeUrl(ref)) {
			return withCoreIdentityCheck({ url: ref, token: envToken(environment) });
		}
		throw new UnknownNodeError(
			ref,
			config.nodes.map((node) => node.name)
		);
	}
	const envUrl = environment.RYU_CORE_URL?.trim();
	if (envUrl) {
		return withCoreIdentityCheck({ url: envUrl, token: envToken(environment) });
	}
	return savedNodeTarget(resolveActive(config), environment);
}
