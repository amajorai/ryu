// Reader/writer for the shared multi-node config at ~/.ryu/nodes.json, ported
// from apps/cli/src/nodes.rs so the TUI switches nodes against the same file the
// Rust CLI uses.
//
// Schema (no serde renames - on-disk keys equal the field names):
//   { "default": "<active node name>", "nodes": [ { name, url, token, mesh? } ] }
// There is no id and no per-node active flag - the active node is the one whose
// `name` equals the top-level `default`. A missing or unparseable file falls back
// to a synthesized `local` node (matching nodes.rs default_config).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ApiTarget } from "@ryuhq/core-client/client";

const LOCAL_NODE_URL = "http://127.0.0.1:2049";
const HEALTH_TIMEOUT_MS = 1000;

export interface MeshAddr {
	magic_dns_name?: string | null;
	socks5: string;
}

export interface Node {
	mesh?: MeshAddr | null;
	name: string;
	token: string | null;
	url: string;
}

export interface NodesConfig {
	default: string;
	nodes: Node[];
}

/** ~/.ryu/nodes.json, resolving the home dir like the Rust CLI (USERPROFILE then HOME). */
export function nodesPath(): string {
	const home = process.env.USERPROFILE || process.env.HOME || ".";
	return join(home, ".ryu", "nodes.json");
}

/** The synthesized default when no config exists (mirrors nodes.rs default_config). */
export function defaultConfig(): NodesConfig {
	return {
		default: "local",
		nodes: [{ name: "local", url: LOCAL_NODE_URL, token: null }],
	};
}

/** Load the node config, falling back to the default on any read/parse error. */
export function loadNodes(): NodesConfig {
	try {
		const parsed = JSON.parse(
			readFileSync(nodesPath(), "utf8")
		) as Partial<NodesConfig>;
		if (!(Array.isArray(parsed.nodes) && parsed.nodes.length > 0)) {
			return defaultConfig();
		}
		return {
			default: typeof parsed.default === "string" ? parsed.default : "local",
			nodes: parsed.nodes,
		};
	} catch {
		return defaultConfig();
	}
}

/** The node an ApiTarget should point at right now. */
export function nodeToTarget(node: Node): ApiTarget {
	return { url: node.url, token: node.token ?? null };
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
	writeFileSync(path, JSON.stringify(config, null, 2));
}

/** GET {url}/api/health with a 1s timeout and bearer token, matching nodes.rs. */
export async function healthCheck(target: ApiTarget): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
	try {
		const headers: Record<string, string> = {};
		if (target.token) {
			headers.Authorization = `Bearer ${target.token}`;
		}
		const res = await fetch(`${target.url}/api/health`, {
			headers,
			signal: controller.signal,
		});
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}
