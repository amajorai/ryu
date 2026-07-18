// Unit tests for the non-interactive `ryu` CLI dispatcher. These prove argv routing
// (a known subcommand runs its handler; unknown/empty falls through to interactive),
// --json output shape, --help/--version, exit codes, and typed-409 error rendering.
// The HTTP layer is mocked via an injected CoreApi, so nothing hits a Core node.

import { expect, test } from "bun:test";
import type {
	AppInfo,
	AppRecord,
	AppUninstallResult,
	CatalogEntry,
} from "@ryuhq/core-client/plugins";
import { isInteractive, parseArgs, runCli } from "../cli/dispatch.ts";
import type { CliIO, CoreApi } from "../cli/types.ts";

// ── Fixtures + fakes ──────────────────────────────────────────────────────────

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

const sampleApp: AppInfo = {
	builtIn: false,
	commands: [],
	companion: null,
	enabled: true,
	id: "whiteboard",
	installed: true,
	installedVersion: "1.0.0",
	localOnly: false,
	name: "Whiteboard",
	permissionGrants: [],
	requires: null,
	runnables: [],
	sidecarName: null,
	targets: [],
	version: "1.0.0",
	windowsFirst: false,
};

/** A cli-only app contributing `ryu mail <cmd>` subcommands. */
const mailApp: AppInfo = {
	...sampleApp,
	id: "mail",
	name: "Mail",
	commands: [
		{
			name: "status",
			method: "GET",
			path: "/status",
			summary: "Show inbox status",
		},
		{ name: "send", method: "POST", path: "/send", summary: null },
	],
};

const sampleCatalogEntry: CatalogEntry = {
	built_in: false,
	description: "A collaborative whiteboard",
	id: "whiteboard",
	kinds: ["companion"],
	name: "Whiteboard",
	permission_grants: [],
	source: "registry",
	tags: ["draw"],
	version: "1.0.0",
};

const sampleRecord: AppRecord = {
	approvedGrants: [],
	createdAt: null,
	enabled: false,
	id: "whiteboard",
	updatedAt: null,
	version: "1.0.0",
};

/** A CoreApi whose every method rejects — override just the one under test. */
function stubApi(overrides: Partial<CoreApi> = {}): CoreApi {
	const notCalled = () => Promise.reject(new Error("unexpected CoreApi call"));
	return {
		fetchApps: notCalled,
		fetchAppsCatalog: notCalled,
		installApp: notCalled,
		enableApp: notCalled,
		disableApp: notCalled,
		uninstallApp: notCalled,
		execAppCommand: () =>
			Promise.reject(new Error("unexpected execAppCommand call")),
		streamChat: () => Promise.reject(new Error("unexpected streamChat call")),
		...overrides,
	};
}

// ── parseArgs ─────────────────────────────────────────────────────────────────

test("parseArgs: subcommand + trailing flag", () => {
	const parsed = parseArgs(["list", "--json"]);
	expect(parsed.command).toBe("list");
	expect(parsed.args).toEqual([]);
	expect(parsed.flags.json).toBe(true);
});

test("parseArgs: --node consumes its value and positional args survive", () => {
	const parsed = parseArgs(["--node", "http://x:7980", "add", "whiteboard"]);
	expect(parsed.command).toBe("add");
	expect(parsed.args).toEqual(["whiteboard"]);
	expect(parsed.flags.node).toBe("http://x:7980");
});

test("parseArgs: --node=<url> inline form", () => {
	const parsed = parseArgs(["list", "--node=http://y:7980"]);
	expect(parsed.flags.node).toBe("http://y:7980");
});

// ── isInteractive ─────────────────────────────────────────────────────────────

test("isInteractive: bare and 'tui' are interactive; a subcommand is not", () => {
	expect(isInteractive([])).toBe(true);
	expect(isInteractive(["tui"])).toBe(true);
	expect(isInteractive(["list"])).toBe(false);
	// --help / --version are non-interactive (handled by runCli, not the shell).
	expect(isInteractive(["--help"])).toBe(false);
	expect(isInteractive(["--version"])).toBe(false);
});

// ── list ──────────────────────────────────────────────────────────────────────

test("list: prints a human table and exits 0", async () => {
	const cap = makeIo();
	const code = await runCli(["list"], {
		io: cap.io,
		api: stubApi({ fetchApps: () => Promise.resolve([sampleApp]) }),
	});
	expect(code).toBe(0);
	expect(cap.out()).toContain("whiteboard");
	expect(cap.out()).toContain("ENABLED");
	expect(cap.err()).toBe("");
});

test("list --json: emits a parseable array (not the table)", async () => {
	const cap = makeIo();
	const code = await runCli(["list", "--json"], {
		io: cap.io,
		api: stubApi({ fetchApps: () => Promise.resolve([sampleApp]) }),
	});
	expect(code).toBe(0);
	const parsed = JSON.parse(cap.out()) as AppInfo[];
	expect(parsed[0]?.id).toBe("whiteboard");
	expect(cap.out()).not.toContain("ENABLED");
});

