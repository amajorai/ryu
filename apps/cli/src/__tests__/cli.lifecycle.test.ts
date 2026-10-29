// Dispatch tests for the sidecar lifecycle commands (`start`/`stop`/`restart`)
// and the dependent-chain flags of `disable`/`uninstall` (`--cascade`,
// `--force`, `--dry-run`). Core is faked through an injected CoreApi, so
// nothing touches a node; each test records exactly which call was made.

import { expect, test } from "bun:test";
import type { AppRecord } from "@ryuhq/core-client/plugins";
import { runCli } from "../cli/dispatch.ts";
import type { CliIO, CoreApi } from "../cli/types.ts";

function makeIo() {
	let out = "";
	let err = "";
	const io: CliIO = {
		out: (chunk) => {
			out += chunk;
		},
		err: (chunk) => {
			err += chunk;
		},
	};
	return { err: () => err, io, out: () => out };
}

function stubApi(overrides: Partial<CoreApi> = {}): CoreApi {
	const notCalled = () => Promise.reject(new Error("unexpected CoreApi call"));
	return {
		disableApp: notCalled,
		enableApp: notCalled,
		execAppCommand: notCalled,
		fetchApps: notCalled,
		fetchAppsCatalog: notCalled,
		installApp: notCalled,
		streamChat: notCalled,
		uninstallApp: notCalled,
		...overrides,
	};
}

interface RecordedCall {
	method?: string;
	path: string;
}

function recordingApi(calls: RecordedCall[]): CoreApi {
	return stubApi({
		call: (_target, path, options) => {
			calls.push({ method: options?.method, path });
			return Promise.resolve({ ok: true });
		},
	});
}

const disabledRecord: AppRecord = {
	approvedGrants: [],
	createdAt: null,
	enabled: false,
	id: "whiteboard",
	updatedAt: null,
	version: "1.0.0",
};

// ── start / stop / restart ────────────────────────────────────────────────────

test("stop and start with no name POST the all-sidecars routes", async () => {
	const calls: RecordedCall[] = [];
	const stop = makeIo();
	expect(
		await runCli(["stop"], { io: stop.io, api: recordingApi(calls) })
	).toBe(0);
	const start = makeIo();
	expect(
		await runCli(["start"], { io: start.io, api: recordingApi(calls) })
	).toBe(0);
	expect(calls).toEqual([
		{ method: "POST", path: "/api/sidecar/stop-all" },
		{ method: "POST", path: "/api/sidecar/start-all" },
	]);
	expect(stop.out()).toBe("Stopped all.\n");
	expect(start.out()).toBe("Started all.\n");
});

test("restart without a name is a usage error and calls nothing", async () => {
	const calls: RecordedCall[] = [];
	const cap = makeIo();
	const code = await runCli(["restart"], {
		io: cap.io,
		api: recordingApi(calls),
	});
	expect(code).toBe(2);
	expect(cap.err()).toContain("Usage: ryu-cli restart");
	expect(calls).toEqual([]);
});

test("a named sidecar uses its own route and reads naturally", async () => {
	const calls: RecordedCall[] = [];
	const stop = makeIo();
	expect(
		await runCli(["stop", "foo"], { io: stop.io, api: recordingApi(calls) })
	).toBe(0);
	const restart = makeIo();
	expect(
		await runCli(["restart", "foo"], {
			io: restart.io,
			api: recordingApi(calls),
		})
	).toBe(0);
	expect(calls.map((c) => c.path)).toEqual([
		"/api/sidecar/foo/stop",
		"/api/sidecar/foo/restart",
	]);
	expect(stop.out()).toBe("Stopped foo.\n");
	expect(restart.out()).toBe("Restarted foo.\n");
});

test("a sidecar name is encoded and cannot change the route", async () => {
	const calls: RecordedCall[] = [];
	const cap = makeIo();
	await runCli(["stop", "../plugins/x"], {
		io: cap.io,
		api: recordingApi(calls),
	});
	await runCli(["start", "@ryu/browser"], {
		io: cap.io,
		api: recordingApi(calls),
	});
	expect(calls.map((c) => c.path)).toEqual([
		"/api/sidecar/..%2Fplugins%2Fx/stop",
		"/api/sidecar/%40ryu%2Fbrowser/start",
	]);
});

