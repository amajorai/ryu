// Unit tests for the non-interactive `ryu` CLI dispatcher. These prove argv routing
// (a known subcommand runs its handler; unknown/empty falls through to interactive),
// --json output shape, --help/--version, exit codes, and typed-409 error rendering.
// The HTTP layer is mocked via an injected CoreApi, so nothing hits a Core node.

import { expect, test } from "bun:test";
import { isInteractive, parseArgs, runCli } from "../cli/dispatch.ts";
import {
	appListOutputObservation,
	errorOutputObservation,
	makeIo,
	type PreviewCallCapture,
	sampleApp,
	sampleCatalogEntry,
	sampleRecord,
	stubApi,
} from "./cli-dispatch-fixtures.ts";

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

test("parseArgs: -f and --file consume Gateway config paths without positional args", () => {
	const short = parseArgs(["apply", "-f", "gateway.toml", "--dry-run"]);
	expect(short.command).toBe("apply");
	expect(short.args).toEqual([]);
	expect(short.flags.file).toBe("gateway.toml");
	expect(short.flags.dryRun).toBe(true);

	const long = parseArgs(["diff", "--file=gateway.toml"]);
	expect(long.command).toBe("diff");
	expect(long.flags.file).toBe("gateway.toml");
});

test("parseArgs: --force and --cascade set their flags", () => {
	const parsed = parseArgs(["disable", "whiteboard", "--force", "--cascade"]);
	expect(parsed.command).toBe("disable");
	expect(parsed.args).toEqual(["whiteboard"]);
	expect(parsed.flags.force).toBe(true);
	expect(parsed.flags.cascade).toBe(true);
	// Defaults for the flags not passed.
	expect(parsed.flags.json).toBe(false);
	expect(parsed.flags.help).toBe(false);
});

test("parseArgs: doctor repair flags are explicit and default off", () => {
	const parsed = parseArgs(["doctor", "--fix", "--dry-run"]);
	expect(parsed.command).toBe("doctor");
	expect(parsed.flags.fix).toBe(true);
	expect(parsed.flags.dryRun).toBe(true);

	const defaults = parseArgs(["doctor"]);
	expect(defaults.flags.fix).toBe(false);
	expect(defaults.flags.dryRun).toBe(false);
});

test("parseArgs: an unknown --flag is ignored (never a positional/command)", () => {
	const parsed = parseArgs(["--nope", "list", "--also-unknown", "arg"]);
	expect(parsed.command).toBe("list");
	expect(parsed.args).toEqual(["arg"]);
});

test("parseArgs: a trailing --node with no value yields null (not the next flag)", () => {
	const parsed = parseArgs(["list", "--node"]);
	// argv[i+1] is undefined → null, and the loop's i++ skips past the end.
	expect(parsed.flags.node).toBeNull();
	expect(parsed.command).toBe("list");
});

test("parseArgs: -h sets help; flags may precede the command", () => {
	const parsed = parseArgs(["-h"]);
	expect(parsed.flags.help).toBe(true);
	expect(parsed.command).toBeNull();
});

test("parseArgs: the first non-flag is the command, the rest are positional args", () => {
	const parsed = parseArgs(["mail", "send", "a@b.com", "hi"]);
	expect(parsed.command).toBe("mail");
	expect(parsed.args).toEqual(["send", "a@b.com", "hi"]);
});

test("parseArgs: empty argv → null command and empty args", () => {
	const parsed = parseArgs([]);
	expect(parsed.command).toBeNull();
	expect(parsed.args).toEqual([]);
});

test("isInteractive: --node value is not mistaken for a subcommand", () => {
	// `--node <url>` with no subcommand stays interactive (the url is consumed as
	// the flag value, not treated as the command).
	expect(isInteractive(["--node", "http://x:7980"])).toBe(true);
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
	const parsed = appListOutputObservation.parse(JSON.parse(cap.out()));
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

test("add --dry-run previews without calling the live install route", async () => {
	const cap = makeIo();
	const previewCapture: PreviewCallCapture = { value: null };
	const code = await runCli(["add", "whiteboard", "--dry-run", "--json"], {
		io: cap.io,
		api: stubApi({
			previewAppLifecycle: (_target, id, action) => {
				previewCapture.value = { action, id };
				return Promise.resolve({
					action,
					dryRun: true,
					success: true,
					wouldInstall: true,
				});
			},
		}),
	});
	expect(code).toBe(0);
	const observed = previewCapture.value;
	expect(observed?.action ?? "").toBe("install");
	expect(observed?.id ?? "").toBe("whiteboard");
	expect(JSON.parse(cap.out()).dryRun).toBe(true);
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

test("action calls one known operation through Core with an explicit agent", async () => {
	const cap = makeIo();
	let capturedPath = "";
	let capturedMethod = "";
	let capturedBody: unknown;
	const code = await runCli(
		[
			"action",
			"app.support/save",
			'{"customer":"acme"}',
			"--agent",
			"support-agent",
			"--json",
		],
		{
			io: cap.io,
			api: stubApi({
				call: (_target, path, options) => {
					capturedPath = path;
					capturedMethod = options?.method ?? "";
					capturedBody = options?.body;
					return Promise.resolve({
						ok: true,
						output: { ticketId: "t-1" },
					});
				},
			}),
		}
	);
	expect(code).toBe(0);
	expect(capturedPath).toBe("/api/actions/app.support%2Fsave");
	expect(capturedMethod).toBe("POST");
	expect(capturedBody).toEqual({
		agent_id: "support-agent",
		arguments: { customer: "acme" },
	});
	expect(JSON.parse(cap.out())).toMatchObject({
		ok: true,
		output: { ticketId: "t-1" },
	});
});

test("action without an agent is a usage error", async () => {
	const cap = makeIo();
	const code = await runCli(["action", "app.support/save", "{}"], {
		io: cap.io,
		api: stubApi(),
	});
	expect(code).toBe(2);
	expect(cap.err()).toContain("--agent");
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
	expect(cap.out()).toContain("ryu-cli add <id>");
});

test("--version prints the version and exits 0", async () => {
	const cap = makeIo();
	const code = await runCli(["--version"], { io: cap.io, api: stubApi() });
	expect(code).toBe(0);
	expect(cap.out()).toMatch(/ryu-cli \d+\.\d+\.\d+/);
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
			uninstallApp: () => Promise.reject(lifecycleError),
		}),
	});
	expect(code).toBe(1);
	expect(cap.err()).toContain("Disable meetings first");
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
	const parsed = errorOutputObservation.parse(JSON.parse(cap.err()));
	expect(parsed.error).toBe("boom");
});
