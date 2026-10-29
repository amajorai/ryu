// `ryu troubleshoot`: every probe runs against a fake host and a fake Core, so
// these tests cover the decision logic (what is wrong, what to do, what gets
// reported) without a filesystem, sockets, a browser, or the network.

import { describe, expect, test } from "bun:test";
import { ApiError, type ApiTarget } from "@ryuhq/core-client/client";
import { runCli } from "../cli/dispatch.ts";
import {
	extractLogErrors,
	type TroubleshootHost,
} from "../cli/troubleshoot.ts";
import type { CliIO, CoreApi } from "../cli/types.ts";
import { VERSION } from "../cli/version.ts";

const HOME = "/home/jane";
const DATA_DIR = `${HOME}/.ryu`;
const TARGET: ApiTarget = { url: "http://127.0.0.1:7980", token: null };

function capture(): { err: () => string; io: CliIO; out: () => string } {
	let out = "";
	let err = "";
	return {
		io: {
			out: (s) => {
				out += s;
			},
			err: (s) => {
				err += s;
			},
		},
		out: () => out,
		err: () => err,
	};
}

type CoreRoutes = Record<string, (target: ApiTarget, body: unknown) => unknown>;

function fakeApi(routes: CoreRoutes, calls: string[] = []): CoreApi {
	const notCalled = () => Promise.reject(new Error("unexpected CoreApi call"));
	return {
		fetchApps: notCalled,
		fetchAppsCatalog: notCalled,
		installApp: notCalled,
		enableApp: notCalled,
		disableApp: notCalled,
		uninstallApp: notCalled,
		execAppCommand: () => Promise.reject(new Error("unexpected")),
		streamChat: () => Promise.reject(new Error("unexpected")),
		call: async (target, path, options) => {
			const key = `${target.url}${path}`;
			calls.push(`${options?.method ?? "GET"} ${key}`);
			const handler = routes[key] ?? routes[path];
			if (!handler) {
				throw new TypeError("fetch failed: ECONNREFUSED");
			}
			return handler(target, options?.body) as never;
		},
	};
}

interface FakeHostState {
	fetched: string[];
	madeDirs: string[];
	opened: string[];
	started: number;
	written: Map<string, string>;
}

