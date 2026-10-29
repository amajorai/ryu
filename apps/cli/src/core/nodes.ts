// Reader/writer for the shared multi-node config at <data dir>/state/nodes.json, ported
// from apps/cli/src/nodes.rs so the TUI switches nodes against the same file the
// Rust CLI uses.
//
// Schema (no serde renames - on-disk keys equal the field names):
//   { "default": "<active node name>", "nodes": [ { name, url, token, mesh? } ] }
// There is no id and no per-node active flag - the active node is the one whose
// `name` equals the top-level `default`. A missing or unparseable file falls back
// to a synthesized `local` node at this profile's Core URL (matching Desktop's
// nodes.rs), and a saved `local` node still at the retired :2049 default is read
// at that URL too, the same migration Desktop applies on load.
//
// Tokens: saved node tokens are plaintext in this owner-only (0600) file, because
// this Bun CLI has no keychain access and reads it directly. A sealed envelope
// (`enc:v1:`, left by a Desktop build that sealed it; the current Desktop opens
// it and writes it back in plaintext) cannot be opened here: it is kept as an
// opaque `sealedToken`, written back unchanged, and never sent as a bearer. For
// such a node the CLI uses `RYU_CORE_TOKEN` when set.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	type ApiTarget,
	fetchForTarget,
	makeHeaders,
} from "@ryuhq/core-client/client";
import { z } from "zod";
import { type CliStateEnvironment, cliStatePath } from "./cliStatePath.ts";
import {
	isPlainHttpLoopback,
	rawFetchForTarget,
	requiresCoreIdentity,
	verifyCoreIdentity,
	withCoreIdentityCheck,
} from "./coreIdentity.ts";
import { DEFAULT_CORE_URL } from "./defaultCoreUrl.ts";

const LOCAL_NODE_URL = DEFAULT_CORE_URL;
/** The pre-profile default local URL; Desktop rewrites it on load, so do we. */
const LEGACY_LOCAL_NODE_URL = "http://127.0.0.1:2049";
const HEALTH_TIMEOUT_MS = 1000;
const meshAddressSchema = z.looseObject({
	socks5: z.string(),
	magic_dns_name: z.string().nullable().optional(),
});
const localNodeSchema = z.object({
	name: z.string(),
	url: z.string(),
	token: z.string().nullable().default(null),
	mesh: meshAddressSchema.nullable().optional(),
});
const nodesConfigSchema = z.object({
	default: z.string().catch("local"),
	nodes: z.array(localNodeSchema).min(1),
});

export interface MeshAddr {
	magic_dns_name?: string | null;
	socks5: string;
}

export interface Node {
	/** True for an org-managed node discovered from the control plane. These
	 * nodes are session-only and are never written to `nodes.json`. */
	managed?: boolean;
	mesh?: MeshAddr | null;
	name: string;
	/** Organization id returned with a control-plane managed-node delegation. */
	orgId?: string | null;
	/** A sealed envelope this CLI cannot open. Opaque: preserved, never sent. */
	sealedToken?: string;
	token: string | null;
	url: string;
	/** Short-lived, audience-bound delegation for one managed node. */
	userJwt?: string | null;
}

export interface NodesConfig {
	default: string;
	nodes: Node[];
}

/** `<data dir>/state/nodes.json` — the node registry shared with Desktop. */
export function nodesPath(
	environment: CliStateEnvironment = process.env
): string {
	return cliStatePath("nodes.json", environment);
}

/** The synthesized default when no config exists (mirrors nodes.rs default_config). */
export function defaultConfig(): NodesConfig {
	return {
		default: "local",
		nodes: [{ name: "local", url: LOCAL_NODE_URL, token: null }],
	};
}

/** Any Ryu at-rest envelope (`enc:v1:`, `encp:v1:`, `encc:v1:`, `enc:v2:`). */
const SEALED_TOKEN = /^enc[pc]?:v\d+:/;

/** True when `token` is a sealed envelope this CLI cannot open. */
export function isSealedToken(token: string | null | undefined): boolean {
	return typeof token === "string" && SEALED_TOKEN.test(token);
}