// ── add / install ─────────────────────────────────────────────────────────────

test("add <id>: routes to installApp with the id and exits 0", async () => {
	const cap = makeIo();
	let installed = "";
	const code = await runCli(["add", "whiteboard"], {
		io: cap.io,
		api: stubApi({
			installApp: (_t, id) => {
				installed = id;
				return Promise.resolve(sampleRecord);
			},
		}),
	});
	expect(code).toBe(0);
	expect(installed).toBe("whiteboard");
	expect(cap.out()).toContain("Installed whiteboard");
});

test("install alias resolves to the same handler as add", async () => {
	const cap = makeIo();
	let installed = "";
	await runCli(["install", "whiteboard"], {
		io: cap.io,
		api: stubApi({
			installApp: (_t, id) => {
				installed = id;
				return Promise.resolve(sampleRecord);
			},
		}),
	});
	expect(installed).toBe("whiteboard");
});

test("add without an id is a usage error (exit 2, stderr)", async () => {
	const cap = makeIo();
	const code = await runCli(["add"], { io: cap.io, api: stubApi() });
	expect(code).toBe(2);
	expect(cap.err()).toContain("Usage");
});

// ── catalog / search ──────────────────────────────────────────────────────────

test("search filters catalog entries by query", async () => {
	const cap = makeIo();
	const code = await runCli(["search", "nomatch"], {
		io: cap.io,
		api: stubApi({
			fetchAppsCatalog: () => Promise.resolve([sampleCatalogEntry]),
		}),
	});
	expect(code).toBe(0);
	expect(cap.out()).toContain("No matching apps");
});

// ── unknown command ───────────────────────────────────────────────────────────

test("unknown command exits 2 with a stderr hint", async () => {
	const cap = makeIo();
	const code = await runCli(["frobnicate"], { io: cap.io, api: stubApi() });
	expect(code).toBe(2);
	expect(cap.err()).toContain("Unknown command");
});

// ── help / version ────────────────────────────────────────────────────────────

test("--help lists commands and exits 0", async () => {
	const cap = makeIo();
	const code = await runCli(["--help"], { io: cap.io, api: stubApi() });
	expect(code).toBe(0);
	expect(cap.out()).toContain("Usage:");
	expect(cap.out()).toContain("ryu add <id>");
});

test("--version prints the version and exits 0", async () => {
	const cap = makeIo();
	const code = await runCli(["--version"], { io: cap.io, api: stubApi() });
	expect(code).toBe(0);
	expect(cap.out()).toMatch(/ryu \d+\.\d+\.\d+/);
});

// ── typed lifecycle (409) error rendering ─────────────────────────────────────

test("uninstall renders a typed 409 as a clear message + exit 1 (not a raw dump)", async () => {
	const cap = makeIo();
	const lifecycleError = Object.assign(
		new Error("Whiteboard is needed by Meetings. Disable Meetings first."),
		{
			dependencyError: {
				code: "blocked_by_dependents",
				plugin: "whiteboard",
				dependents: ["meetings"],
			},
			gatewayUnreachable: false,
			grantsDenied: false,
			builtIn: false,
			hint: "pass --cascade to disable dependents too",
			message: "Whiteboard is needed by Meetings. Disable Meetings first.",
		}
	);
	const code = await runCli(["uninstall", "whiteboard"], {
		io: cap.io,
		api: stubApi({
			uninstallApp: () =>
				Promise.reject(lifecycleError) as Promise<AppUninstallResult>,
		}),
	});
	expect(code).toBe(1);
	expect(cap.err()).toContain("Disable Meetings first");
	expect(cap.err()).toContain("pass --cascade");
	expect(cap.err()).not.toContain("[object Object]");
});

test("--json error output is machine-readable on stderr", async () => {
	const cap = makeIo();
	const code = await runCli(["enable", "whiteboard", "--json"], {
		io: cap.io,
		api: stubApi({
			enableApp: () => Promise.reject(new Error("boom")),
		}),
	});
	expect(code).toBe(1);
	const parsed = JSON.parse(cap.err()) as { error: string };
	expect(parsed.error).toBe("boom");
});

// ── one-shot chat ─────────────────────────────────────────────────────────────

test("chat streams assistant deltas to stdout and exits 0", async () => {
	const cap = makeIo();
	const code = await runCli(["chat", "hello", "there"], {
		io: cap.io,
		api: stubApi({
			streamChat: (_t, turns, _o, handlers) => {
				expect(turns[0]?.content).toBe("hello there");
				handlers.onTextDelta("Hi ");
				handlers.onTextDelta("back");
				handlers.onDone();
				return Promise.resolve();
			},
		}),
	});
	expect(code).toBe(0);
	expect(cap.out()).toContain("Hi back");
});

