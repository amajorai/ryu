// Dispatch-layer tests for the `ryu node` subcommand (cli/commands.ts nodeCommand).
// It reads/writes the local ~/.ryu/nodes.json store, so every test redirects HOME +
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
import { join } from "node:path";
import { runCli } from "../cli/dispatch.ts";
import type { CliIO, CoreApi } from "../cli/types.ts";

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

function makeIo(): { io: CliIO; out: () => string; err: () => string } {
	let outBuf = "";
	let errBuf = "";
	return {
		io: {
			out: (s) => {
				outBuf += s;
			},
			err: (s) => {
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

function seedNodes(config: {
	default: string;
	nodes: { name: string; url: string; token: string | null }[];
}): void {
	mkdirSync(join(tempHome, ".ryu"), { recursive: true });
	writeFileSync(
		join(tempHome, ".ryu", "nodes.json"),
		JSON.stringify(config, null, 2),
		"utf8"
	);
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
	const parsed = JSON.parse(cap.out()) as {
		active: string;
		nodes: { name: string }[];
	};
	expect(parsed.active).toBe("prod");
	expect(parsed.nodes).toHaveLength(2);
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
	expect((JSON.parse(reread.out()) as { active: string }).active).toBe("prod");
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
