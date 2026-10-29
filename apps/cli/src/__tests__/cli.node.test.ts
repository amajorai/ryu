// Dispatch-layer tests for the `ryu node` subcommand (cli/builtins/session.ts nodeCommand).
// It reads/writes the local ~/.ryu/state/nodes.json store, so every test redirects HOME +
// USERPROFILE to a fresh temp dir — the same isolation the nodes.ts unit tests use —
// and never touches the real home. The CoreApi is unused by this command (it is a
// purely local store), so a rejecting stub proves no network call is made.

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { z } from "zod";
import { runCli } from "../cli/dispatch.ts";
import type { CliIO, CoreApi } from "../cli/types.ts";
import { type NodesConfig, nodesPath } from "../core/nodes.ts";

const nodeListOutputSchema = z.looseObject({
	active: z.string(),
	nodes: z.array(
		z.looseObject({
			name: z.string(),
			url: z.string(),
			token: z.string().nullable(),
			mesh: z
				.looseObject({
					socks5: z.string(),
					magic_dns_name: z.string().nullable().optional(),
				})
				.nullable()
				.optional(),
		})
	),
});

let tempHome = "";
let savedHome: string | undefined;
let savedUserProfile: string | undefined;

beforeEach(() => {
	savedHome = process.env.HOME;
	savedUserProfile = process.env.USERPROFILE;
	tempHome = mkdtempSync(join(tmpdir(), "ryu-node-cmd-test-"));
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

function makeIo() {
	let outBuf = "";
	let errBuf = "";
	return {
		io: {
			out: (s: Parameters<CliIO["out"]>[0]) => {
				outBuf += s;
			},
			err: (s: Parameters<CliIO["err"]>[0]) => {
				errBuf += s;
			},
		},
		out: () => outBuf,
		err: () => errBuf,
	};
}

/** A CoreApi that rejects on every call — `ryu node` is a local store, so it must
 *  never reach the network. */
function noNetworkApi(): CoreApi {
	const reject = () =>
		Promise.reject(new Error("node command hit the network"));
	return {
		fetchApps: reject,
		fetchAppsCatalog: reject,
		installApp: reject,
		enableApp: reject,
		disableApp: reject,
		uninstallApp: reject,
		execAppCommand: () =>
			Promise.reject(new Error("unexpected execAppCommand")),
		streamChat: () => Promise.reject(new Error("unexpected streamChat")),
	};
}

/** Seed the registry where the command reads it (`<data dir>/state/nodes.json`
 *  under the temp home), so the test follows the shared data-dir layout. */
function seedNodes(config: NodesConfig): void {
	const path = nodesPath();
	if (!path.startsWith(tempHome)) {
		throw new Error(`nodes.json resolved outside the temp home: ${path}`);
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
}

// ── node ls ─────────────────────────────────────────────────────────────────

test("`node` with no subcommand defaults to ls and marks the active node with *", async () => {
	seedNodes({
		default: "prod",
		nodes: [
			{ name: "local", url: "http://l", token: null },
			{ name: "prod", url: "http://p", token: null },
		],
	});
	const cap = makeIo();
	const code = await runCli(["node"], { io: cap.io, api: noNetworkApi() });
	expect(code).toBe(0);
	expect(cap.out()).toContain("local");
	expect(cap.out()).toContain("prod");
	expect(cap.out()).toContain("*");
	expect(cap.err()).toBe("");
});

test("`node ls --json` emits the active name and the node list", async () => {
	seedNodes({
		default: "prod",
		nodes: [
			{ name: "local", url: "http://l", token: null },
			{ name: "prod", url: "http://p", token: "t" },
		],
	});
	const cap = makeIo();
	const code = await runCli(["node", "ls", "--json"], {
		io: cap.io,
		api: noNetworkApi(),
	});
	expect(code).toBe(0);
	const parsed = nodeListOutputSchema.parse(JSON.parse(cap.out()));
	expect(parsed.active).toBe("prod");
	expect(parsed.nodes).toHaveLength(2);
	// A saved node token is never printed, only that one exists.
	expect(cap.out()).not.toContain('"t"');
	expect(parsed.nodes.map((node) => node.token)).toEqual([null, "••••••"]);
});

test("`node ls` with no config file falls back to the synthesized local node", async () => {
	const cap = makeIo();
	const code = await runCli(["node", "ls"], {
		io: cap.io,
		api: noNetworkApi(),
	});
	expect(code).toBe(0);
	expect(cap.out()).toContain("local");
});

// ── node use ────────────────────────────────────────────────────────────────

test("`node use <name>` switches the active node and persists it", async () => {
	seedNodes({
		default: "local",
		nodes: [
			{ name: "local", url: "http://l", token: null },
			{ name: "prod", url: "http://p", token: null },
		],
	});
	const cap = makeIo();
	const code = await runCli(["node", "use", "prod"], {
		io: cap.io,
		api: noNetworkApi(),
	});
	expect(code).toBe(0);
	expect(cap.out()).toContain("Active node set to prod");
	// Persisted to the temp home (isolation proof + round-trip).
	const reread = makeIo();
	await runCli(["node", "ls", "--json"], {
		io: reread.io,
		api: noNetworkApi(),
	});
	expect(nodeListOutputSchema.parse(JSON.parse(reread.out())).active).toBe(
		"prod"
	);
});

test("`node use <url>` matches a node by its url", async () => {
	seedNodes({
		default: "local",
		nodes: [
			{ name: "local", url: "http://l", token: null },
			{ name: "prod", url: "http://prod:7980", token: null },
		],
	});
	const cap = makeIo();
	const code = await runCli(["node", "use", "http://prod:7980"], {
		io: cap.io,
		api: noNetworkApi(),
	});
	expect(code).toBe(0);
	expect(cap.out()).toContain("Active node set to prod");
});

test("`node use <unknown>` exits 1 and lists the configured names on stderr", async () => {
	seedNodes({
		default: "local",
		nodes: [{ name: "local", url: "http://l", token: null }],
	});
	const cap = makeIo();
	const code = await runCli(["node", "use", "ghost"], {
		io: cap.io,
		api: noNetworkApi(),
	});
	expect(code).toBe(1);
	expect(cap.err()).toContain("No configured node");
	expect(cap.err()).toContain("local");
	expect(cap.err()).toContain("--node <url>");
});

test("`node use` with no ref is a usage error (exit 2)", async () => {
	const cap = makeIo();
	const code = await runCli(["node", "use"], {
		io: cap.io,
		api: noNetworkApi(),
	});
	expect(code).toBe(2);
	expect(cap.err()).toContain("Usage");
});

test("`node <garbage>` subcommand is a usage error (exit 2)", async () => {
	const cap = makeIo();
	const code = await runCli(["node", "frobnicate"], {
		io: cap.io,
		api: noNetworkApi(),
	});
	expect(code).toBe(2);
	expect(cap.err()).toContain("Usage");
});

// ── target resolution reads the saved registry ──────────────────────────────

/** A CoreApi that records the target each `fetchApps` call is sent to. */
function recordingApi(): { api: CoreApi; targets: ApiTarget[] } {
	const targets: ApiTarget[] = [];
	return {
		targets,
		api: {
			...noNetworkApi(),
			fetchApps: (target) => {
				targets.push(target);
				return Promise.resolve([]);
			},
		},
	};
}

/** Run `fn` with RYU_CORE_URL / RYU_CORE_TOKEN unset, restoring them after. */
async function withoutCoreEnv(fn: () => Promise<void>): Promise<void> {
	const savedUrl = process.env.RYU_CORE_URL;
	const savedToken = process.env.RYU_CORE_TOKEN;
	delete process.env.RYU_CORE_URL;
	delete process.env.RYU_CORE_TOKEN;
	try {
		await fn();
	} finally {
		for (const [key, value] of [
			["RYU_CORE_URL", savedUrl],
			["RYU_CORE_TOKEN", savedToken],
		] as const) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

const PROD_NODES: NodesConfig = {
	default: "local",
	nodes: [
		{ name: "local", url: "http://127.0.0.1:7980", token: null },
		{ name: "prod", url: "https://prod.example.test", token: "prod-secret" },
	],
};

test("after `node use prod`, a one-shot command targets prod with its saved token", async () => {
	await withoutCoreEnv(async () => {
		seedNodes(PROD_NODES);
		await runCli(["node", "use", "prod"], {
			io: makeIo().io,
			api: noNetworkApi(),
		});
		const recorder = recordingApi();
		const code = await runCli(["list", "--json"], {
			io: makeIo().io,
			api: recorder.api,
		});
		expect(code).toBe(0);
		expect(recorder.targets).toEqual([
			{ url: "https://prod.example.test", token: "prod-secret" },
		]);
	});
});

test("`--node <name>` targets that saved node for one command without changing the active node", async () => {
	await withoutCoreEnv(async () => {
		seedNodes(PROD_NODES);
		const recorder = recordingApi();
		const code = await runCli(["--node", "prod", "list", "--json"], {
			io: makeIo().io,
			api: recorder.api,
		});
		expect(code).toBe(0);
		expect(recorder.targets[0]).toEqual({
			url: "https://prod.example.test",
			token: "prod-secret",
		});
		const listing = makeIo();
		await runCli(["node", "ls", "--json"], {
			io: listing.io,
			api: noNetworkApi(),
		});
		expect(nodeListOutputSchema.parse(JSON.parse(listing.out())).active).toBe(
			"local"
		);
	});
});

test("RYU_CORE_URL still overrides the saved active node", async () => {
	await withoutCoreEnv(async () => {
		seedNodes({ ...PROD_NODES, default: "prod" });
		process.env.RYU_CORE_URL = "http://env-node.example.test:7980";
		const recorder = recordingApi();
		await runCli(["list", "--json"], {
			io: makeIo().io,
			api: recorder.api,
		});
		expect(recorder.targets[0]).toEqual({
			url: "http://env-node.example.test:7980",
			token: null,
		});
	});
});

test("`--node <unknown name>` is a usage error that names the saved nodes and makes no call", async () => {
	await withoutCoreEnv(async () => {
		seedNodes(PROD_NODES);
		const cap = makeIo();
		const recorder = recordingApi();
		const code = await runCli(["--node", "staging", "list"], {
			io: cap.io,
			api: recorder.api,
		});
		expect(code).toBe(2);
		expect(cap.err()).toContain("No saved node named or at 'staging'");
		expect(cap.err()).toContain("local, prod");
		expect(recorder.targets).toEqual([]);
	});
});