test("chat --json collects the full reply into a JSON envelope", async () => {
	const cap = makeIo();
	const code = await runCli(["chat", "hi", "--json"], {
		io: cap.io,
		api: stubApi({
			streamChat: (_t, _turns, _o, handlers) => {
				handlers.onTextDelta("full ");
				handlers.onTextDelta("reply");
				handlers.onDone();
				return Promise.resolve();
			},
		}),
	});
	expect(code).toBe(0);
	const parsed = JSON.parse(cap.out()) as { text: string };
	expect(parsed.text).toBe("full reply");
});

test("chat surfaces a stream error as exit 1", async () => {
	const cap = makeIo();
	const code = await runCli(["chat", "hi"], {
		io: cap.io,
		api: stubApi({
			streamChat: (_t, _turns, _o, handlers) => {
				handlers.onError("stream blew up");
				return Promise.resolve();
			},
		}),
	});
	expect(code).toBe(1);
	expect(cap.err()).toContain("stream blew up");
});

// ── app-contributed subcommands (`ryu <app> <cmd>`) ────────────────────────────

test("app command routes to execAppCommand with the right plugin id + route", async () => {
	const cap = makeIo();
	let capturedId = "";
	let capturedMethod = "";
	let capturedPath = "";
	const code = await runCli(["mail", "status"], {
		io: cap.io,
		api: stubApi({
			fetchApps: () => Promise.resolve([mailApp]),
			execAppCommand: (_t, pluginId, cmd) => {
				capturedId = pluginId;
				capturedMethod = cmd.method;
				capturedPath = cmd.path;
				return Promise.resolve({ status: 200, body: "ok" });
			},
		}),
	});
	expect(code).toBe(0);
	expect(capturedId).toBe("mail");
	expect(capturedPath).toBe("/status");
	expect(capturedMethod).toBe("GET");
	expect(cap.out()).toContain("ok");
	expect(cap.err()).toBe("");
});

test("app command passes trailing args through to the sidecar", async () => {
	const cap = makeIo();
	let receivedArgs: string[] = [];
	await runCli(["mail", "send", "a@b.com", "hi"], {
		io: cap.io,
		api: stubApi({
			fetchApps: () => Promise.resolve([mailApp]),
			execAppCommand: (_t, _id, _cmd, args) => {
				receivedArgs = args;
				return Promise.resolve({ status: 200, body: "sent" });
			},
		}),
	});
	expect(receivedArgs).toEqual(["a@b.com", "hi"]);
});

test("an app id never shadows a built-in command", async () => {
	const cap = makeIo();
	// An app accidentally named `list` must NOT intercept `ryu list`; the built-in
	// runs (fetchApps is consulted by the built-in itself, once) and the
	// app-command fall-through — hence execAppCommand — is never reached.
	const listApp: AppInfo = { ...mailApp, id: "list", name: "List" };
	const code = await runCli(["list"], {
		io: cap.io,
		api: stubApi({ fetchApps: () => Promise.resolve([listApp]) }),
	});
	expect(code).toBe(0);
	expect(cap.out()).toContain("ENABLED");
});

test("`ryu <app>` with no subcommand lists the app's commands", async () => {
	const cap = makeIo();
	const code = await runCli(["mail"], {
		io: cap.io,
		api: stubApi({ fetchApps: () => Promise.resolve([mailApp]) }),
	});
	expect(code).toBe(0);
	expect(cap.out()).toContain("status");
	expect(cap.out()).toContain("Show inbox status");
	expect(cap.out()).toContain("ryu mail send");
});

test("unknown subcommand for a known app is a usage error listing options", async () => {
	const cap = makeIo();
	const code = await runCli(["mail", "bogus"], {
		io: cap.io,
		api: stubApi({ fetchApps: () => Promise.resolve([mailApp]) }),
	});
	expect(code).toBe(2);
	expect(cap.err()).toContain("Unknown command 'bogus'");
	expect(cap.err()).toContain("status");
	expect(cap.err()).toContain("send");
});

test("a disabled app does not contribute commands (falls through to unknown)", async () => {
	const cap = makeIo();
	const disabled: AppInfo = { ...mailApp, enabled: false };
	const code = await runCli(["mail", "status"], {
		io: cap.io,
		api: stubApi({ fetchApps: () => Promise.resolve([disabled]) }),
	});
	expect(code).toBe(2);
	expect(cap.err()).toContain("Unknown command: mail");
});

test("an unknown app id still exits 2 with the classic message", async () => {
	const cap = makeIo();
	const code = await runCli(["frobnicate"], {
		io: cap.io,
		api: stubApi({ fetchApps: () => Promise.resolve([mailApp]) }),
	});
	expect(code).toBe(2);
	expect(cap.err()).toContain("Unknown command");
});

test("a non-2xx status from the sidecar maps to exit 1 with the body on stderr", async () => {
	const cap = makeIo();
	const code = await runCli(["mail", "status"], {
		io: cap.io,
		api: stubApi({
			fetchApps: () => Promise.resolve([mailApp]),
			execAppCommand: () => Promise.resolve({ status: 500, body: "boom" }),
		}),
	});
	expect(code).toBe(1);
	expect(cap.err()).toContain("boom");
});
