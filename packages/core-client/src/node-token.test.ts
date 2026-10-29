import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	isLocalCoreUrl,
	nodeAuthTokenPath,
	resolveLocalNodeToken,
	ryuHomeDir,
} from "./node-token.ts";

const LOCAL = "http://127.0.0.1:7980";

const SAVED = { ...process.env };

function reset() {
	for (const key of [
		"RYU_DIR",
		"RYU_PROFILE",
		"XDG_CONFIG_HOME",
		"APPDATA",
		"RYU_TOKEN",
		"RYU_CORE_TOKEN",
	]) {
		delete process.env[key];
	}
}

beforeEach(reset);
afterEach(() => {
	reset();
	Object.assign(process.env, SAVED);
});

describe("ryuHomeDir", () => {
	it("gives each non-release profile its own directory", () => {
		// A `bun dev` stack must not read the INSTALLED release node's token —
		// that is the profile collision `RYU_PROFILE` exists to prevent.
		process.env.XDG_CONFIG_HOME = join(tmpdir(), "ryu-no-pointer-here");
		process.env.APPDATA = process.env.XDG_CONFIG_HOME;
		process.env.RYU_PROFILE = "dev";
		expect(ryuHomeDir().endsWith(".ryu-dev")).toBe(true);

		process.env.RYU_PROFILE = "release";
		expect(ryuHomeDir().endsWith(".ryu")).toBe(true);

		delete process.env.RYU_PROFILE;
		expect(ryuHomeDir().endsWith(".ryu")).toBe(true);
	});

	it("honours an explicit RYU_DIR and keeps the token in secrets/", () => {
		process.env.RYU_DIR = "/tmp/core-data";
		expect(ryuHomeDir()).toBe("/tmp/core-data");
		expect(nodeAuthTokenPath()).toBe(
			join("/tmp/core-data", "secrets", "node-auth.token")
		);
	});

	it("follows the Storage pointer when RYU_DIR is unset", () => {
		if (process.platform === "darwin") {
			return; // macOS config dir is not overridable from the environment.
		}
		const config = mkdtempSync(join(tmpdir(), "ryu-config-"));
		try {
			process.env.XDG_CONFIG_HOME = config;
			process.env.APPDATA = config;
			process.env.RYU_PROFILE = "dev";
			mkdirSync(join(config, "ryu-dev"), { recursive: true });
			writeFileSync(
				join(config, "ryu-dev", "data-path.json"),
				JSON.stringify({ data_dir: "/tmp/relocated" })
			);
			expect(ryuHomeDir()).toBe("/tmp/relocated");
			// RYU_DIR still wins over the pointer, exactly like Core.
			process.env.RYU_DIR = "/tmp/explicit";
			expect(ryuHomeDir()).toBe("/tmp/explicit");
		} finally {
			rmSync(config, { force: true, recursive: true });
		}
	});
});

describe("resolveLocalNodeToken", () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "ryu-token-"));
		process.env.RYU_DIR = home;
		mkdirSync(join(home, "secrets"));
	});

	afterEach(() => {
		rmSync(home, { force: true, recursive: true });
	});

	it("returns null when Core has not minted a token yet", () => {
		// The legitimate pre-first-boot state. Null means "send no bearer", which
		// is exactly what a Core with no token configured accepts.
		expect(resolveLocalNodeToken(LOCAL)).toBeNull();
	});

	it("reads the minted token file and trims it", () => {
		writeFileSync(join(home, "secrets", "node-auth.token"), "ryu_minted\n");
		expect(resolveLocalNodeToken(LOCAL)).toBe("ryu_minted");
	});

	it("treats an empty or whitespace-only file as no token", () => {
		writeFileSync(join(home, "secrets", "node-auth.token"), "   \n");
		expect(resolveLocalNodeToken(LOCAL)).toBeNull();
	});

	it("mirrors Core's precedence: RYU_CORE_TOKEN > RYU_TOKEN > file", () => {
		writeFileSync(join(home, "secrets", "node-auth.token"), "from-file");
		expect(resolveLocalNodeToken(LOCAL)).toBe("from-file");

		// An inherited node token (what a Core-spawned child sees) beats the file.
		process.env.RYU_TOKEN = "from-env";
		expect(resolveLocalNodeToken(LOCAL)).toBe("from-env");

		// The explicit per-surface override beats everything — this is how a TUI
		// is pointed at a REMOTE node whose token is not on this disk.
		process.env.RYU_CORE_TOKEN = "explicit-override";
		expect(resolveLocalNodeToken(LOCAL)).toBe("explicit-override");
	});
});