// ── disable / uninstall --cascade ─────────────────────────────────────────────

test("disable forwards --cascade to Core", async () => {
	const seen: Array<{ cascade?: boolean } | undefined> = [];
	const api = stubApi({
		disableApp: (_t, id, options) => {
			seen.push(options);
			return Promise.resolve({ ...disabledRecord, id });
		},
	});
	const cap = makeIo();
	expect(await runCli(["disable", "x", "--cascade"], { io: cap.io, api })).toBe(
		0
	);
	expect(await runCli(["disable", "x"], { io: cap.io, api })).toBe(0);
	expect(seen).toEqual([{ cascade: true }, { cascade: false }]);
	expect(cap.out()).toContain("Disabled x.");
});

test("uninstall forwards cascade and prints Core's notice", async () => {
	const seen: Array<{ id: string; options?: { cascade?: boolean } }> = [];
	const api = stubApi({
		uninstallApp: (_t, id, options) => {
			seen.push({ id, options });
			return Promise.resolve({
				disabled: [id],
				notice: "Restart Ryu to release its files.",
				removed: id,
				success: true,
			});
		},
	});
	const cap = makeIo();
	expect(await runCli(["uninstall", "x"], { io: cap.io, api })).toBe(0);
	expect(await runCli(["rm", "y", "--cascade"], { io: cap.io, api })).toBe(0);
	expect(seen).toEqual([
		{ id: "x", options: { cascade: false } },
		{ id: "y", options: { cascade: true } },
	]);
	expect(cap.out()).toContain(
		"Uninstalled x.\nRestart Ryu to release its files.\n"
	);
});

test("disable --dry-run previews the cascade chain and never disables", async () => {
	const previews: unknown[] = [];
	const api = stubApi({
		previewAppLifecycle: (_t, id, action, options) => {
			previews.push({ action, id, options });
			return Promise.resolve({
				action,
				dryRun: true,
				success: true,
				wouldDisable: ["x", "x-dependent", "x-leaf"],
			});
		},
	});
	const cap = makeIo();
	const code = await runCli(
		["disable", "x", "--dry-run", "--cascade", "--force"],
		{ io: cap.io, api }
	);
	expect(code).toBe(0);
	expect(previews).toEqual([
		{ action: "disable", id: "x", options: { cascade: true, force: true } },
	]);
	expect(cap.out()).toBe(
		"Dry run · disable x (nothing changed).\n  x → x-dependent → x-leaf\n"
	);
});

test("uninstall --dry-run without a planner fails and makes no live call", async () => {
	let liveCalls = 0;
	const api = stubApi({
		uninstallApp: () => {
			liveCalls += 1;
			return Promise.resolve({ disabled: ["x"], removed: "x", success: true });
		},
	});
	const cap = makeIo();
	const code = await runCli(["uninstall", "x", "--dry-run", "--cascade"], {
		io: cap.io,
		api,
	});
	expect(code).toBe(1);
	expect(cap.err()).toContain("does not expose a dry-run planner");
	expect(liveCalls).toBe(0);
});

test("uninstall --dry-run forwards cascade to the planner", async () => {
	const previews: unknown[] = [];
	const api = stubApi({
		previewAppLifecycle: (_t, id, action, options) => {
			previews.push({ action, id, options });
			return Promise.resolve({ action, dryRun: true, success: true });
		},
	});
	const cap = makeIo();
	expect(
		await runCli(["uninstall", "x", "--dry-run", "--cascade", "--json"], {
			io: cap.io,
			api,
		})
	).toBe(0);
	expect(previews).toEqual([
		{ action: "uninstall", id: "x", options: { cascade: true } },
	]);
	expect(JSON.parse(cap.out()).dryRun).toBe(true);
});