/** Load the node config, falling back to the default on any read/parse error. */
export function loadNodes(): NodesConfig {
	const path = nodesPath();
	try {
		const parsed = nodesConfigSchema.safeParse(
			JSON.parse(readFileSync(path, "utf8"))
		);
		if (!parsed.success) {
			return defaultConfig();
		}
		return {
			default: parsed.data.default,
			nodes: parsed.data.nodes.map((node) => {
				// Durable local storage intentionally drops managed delegations and authority fields.
				const local: Node = {
					name: node.name,
					url:
						node.name === "local" && node.url === LEGACY_LOCAL_NODE_URL
							? LOCAL_NODE_URL
							: node.url,
					token: isSealedToken(node.token) ? null : node.token,
				};
				if (node.token && isSealedToken(node.token)) {
					local.sealedToken = node.token;
				}
				if (node.mesh) {
					local.mesh = node.mesh;
				}
				return local;
			}),
		};
	} catch {
		return defaultConfig();
	}
}

/** The node an ApiTarget should point at right now. */
export function nodeToTarget(
	node: Node,
	environment: Record<string, string | undefined> = process.env
): ApiTarget {
	// A Desktop-sealed token cannot be opened here: fall back to the operator's
	// RYU_CORE_TOKEN rather than send the envelope as a bearer.
	const token =
		node.token ??
		(node.sealedToken ? environment.RYU_CORE_TOKEN?.trim() || null : null);
	const target: ApiTarget = { url: node.url, token };
	if (node.userJwt) {
		target.userJwt = node.userJwt;
	}
	return withCoreIdentityCheck(target);
}

/** Resolve the active node (config.default), falling back to the first/local node. */
export function resolveActive(config: NodesConfig): Node {
	return (
		config.nodes.find((node) => node.name === config.default) ??
		config.nodes[0] ?? { name: "local", url: LOCAL_NODE_URL, token: null }
	);
}

/** Persist a new active node by name (writes `default`), a no-op for unknown names. */
export function setActive(name: string): void {
	const config = loadNodes();
	if (!config.nodes.some((node) => node.name === name)) {
		return;
	}
	config.default = name;
	const path = nodesPath();
	mkdirSync(dirname(path), { recursive: true });
	// Stage + rename: an interrupted in-place write leaves truncated JSON, which
	// loadNodes() silently replaces with the default config, so the next write
	// would erase every saved node and its token. 0600 because tokens live here.
	const temporary = `${path}.${process.pid}.tmp`;
	const onDisk = {
		default: config.default,
		nodes: config.nodes.map(({ sealedToken, ...node }) => ({
			...node,
			token: sealedToken ?? node.token,
		})),
	};
	writeFileSync(temporary, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
	renameSync(temporary, path);
}

/** `ready`: Core answered (and, for a plain-HTTP loopback target with a node
 *  token, proved it holds that token). `down`: nothing healthy answered.
 *  `conflict`: something answers on the port but could not prove it is Core. */
export type CoreProbe = "ready" | "down" | "conflict";

/**
 * Probe the selected target with a 1s timeout. A plain-HTTP loopback target is
 * probed with no credential and, when it carries a node token, must then pass
 * the identity challenge before it counts as ready; any other target keeps its
 * node-bound credentials (TLS authenticates a remote server, and managed edges
 * require them).
 */
export async function probeCore(target: ApiTarget): Promise<CoreProbe> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
	try {
		if (!isPlainHttpLoopback(target.url)) {
			const res = await fetchForTarget(target)(`${target.url}/api/health`, {
				headers: makeHeaders(target.token, target.userJwt),
				signal: controller.signal,
			});
			return res.ok ? "ready" : "down";
		}
		// Liveness on loopback carries no credential of any kind.
		const fetcher = rawFetchForTarget(target);
		const res = await fetcher(`${target.url}/api/health`, {
			signal: controller.signal,
		});
		if (!res.ok) {
			return "down";
		}
		if (!requiresCoreIdentity(target)) {
			return "ready";
		}
		const verdict = await verifyCoreIdentity(target, controller.signal);
		if (verdict === "verified") {
			return "ready";
		}
		return verdict === "unreachable" ? "down" : "conflict";
	} catch {
		return "down";
	} finally {
		clearTimeout(timer);
	}
}

/** Whether the target is a healthy (and, where required, verified) Core. */
export async function healthCheck(target: ApiTarget): Promise<boolean> {
	return (await probeCore(target)) === "ready";
}
