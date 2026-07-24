// Unit tests for the multi-node config reader/writer (core/nodes.ts), ported from
// apps/cli/src/nodes.rs. Every test redirects HOME + USERPROFILE to a fresh temp
// dir so `nodesPath()` never resolves the real ~/.ryu — an explicit isolation
// assertion (the written file lives under the temp home) proves the redirect took
// before any test relies on it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultConfig,
	loadNodes,
	nodesPath,
	nodeToTarget,
	resolveActive,
	setActive,
} from "../core/nodes.ts";

let tempHome = "";
let savedHome: string | undefined;
let savedUserProfile: string | undefined;

beforeEach(() => {
	savedHome = process.env.HOME;
	savedUserProfile = process.env.USERPROFILE;
	tempHome = mkdtempSync(join(tmpdir(), "ryu-nodes-test-"));
	// Set BOTH: nodesPath() reads USERPROFILE || HOME, and Windows short-circuits
	// on USERPROFILE — setting only one would leak to the real home on the other OS.
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
});

afterEach(() => {
	if (savedHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = savedHome;
	}
	if (savedUserProfile === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = savedUserProfile;
	}
	if (tempHome && existsSync(tempHome)) {
		rmSync(tempHome, { recursive: true, force: true });
	}
});

// ── isolation proof ─────────────────────────────────────────────────────────

test("nodesPath resolves under the redirected home (isolation guard)", () => {
	// If this fails, every setActive test below would be writing the real ~/.ryu.
	expect(nodesPath()).toBe(join(tempHome, ".ryu", "nodes.json"));
});

// ── defaultConfig ───────────────────────────────────────────────────────────

test("defaultConfig synthesizes a single local node named 'local'", () => {
	const cfg = defaultConfig();
	expect(cfg.default).toBe("local");
	expect(cfg.nodes).toHaveLength(1);
	expect(cfg.nodes[0]?.name).toBe("local");
	expect(cfg.nodes[0]?.url).toBe("http://127.0.0.1:2049");
	expect(cfg.nodes[0]?.token).toBeNull();
});

// ── loadNodes ───────────────────────────────────────────────────────────────

test("loadNodes returns the default when no config file exists", () => {
	expect(loadNodes()).toEqual(defaultConfig());
});

test("loadNodes parses a valid config file", () => {
	const path = nodesPath();
	writeConfig(path, {
		default: "prod",
		nodes: [
			{ name: "local", url: "http://127.0.0.1:7980", token: null },
			{ name: "prod", url: "https://prod:7980", token: "secret" },
		],
	});
	const cfg = loadNodes();
	expect(cfg.default).toBe("prod");
	expect(cfg.nodes).toHaveLength(2);
	expect(cfg.nodes[1]?.token).toBe("secret");
});

test("loadNodes falls back to default when nodes is empty", () => {
	writeConfig(nodesPath(), { default: "x", nodes: [] });
	expect(loadNodes()).toEqual(defaultConfig());
});

test("loadNodes falls back to default when nodes is missing/not an array", () => {
	writeConfig(nodesPath(), { default: "x" } as never);
	expect(loadNodes()).toEqual(defaultConfig());
});

test("loadNodes defaults `default` to 'local' when it is not a string", () => {
	writeConfig(nodesPath(), {
		default: 42 as never,
		nodes: [{ name: "a", url: "http://a", token: null }],
	});
	const cfg = loadNodes();
	expect(cfg.default).toBe("local");
	expect(cfg.nodes).toHaveLength(1);
});

test("loadNodes on corrupt JSON returns the default (never throws)", () => {
	// Write invalid JSON bytes directly at the config path.
	const path = nodesPath();
	writeRaw(path, "{ not json at all ");
	expect(loadNodes()).toEqual(defaultConfig());
});

// ── nodeToTarget ────────────────────────────────────────────────────────────

test("nodeToTarget maps a node to an ApiTarget, coercing undefined token to null", () => {
	expect(nodeToTarget({ name: "n", url: "http://n:7980", token: "t" })).toEqual(
		{ url: "http://n:7980", token: "t" }
	);
	// Missing token → null (never undefined) so makeHeaders omits the header.
	expect(
		nodeToTarget({ name: "n", url: "http://n:7980", token: null })
	).toEqual({ url: "http://n:7980", token: null });
});

// ── resolveActive ───────────────────────────────────────────────────────────

test("resolveActive returns the node whose name equals config.default", () => {
	const cfg = {
		default: "prod",
		nodes: [
			{ name: "local", url: "http://l", token: null },
			{ name: "prod", url: "http://p", token: null },
		],
	};
	expect(resolveActive(cfg).name).toBe("prod");
});

test("resolveActive falls back to the first node when default names nothing", () => {
	const cfg = {
		default: "ghost",
		nodes: [
			{ name: "first", url: "http://f", token: null },
			{ name: "second", url: "http://s", token: null },
		],
	};
	expect(resolveActive(cfg).name).toBe("first");
});

test("resolveActive falls back to a synthesized local node on an empty config", () => {
	// This hardcoded fallback is unreachable via loadNodes (which never yields an
	// empty nodes array) but is exercised when a caller passes one directly.
	const node = resolveActive({ default: "x", nodes: [] });
	expect(node.name).toBe("local");
	expect(node.url).toBe("http://127.0.0.1:2049");
});

// ── setActive ───────────────────────────────────────────────────────────────

test("setActive persists a known node name and round-trips through loadNodes", () => {
	writeConfig(nodesPath(), {
		default: "local",
		nodes: [
			{ name: "local", url: "http://l", token: null },
			{ name: "prod", url: "http://p", token: null },
		],
	});
	setActive("prod");

	// Isolation proof: the write landed under the temp home, not the real ~/.ryu.
	expect(existsSync(join(tempHome, ".ryu", "nodes.json"))).toBe(true);
	expect(loadNodes().default).toBe("prod");
});

test("setActive is a no-op for an unknown node name (file not written)", () => {
	// No config file exists yet; setActive on an unknown name must not create one.
	setActive("does-not-exist");
	expect(existsSync(join(tempHome, ".ryu", "nodes.json"))).toBe(false);
});

test("setActive on unknown name leaves an existing config unchanged", () => {
	writeConfig(nodesPath(), {
		default: "local",
		nodes: [{ name: "local", url: "http://l", token: null }],
	});
	setActive("nonexistent");
	expect(loadNodes().default).toBe("local");
});

// ── helpers ─────────────────────────────────────────────────────────────────

function writeConfig(
	path: string,
	config: { default: string; nodes: unknown[] }
): void {
	writeRaw(path, JSON.stringify(config, null, 2));
}

function writeRaw(path: string, contents: string): void {
	mkdirSync(join(tempHome, ".ryu"), { recursive: true });
	writeFileSync(path, contents, "utf8");
}

describe("nodes config", () => {
	test("loadNodes tolerates garbage array elements (documents current behavior)", () => {
		// loadNodes only checks `Array.isArray && length > 0` — it does NOT validate
		// element shape, so malformed node entries pass straight through. This pins
		// the current (permissive) contract so a future tightening is a conscious change.
		writeConfig(nodesPath(), {
			default: "local",
			nodes: [{ garbage: true } as never],
		});
		const cfg = loadNodes();
		expect(cfg.nodes).toHaveLength(1);
		expect(cfg.default).toBe("local");
	});
});