function fakeHost(
	overrides: Partial<TroubleshootHost> = {},
	github: { issues?: unknown[]; latest?: string } = {}
): { host: TroubleshootHost; state: FakeHostState } {
	const state: FakeHostState = {
		fetched: [],
		madeDirs: [],
		opened: [],
		started: 0,
		written: new Map(),
	};
	const host: TroubleshootHost = {
		arch: "x64",
		commandName: "ryu-cli",
		cpu: { count: 8, model: "Test CPU" },
		dataDir: DATA_DIR,
		fetch: (async (input: string | URL | Request) => {
			const url = String(input);
			state.fetched.push(url);
			if (url.includes("/releases/latest")) {
				return Response.json({ tag_name: `v${github.latest ?? VERSION}` });
			}
			return Response.json({ items: github.issues ?? [] });
		}) as typeof fetch,
		homeDir: HOME,
		makeDir: async (path) => {
			state.madeDirs.push(path);
		},
		memory: { freeBytes: 4 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
		now: () => new Date("2026-10-19T10:00:00.000Z"),
		openUrl: async (url) => {
			state.opened.push(url);
			return true;
		},
		osRelease: "6.8.0",
		platform: "linux",
		probeDir: async () => ({
			exists: true,
			freeBytes: 50 * 1024 ** 3,
			writable: true,
		}),
		probePort: async () => false,
		readTail: async () => null,
		resolveBinary: (bin) => `${DATA_DIR}/bin/ryu-${bin}`,
		runtime: "bun 1.3.14",
		startCore: async () => {
			state.started += 1;
		},
		tempDir: "/tmp",
		writeFile: async (path, content) => {
			state.written.set(path, content);
		},
		...overrides,
	};
	return { host, state };
}

const healthyCore: CoreRoutes = {
	"/api/health": () => ({ status: "ok", version: VERSION, channel: "stable" }),
	"/api/system/status": () => ({
		engine: { active: "llamacpp", running: true },
		gateway: { reachable: true },
	}),
	"/api/sidecar/status": () => ({ missing_binaries: [] }),
	"/api/system/info": () => ({ gpu_name: "Test GPU", vram_human: "8 GB" }),
	"/api/gateway/doctor": () => ({
		counts: { errors: 0, warnings: 0, info: 0 },
		findings: [],
	}),
	"/api/plugins/doctor": () => ({ counts: { errors: 0 } }),
	"/api/update/check": () => ({
		asset: null,
		channel: "stable",
		current: VERSION,
		html_url: null,
		latest: VERSION,
		notes: null,
		update_available: false,
	}),
};

async function run(
	argv: string[],
	api: CoreApi,
	host: TroubleshootHost
): Promise<{ code: number; out: string }> {
	const cap = capture();
	const code = await runCli(["troubleshoot", ...argv], {
		api,
		io: cap.io,
		target: TARGET,
		troubleshootHost: host,
		env: { RYU_PROFILE: "" },
	});
	return { code, out: cap.out() + cap.err() };
}

function jsonResult(out: string) {
	return JSON.parse(out) as {
		counts: Record<string, number>;
		fixes: string[];
		issueUrl: string;
		report: {
			checks: { detail: string; fix?: string; id: string; status: string }[];
			machine: [string, string][];
			similarIssues: { number: number }[];
		};
		reportPath: string | null;
	};
}

function check(out: string, id: string) {
	const found = jsonResult(out).report.checks.find((c) => c.id === id);
	if (!found) {
		throw new Error(`no ${id} check`);
	}
	return found;
}

describe("ryu troubleshoot", () => {
	test("a healthy install passes and still offers a report link", async () => {
		const { host, state } = fakeHost();
		const { code, out } = await run([], fakeApi(healthyCore), host);
		expect(code).toBe(0);
		expect(out).toContain("Every check passed");
		expect(out).toContain("https://github.com/amajorai/ryu/issues/new?");
		expect(out).toContain("GPU");
		expect(out).not.toContain("✗");
		const [path, saved] = [...state.written][0] ?? [];
		expect(path).toBe(
			`${DATA_DIR}/logs/troubleshoot-2026-10-19T10-00-00-000Z.md`
		);
		expect(saved).toContain("# Ryu troubleshooting report");
		// The saved report never carries the user's home path.
		expect(saved).not.toContain(HOME);
		// Fix advice is for problems only; a healthy report has none.
		expect(saved).not.toContain("Fix:");
	});

	test("Core down: explains it, searches similar issues, files against Core", async () => {
		const { host, state } = fakeHost(
			{},
			{
				issues: [
					{
						html_url: "https://github.com/amajorai/ryu/issues/41",
						number: 41,
						state: "open",
						title: "Core does not start on Ubuntu",
						updated_at: "2026-10-01T00:00:00Z",
					},
				],
			}
		);
		const { code, out } = await run(
			["Core", "will", "not", "start", "--json"],
			fakeApi({}),
			host
		);
		expect(code).toBe(1);
		const core = check(out, "core.reachable");
		expect(core.status).toBe("fail");
		expect(core.detail).toContain("Core is not running");
		expect(core.fix).toContain("ryu-cli troubleshoot --fix");
		expect(check(out, "core.details").status).toBe("skip");
		const result = jsonResult(out);
		expect(result.report.similarIssues.map((i) => i.number)).toEqual([41]);
		const issue = new URL(result.issueUrl).searchParams;
		expect(issue.get("unit")).toBe("apps/core");
		expect(issue.get("title")).toBe("Core will not start");
		expect(issue.get("what-happened")).toContain("#41");
		// With Core down, the update check falls back to GitHub's latest release.
		expect(state.fetched.some((u) => u.includes("/releases/latest"))).toBe(
			true
		);
		expect(state.started).toBe(0);
	});

	test("points at a Core running under another profile", async () => {
		const { host } = fakeHost({
			probePort: async (_host, port) => port === 8980,
		});
		const api = fakeApi({
			"http://127.0.0.1:8980/api/health": () => ({
				status: "ok",
				version: VERSION,
			}),
		});
		const { out } = await run(["--json"], api, host);
		const core = check(out, "core.reachable");
		expect(core.detail).toContain("dev-profile Core answers on port 8980");
		expect(core.fix).toContain("RYU_PROFILE=dev");
	});

	test("names a port conflict instead of 'not running'", async () => {
		const { host } = fakeHost({
			probePort: async (_host, port) => port === 7980,
		});
		const { out } = await run(["--json"], fakeApi({}), host);
		const core = check(out, "core.reachable");
		expect(core.detail).toContain("Something listens on port 7980");
		expect(core.fix).toContain("lsof -nP -iTCP:7980");
	});

	test("a 401 is a token problem, not a dead Core", async () => {
		const { host } = fakeHost();
		const api = fakeApi({
			"/api/health": () => {
				throw new ApiError("/api/health", 401);
			},
		});
		const { out } = await run(["--json"], api, host);
		const core = check(out, "core.reachable");
		expect(core.detail).toContain("refused this CLI");
		expect(core.fix).toContain("RYU_CORE_TOKEN");
	});

	test("a token refused on protected routes stops after one clear finding", async () => {
		const calls: string[] = [];
		const api = fakeApi(
			{
				...healthyCore,
				"/api/system/status": () => {
					throw new ApiError("/api/system/status", 401);
				},
			},
			calls
		);
		const { code, out } = await run(
			["--json", "--offline"],
			api,
			fakeHost().host
		);
		expect(code).toBe(1);
		expect(check(out, "core.reachable").status).toBe("pass");
		const auth = check(out, "core.auth");
		expect(auth.status).toBe("fail");
		expect(auth.fix).toContain("ryu-cli node use");
		expect(calls.some((c) => c.includes("/api/gateway/doctor"))).toBe(false);
	});

	test("a missing Core binary gives the platform's install command", async () => {
		const { host } = fakeHost({
			platform: "win32",
			resolveBinary: () => null,
		});
		const { out } = await run(["--json", "--offline"], fakeApi({}), host);
		const binary = check(out, "install.core-binary");
		expect(binary.status).toBe("fail");
		expect(binary.fix).toContain("install.ps1 | iex");
		expect(check(out, "install.gateway-binary").status).toBe("warn");
	});

	test("--fix starts a local Core and re-checks it", async () => {
		let up = false;
		const { host, state } = fakeHost({
			startCore: async () => {
				state.started += 1;
				up = true;
			},
		});
		const routes: CoreRoutes = {
			...healthyCore,
			"/api/health": () => {
				if (!up) {
					throw new TypeError("fetch failed");
				}
				return { status: "ok", version: VERSION };
			},
		};
		const { code, out } = await run(["--fix", "--json"], fakeApi(routes), host);
		expect(state.started).toBe(1);
		expect(code).toBe(0);
		expect(jsonResult(out).fixes).toContain(
			"Started Core at http://127.0.0.1:7980."
		);
		expect(check(out, "core.reachable").status).toBe("pass");
	});

	test("--fix --dry-run previews without changing anything", async () => {
		const { host, state } = fakeHost({
			probeDir: async () => ({
				exists: false,
				freeBytes: null,
				writable: true,
			}),
		});
		const { out } = await run(
			["--fix", "--dry-run", "--json"],
			fakeApi({}),
			host
		);
		expect(state.started).toBe(0);
		expect(state.madeDirs).toEqual([]);
		expect(jsonResult(out).fixes).toEqual([
			"Would create the data directory ~/.ryu.",
			"Would start a local Core at http://127.0.0.1:7980.",
		]);
	});

	test("--fix creates a missing data directory", async () => {
		let exists = false;
		const { host, state } = fakeHost({
			makeDir: async (path) => {
				state.madeDirs.push(path);
				exists = true;
			},
			probeDir: async () => ({
				exists,
				freeBytes: 50 * 1024 ** 3,
				writable: true,
			}),
		});
		const { out } = await run(["--fix", "--json"], fakeApi(healthyCore), host);
		expect(state.madeDirs).toEqual([DATA_DIR]);
		expect(check(out, "data-dir").status).toBe("pass");
	});

	test("an unwritable data directory fails with a permissions fix", async () => {
		const { host } = fakeHost({
			probeDir: async () => ({
				exists: true,
				freeBytes: 512 * 1024 ** 2,
				writable: false,
			}),
		});
		const { out } = await run(
			["--json", "--offline"],
			fakeApi(healthyCore),
			host
		);
		expect(check(out, "data-dir").fix).toContain("chown");
		expect(check(out, "disk.free").status).toBe("fail");
	});

	test("Gateway Doctor errors are applied with --fix", async () => {
		let fixed = false;
		const calls: string[] = [];
		const routes: CoreRoutes = {
			...healthyCore,
			"/api/gateway/doctor": () => ({
				counts: { errors: 1, warnings: 0 },
				findings: [{ canAutoFix: true }],
			}),
			"/api/gateway/doctor/fix": (_t, body) => {
				fixed = (body as { dryRun: boolean }).dryRun === false;
				return {
					appliedFixes: [{ checkId: "x" }],
					plannedFixes: [],
					report: { counts: { errors: 0, warnings: 0 }, findings: [] },
				};
			},
		};
		const before = await run(["--json"], fakeApi(routes), fakeHost().host);
		expect(before.code).toBe(1);
		expect(check(before.out, "gateway.doctor").fix).toContain(
			"doctor --dry-run"
		);

		const after = await run(
			["--fix", "--json"],
			fakeApi(routes, calls),
			fakeHost().host
		);
		expect(fixed).toBe(true);
		expect(after.code).toBe(0);
		expect(jsonResult(after.out).fixes).toContain(
			"Gateway Doctor applied 1 safe fix."
		);
		expect(calls).toContain(
			"POST http://127.0.0.1:7980/api/gateway/doctor/fix"
		);
	});

	test("reports Gateway, sidecar, engine, version and update problems", async () => {
		const routes: CoreRoutes = {
			...healthyCore,
			"/api/health": () => ({
				status: "ok",
				version: "0.1.0",
				requiredRuntimeReady: false,
			}),
			"/api/system/status": () => ({
				engine: { active: "llamacpp", running: false },
				gateway: { reachable: false },
			}),
			"/api/sidecar/status": () => ({
				missing_binaries: [
					{ name: "shadow", expected_asset: "ryu-shadow-linux-x86_64" },
				],
			}),
			"/api/update/check": () => ({
				asset: null,
				channel: "stable",
				current: "0.1.0",
				html_url: null,
				latest: "99.0.0",
				notes: null,
				update_available: true,
			}),
		};
		const { out } = await run(
			["--json", "--offline"],
			fakeApi(routes),
			fakeHost().host
		);
		expect(check(out, "gateway.reachable").status).toBe("fail");
		expect(check(out, "sidecars.binaries").detail).toContain(
			"shadow (ryu-shadow-linux-x86_64)"
		);
		expect(check(out, "engine.running").fix).toContain(
			"ryu-cli start llamacpp"
		);
		expect(check(out, "core.version-match").status).toBe("warn");
		expect(check(out, "core.runtime-ready").status).toBe("warn");
		const update = check(out, "update");
		expect(update.status).toBe("warn");
		expect(update.detail).toContain("99.0.0 is available");
	});

	test("--offline makes no GitHub requests", async () => {
		const { host, state } = fakeHost();
		await run(["Core crashed", "--offline"], fakeApi({}), host);
		expect(state.fetched).toEqual([]);
	});

	test("--open hands the prefilled issue to the browser", async () => {
		const { host, state } = fakeHost();
		const { out } = await run(["--open", "--offline"], fakeApi({}), host);
		expect(state.opened).toHaveLength(1);
		expect(state.opened[0]).toContain("template=bug_report.yml");
		expect(out).toContain("Opened in your browser");
	});

	test("log errors are collected, redacted, and land in the issue", async () => {
		const { host } = fakeHost({
			readTail: async (path) =>
				path === `${DATA_DIR}/logs/ryu-core.log`
					? [
							"INFO booting",
							"\u001b[31mERROR\u001b[0m bind failed for /home/jane/.ryu token=abc123secret",
							"thread 'main' panicked at src/main.rs:1",
						].join("\n")
					: null,
		});
		const { out } = await run(["--json", "--offline"], fakeApi({}), host);
		const logs = check(out, "logs");
		expect(logs.status).toBe("warn");
		const issueLogs =
			new URL(jsonResult(out).issueUrl).searchParams.get("logs") ?? "";
		expect(issueLogs).toContain(
			"ERROR bind failed for ~/.ryu token=[REDACTED]"
		);
		expect(issueLogs).toContain("panicked at");
		expect(issueLogs).not.toContain("abc123secret");
	});

	test("falls back to the temp directory when the data dir is unwritable", async () => {
		const { host, state } = fakeHost({
			writeFile: async (path, content) => {
				if (path.startsWith(DATA_DIR)) {
					throw new Error("EACCES");
				}
				state.written.set(path, content);
			},
		});
		const { out } = await run(["--json", "--offline"], fakeApi({}), host);
		expect(jsonResult(out).reportPath).toBe(
			"/tmp/troubleshoot-2026-10-19T10-00-00-000Z.md"
		);
	});

	test("the bug-report alias runs the same command", async () => {
		const cap = capture();
		const code = await runCli(["bug-report", "--offline"], {
			api: fakeApi(healthyCore),
			io: cap.io,
			target: TARGET,
			troubleshootHost: fakeHost().host,
		});
		expect(code).toBe(0);
		expect(cap.out()).toContain("Ryu troubleshooter");
	});
});

test("extractLogErrors keeps only the newest error lines", () => {
	const tail = Array.from({ length: 30 }, (_, i) => `ERROR ${i}`).join("\n");
	const lines = extractLogErrors([tail], HOME);
	expect(lines).toHaveLength(20);
	expect(lines.at(-1)).toBe("ERROR 29");
	expect(extractLogErrors(["INFO all good\nWARN slow"], HOME)).toEqual([]);
});