describe("isLocalCoreUrl", () => {
	it("accepts the loopback spellings Core actually binds", () => {
		expect(isLocalCoreUrl("http://127.0.0.1:7980")).toBe(true);
		expect(isLocalCoreUrl("http://localhost:7980")).toBe(true);
		expect(isLocalCoreUrl("http://LOCALHOST:7980/")).toBe(true);
		expect(isLocalCoreUrl("http://[::1]:7980")).toBe(true);
		// A trailing dot is the DNS root and resolves identically.
		expect(isLocalCoreUrl("http://localhost.:7980")).toBe(true);
	});

	it("rejects the userinfo bypass that would leak the token", () => {
		// The authority here is evil.com; `localhost:80` is USERINFO. Naive
		// prefix-trimming reads the host as `localhost` and would send this
		// machine's node secret to evil.com.
		expect(isLocalCoreUrl("http://localhost:80@evil.com/")).toBe(false);
		expect(isLocalCoreUrl("http://127.0.0.1@evil.com/")).toBe(false);
		expect(isLocalCoreUrl("http://user:pass@evil.com/")).toBe(false);
	});

	it("rejects lookalike hosts and unparseable input", () => {
		expect(isLocalCoreUrl("http://127.0.0.1.evil.com/")).toBe(false);
		expect(isLocalCoreUrl("http://localhost.evil.com/")).toBe(false);
		expect(isLocalCoreUrl("http://192.168.1.50:7980")).toBe(false);
		expect(isLocalCoreUrl("not a url")).toBe(false);
		expect(isLocalCoreUrl("")).toBe(false);
	});
});

describe("resolveLocalNodeToken locality gate", () => {
	let home2: string;

	beforeEach(() => {
		home2 = mkdtempSync(join(tmpdir(), "ryu-token-gate-"));
		process.env.RYU_DIR = home2;
		mkdirSync(join(home2, "secrets"));
		writeFileSync(join(home2, "secrets", "node-auth.token"), "minted-secret");
	});

	afterEach(() => {
		rmSync(home2, { force: true, recursive: true });
	});

	it("never sends the MINTED token to a remote node", () => {
		// `RYU_CORE_URL` is operator/attacker controlled. Sending the minted
		// node-admittance secret to a remote host would hand it full access to
		// this machine's Core.
		expect(resolveLocalNodeToken("http://192.168.1.50:7980")).toBeNull();
		expect(resolveLocalNodeToken("https://evil.com")).toBeNull();
		expect(resolveLocalNodeToken("http://localhost:80@evil.com/")).toBeNull();
		// ...but it is used for a genuinely local node.
		expect(resolveLocalNodeToken(LOCAL)).toBe("minted-secret");
	});

	it("fails closed when no URL is supplied", () => {
		expect(resolveLocalNodeToken()).toBeNull();
	});

	it("still sends an EXPLICIT token to a remote node", () => {
		// That is how an operator points a TUI at a remote node they hold the
		// token for; only the machine-local mint is gated.
		process.env.RYU_CORE_TOKEN = "explicit-remote";
		expect(resolveLocalNodeToken("https://node.example.com")).toBe(
			"explicit-remote"
		);
	});
});
