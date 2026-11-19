// `secrets server --dev`: explicit opt-in, loopback-only binds, and a
// temporary data directory that is removed on exit while the real Ryu data
// directory stays untouched.
import { afterEach, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSecretsArgs } from "./secrets-args.ts";
import {
	DEFAULT_DEV_BIND,
	type DevServerHost,
	devCoreEnv,
	devServer,
	INTERRUPTED_EXIT,
	loopbackBind,
	realDevServerHost,
} from "./secrets-dev-server.ts";
import type { CliContext } from "./types.ts";

const cleanup: string[] = [];
afterEach(async () => {
	for (const path of cleanup.splice(0)) {
		await rm(path, { force: true, recursive: true });
	}
});

async function sandbox(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ryu-dev-server-test-"));
	cleanup.push(dir);
	return dir;
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

interface Harness {
	ctx: CliContext;
	err: string[];
	out: string[];
}

function harness(env: Record<string, string | undefined>): Harness {
	const out: string[] = [];
	const err: string[] = [];
	const ctx = {
		env,
		io: { err: (s: string) => err.push(s), out: (s: string) => out.push(s) },
	} as unknown as CliContext;
	return { ctx, err, out };
}

interface Recorded {
	host: DevServerHost;
	killed: string[];
	started: { bind: string; env: Record<string, string> }[];
	tempDirs: string[];
}

/** Real temp-dir seams with a fake Core that writes into its RYU_DIR. */
function recordingHost(options: { ready?: boolean } = {}): Recorded {
	const real = realDevServerHost();
	const recorded: Recorded = {
		host: real,
		killed: [],
		started: [],
		tempDirs: [],
	};
	let finish: (code: number) => void = () => undefined;
	let signalStop: () => void = () => undefined;
	recorded.host = {
		makeTempDir: async () => {
			const dir = await real.makeTempDir();
			recorded.tempDirs.push(dir);
			cleanup.push(dir);
			return dir;
		},
		removeDir: real.removeDir,
		resolveCore: () => "/opt/fake/ryu-core",
		start: (_bin, bind, env) => {
			recorded.started.push({ bind, env });
			const exited = new Promise<number>((resolve) => {
				finish = resolve;
			});
			return {
				exited,
				kill: (signal) => {
					recorded.killed.push(signal);
					finish(0);
				},
			};
		},
		waitReady: async (_url, _exited) => {
			const env = recorded.started.at(-1)?.env ?? {};
			const dataDir = env.RYU_DIR ?? "";
			await mkdir(join(dataDir, "db"), { recursive: true });
			await writeFile(join(dataDir, "db", "vault.db"), "dev data");
			setTimeout(() => signalStop(), 10);
			return options.ready ?? true;
		},
		// Ctrl-C arrives once Core has answered (see waitReady).
		listenForStop: () => ({
			dispose: () => undefined,
			stopped: new Promise<void>((resolve) => {
				signalStop = resolve;
			}),
		}),
	};
	return recorded;
}

test("only loopback binds with a valid port are accepted", () => {
	expect(loopbackBind("127.0.0.1:8210")).toEqual({
		bind: "127.0.0.1:8210",
		url: "http://127.0.0.1:8210",
	});
	expect(loopbackBind("localhost:9000").url).toBe("http://127.0.0.1:9000");
	expect(loopbackBind("[::1]:8210").url).toBe("http://[::1]:8210");
	for (const bad of [
		"0.0.0.0:8210",
		"192.168.1.20:8210",
		"example.com:80",
		"127.0.0.2:8210",
		"127.0.0.1",
		"127.0.0.1:0",
		"127.0.0.1:70000",
		"[::]:8210",
	]) {
		expect(() => loopbackBind(bad)).toThrow("loopback");
	}
	expect(loopbackBind(DEFAULT_DEV_BIND).bind).toBe(DEFAULT_DEV_BIND);
});

test("without --dev, or with a non-loopback bind, nothing is created or started", async () => {
	for (const raw of [
		["server"],
		["server", "--dev", "--bind", "0.0.0.0:8210"],
		["server", "--dev", "--bind=10.0.0.5:8210"],
	]) {
		const recorded = recordingHost();
		const { ctx } = harness({});
		await expect(
			devServer(ctx, parseSecretsArgs(raw), recorded.host)
		).rejects.toThrow();
		expect(recorded.tempDirs).toEqual([]);
		expect(recorded.started).toEqual([]);
	}
});

test("Core runs on a temporary data dir that is deleted, and the real data dir is untouched", async () => {
	const realDir = join(await sandbox(), "real-ryu");
	await mkdir(join(realDir, "db"), { recursive: true });
	await writeFile(join(realDir, "db", "vault.db"), "real data");
	const before = await readdir(realDir, { recursive: true });

	const recorded = recordingHost();
	const { ctx, err, out } = harness({
		PATH: "/usr/bin",
		RYU_CORE_TOKEN: "node-token",
		RYU_DIR: realDir,
		RYU_KEYCHAIN: "on",
		RYU_MASTER_KEY: "real-key",
		RYU_VAULT_TOKEN: "rvt_real",
	});
	const code = await devServer(
		ctx,
		parseSecretsArgs(["server", "--dev", "--bind", "localhost:8211"]),
		recorded.host
	);
	expect(code).toBe(0);

	const [started] = recorded.started;
	const [tempDir] = recorded.tempDirs;
	expect(started?.bind).toBe("127.0.0.1:8211");
	expect(started?.env.RYU_DIR).toBe(tempDir);
	expect(started?.env.RYU_KEYCHAIN).toBe("off");
	expect(started?.env.PATH).toBe("/usr/bin");
	for (const key of ["RYU_MASTER_KEY", "RYU_CORE_TOKEN", "RYU_VAULT_TOKEN"]) {
		expect(started?.env[key]).toBeUndefined();
	}
	expect(tempDir?.startsWith(realDir)).toBe(false);
	expect(await exists(tempDir ?? "")).toBe(false);
	expect(recorded.killed).toEqual(["SIGTERM"]);

	expect(await readdir(realDir, { recursive: true })).toEqual(before);
	expect(await readFile(join(realDir, "db", "vault.db"), "utf8")).toBe(
		"real data"
	);
	expect(err.join("")).toContain("Never use it in production");
	expect(out.join("")).toContain("export RYU_CORE_URL=http://127.0.0.1:8211");
});

test("a Core that never becomes ready is stopped and its data deleted", async () => {
	const recorded = recordingHost({ ready: false });
	const { ctx, err } = harness({ RYU_DIR: join(await sandbox(), "real") });
	const code = await devServer(
		ctx,
		parseSecretsArgs(["server", "--dev"]),
		recorded.host
	);
	expect(code).toBe(1);
	expect(err.join("")).toContain("did not start");
	expect(recorded.killed).toEqual(["SIGTERM"]);
	expect(await exists(recorded.tempDirs[0] ?? "")).toBe(false);
});

test("a temporary dir inside the real data dir is refused and removed", async () => {
	const realDir = join(await sandbox(), "real");
	const nested = join(realDir, "tmp", "dev");
	await mkdir(nested, { recursive: true });
	const recorded = recordingHost();
	const removed: string[] = [];
	const host: DevServerHost = {
		...recorded.host,
		makeTempDir: async () => nested,
		removeDir: async (path) => {
			removed.push(path);
		},
	};
	const { ctx } = harness({ RYU_DIR: realDir });
	await expect(
		devServer(ctx, parseSecretsArgs(["server", "--dev"]), host)
	).rejects.toThrow("overlaps");
	expect(recorded.started).toEqual([]);
	expect(removed).toEqual([nested]);
});

test("the child environment always points at the given dir", () => {
	const env = devCoreEnv({ HOME: "/home/x", RYU_DIR: "/real" }, "/tmp/dev");
	expect(env).toEqual({
		HOME: "/home/x",
		RYU_DIR: "/tmp/dev",
		RYU_KEYCHAIN: "off",
		RYU_PROFILE: "dev",
	});
});

test("only process basics are inherited: tokens, seal keys and provider keys never reach Core", () => {
	const env = devCoreEnv(
		{
			LANG: "de_DE.UTF-8",
			LC_ALL: "de_DE.UTF-8",
			OPENAI_API_KEY: "sk-real",
			ANTHROPIC_API_KEY: "sk-ant-real",
			PATH: "/usr/bin",
			RUST_LOG: "info",
			RYU_CORE_TOKEN: "node-token",
			RYU_EXT_TOKEN: "ext",
			RYU_GATEWAY_CORE_TOKEN: "gw-core",
			RYU_GATEWAY_TOKEN: "gw",
			RYU_MASTER_KEY: "master",
			RYU_MCP_CORE_TOKEN: "mcp",
			RYU_SEAL_KEY: "seal",
			RYU_TOKEN: "operator-node-token",
			RYU_VAULT_TOKEN: "rvt_real",
			TMPDIR: "/tmp",
		},
		"/tmp/dev"
	);
	expect(env).toEqual({
		LANG: "de_DE.UTF-8",
		LC_ALL: "de_DE.UTF-8",
		PATH: "/usr/bin",
		RUST_LOG: "info",
		RYU_DIR: "/tmp/dev",
		RYU_KEYCHAIN: "off",
		RYU_PROFILE: "dev",
		TMPDIR: "/tmp",
	});
});

test("Ctrl-C while Core starts stops Core and deletes the temporary dir", async () => {
	const recorded = recordingHost();
	let signal: () => void = () => undefined;
	const order: string[] = [];
	let disposed = false;
	const host: DevServerHost = {
		...recorded.host,
		listenForStop: () => {
			order.push("listen");
			return {
				dispose: () => {
					disposed = true;
				},
				stopped: new Promise<void>((resolve) => {
					signal = resolve;
				}),
			};
		},
		makeTempDir: async () => {
			order.push("temp");
			return recorded.host.makeTempDir();
		},
		start: (bin, bind, env) => {
			order.push("start");
			return recorded.host.start(bin, bind, env);
		},
		// Core never answers; the signal arrives during the readiness wait.
		waitReady: () => {
			signal();
			return new Promise<boolean>(() => undefined);
		},
	};
	const { ctx } = harness({ RYU_DIR: join(await sandbox(), "real") });
	const code = await devServer(
		ctx,
		parseSecretsArgs(["server", "--dev"]),
		host
	);
	expect(code).toBe(INTERRUPTED_EXIT);
	expect(order).toEqual(["listen", "temp", "start"]);
	expect(recorded.killed).toEqual(["SIGTERM"]);
	expect(await exists(recorded.tempDirs[0] ?? "")).toBe(false);
	expect(disposed).toBe(true);
});

test("the real stop listener resolves on SIGINT and removes itself", async () => {
	const before = process.listenerCount("SIGINT");
	const stop = realDevServerHost().listenForStop();
	expect(process.listenerCount("SIGINT")).toBe(before + 1);
	expect(process.listenerCount("SIGTERM")).toBeGreaterThan(0);
	process.emit("SIGINT");
	await stop.stopped;
	stop.dispose();
	expect(process.listenerCount("SIGINT")).toBe(before);
});
