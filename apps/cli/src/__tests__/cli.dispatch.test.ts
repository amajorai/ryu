// Unit tests for the non-interactive `ryu` CLI dispatcher. These prove argv routing
// (a known subcommand runs its handler; unknown/empty falls through to interactive),
// --json output shape, --help/--version, exit codes, and typed-409 error rendering.
// The HTTP layer is mocked via an injected CoreApi, so nothing hits a Core node.

import { expect, test } from "bun:test";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import type {
	AppInfo,
	AppRecord,
	CatalogEntry,
} from "@ryuhq/core-client/plugins";
import { z } from "zod";
import { isInteractive, parseArgs, runCli } from "../cli/dispatch.ts";
import type { CliIO, CoreApi } from "../cli/types.ts";

// These are test observations, not full publisher DTOs. Each admits the
// entire native JSON tree and preserves the raw root/future fields before
// checking the exact fields asserted below.
const auditOutputFields = z.looseObject({ reachable: z.boolean() });
const appListOutputFields = z.array(z.looseObject({ id: z.string() }));
const errorOutputFields = z.looseObject({ error: z.string() });
const chatOutputFields = z.looseObject({ text: z.string() });
const auditOutputObservation = z.custom<z.infer<typeof auditOutputFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		auditOutputFields.safeParse(value).success
);
const appListOutputObservation = z.custom<z.infer<typeof appListOutputFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		appListOutputFields.safeParse(value).success
);
const errorOutputObservation = z.custom<z.infer<typeof errorOutputFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		errorOutputFields.safeParse(value).success
);
const chatOutputObservation = z.custom<z.infer<typeof chatOutputFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		chatOutputFields.safeParse(value).success
);
type CoreCall = NonNullable<CoreApi["call"]>;
interface CapturedResourceCall {
	body?: NonNullable<Parameters<CoreCall>[2]>["body"];
	method?: NonNullable<Parameters<CoreCall>[2]>["method"];
	path?: Parameters<CoreCall>[1];
}
type PreviewCall = NonNullable<CoreApi["previewAppLifecycle"]>;
interface PreviewCallCapture {
	value: CapturedPreviewCall | null;
}
interface CapturedPreviewCall {
	action: Parameters<PreviewCall>[2];
	id: Parameters<PreviewCall>[1];
}

// ── Fixtures + fakes ──────────────────────────────────────────────────────────

function makeIo() {
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
		} satisfies CliIO,
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
	surfaceSupport: [],
	version: "1.0.0",
	windowsFirst: false,
};

/** A cli-only app contributing `ryu mail <cmd>` subcommands. */
const mailApp: AppInfo = {
	...sampleApp,
	id: "mail-contributor",
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

// ── Gateway / plugin doctor ──────────────────────────────────────────────────

const doctorReport = {
	counts: { errors: 0, info: 0, warnings: 0 },
	findings: [],
	posture: "balanced",
};

const pluginDoctorReport = {
	counts: { errors: 0, info: 0, plugins: 1, warnings: 0 },
	findings: [],
	plugins: [
		{
			findingCount: 0,
			id: "com.example.mail",
			name: "Mail",
			status: "healthy",
		},
	],
	score: 100,
};

const pluginEvalReport = {
	artifactKind: "app",
	baseline: { reason: "not run", status: "not_run" },
	cases: [
		{
			failed: 0,
			name: "search uses the app",
			passed: 1,
			score: 1,
			status: "passed",
		},
	],
	evidenceLevel: "plugin-agent",
	pluginId: "com.example.mail",
	score: 1,
	status: "passed",
	suite: {
		caseCount: 1,
		graderCount: 1,
		status: "ready",
		unsupportedGraders: [],
	},
};

test("doctor: read-only audit uses the GET endpoint", async () => {
	const cap = makeIo();
	let capturedPath = "";
	let capturedMethod = "";
	const code = await runCli(["doctor"], {
		io: cap.io,
		api: stubApi({
			call: (_target, path, options) => {
				capturedPath = path;
				capturedMethod = options?.method ?? "";
				return Promise.resolve(doctorReport);
			},
		}),
	});
	expect(code).toBe(0);
	expect(capturedPath).toBe("/api/gateway/doctor");
	expect(capturedMethod).toBe("GET");
	expect(cap.out()).toContain("Gateway Doctor");
});

test("observability audit: filters the shared Gateway audit endpoint", async () => {
	const cap = makeIo();
	let capturedPath = "";
	let capturedMethod = "";
	const code = await runCli(["observability", "audit", "--agent", "agent-1"], {
		io: cap.io,
		api: stubApi({
			call: (_target, path, options) => {
				capturedPath = path;
				capturedMethod = options?.method ?? "";
				return Promise.resolve({ reachable: true, entries: [] });
			},
		}),
	});
	expect(code).toBe(0);
	expect(capturedPath).toBe("/api/gateway/audit?limit=100&agent_id=agent-1");
	expect(capturedMethod).toBe("GET");
	const parsed = auditOutputObservation.parse(JSON.parse(cap.out()));
	expect(parsed.reachable).toBe(true);
});

test("observability audit-prune: invokes the owner maintenance endpoint", async () => {
	const cap = makeIo();
	let capturedPath = "";
	let capturedMethod = "";
	const code = await runCli(["observability", "audit-prune", "--json"], {
		io: cap.io,
		api: stubApi({
			call: (_target, path, options) => {
				capturedPath = path;
				capturedMethod = options?.method ?? "";
				return Promise.resolve({ deleted_rows: 3 });
			},
		}),
	});
	expect(code).toBe(0);
	expect(capturedPath).toBe("/api/gateway/audit/prune");
	expect(capturedMethod).toBe("POST");
	expect(JSON.parse(cap.out())).toEqual({ deleted_rows: 3 });
});

test("observability score: sends a completed response to online scoring", async () => {
	const cap = makeIo();
	let capturedPath = "";
	let capturedBody: unknown;
	const code = await runCli(
		[
			"observability",
			"score",
			"agent-1",
			'{"choices":[{"message":{"content":"done"}}]}',
			"gpt-4o-mini",
			"--json",
		],
		{
			io: cap.io,
			api: stubApi({
				call: (_target, path, options) => {
					capturedPath = path;
					capturedBody = options?.body;
					return Promise.resolve({ kind: "online_score" });
				},
			}),
		}
	);
	expect(code).toBe(0);
	expect(capturedPath).toBe("/api/gateway/evals/score");
	expect(capturedBody).toEqual({
		agent_id: "agent-1",
		model: "gpt-4o-mini",
		prompt: "ryu observability score",
		response: { choices: [{ message: { content: "done" } }] },
	});
});

test("trace: URL-encodes the run id and uses the Core trace route", async () => {
	const cap = makeIo();
	let capturedPath = "";
	const code = await runCli(["trace", "run/with spaces", "--json"], {
		io: cap.io,
		api: stubApi({
			call: (_target, path) => {
				capturedPath = path;
				return Promise.resolve({ spans: [] });
			},
		}),
	});
	expect(code).toBe(0);
	expect(capturedPath).toBe("/api/runs/run%2Fwith%20spaces/trace");
});

test("redteam: sends an agent-scoped security campaign", async () => {
	const cap = makeIo();
	let capturedPath = "";
	let capturedBody: unknown;
	const code = await runCli(["redteam", "agent-1", "gpt-4o-mini", "--json"], {
		io: cap.io,
		api: stubApi({
			call: (_target, path, options) => {
				capturedPath = path;
				capturedBody = options?.body;
				return Promise.resolve({
					summary: { needs_attention: 0, protected: 5, total: 5 },
				});
			},
		}),
	});
	expect(code).toBe(0);
	expect(capturedPath).toBe("/api/gateway/redteam/run");
	expect(capturedBody).toEqual({
		agent_id: "agent-1",
		model: "gpt-4o-mini",
	});
});

test("doctor --dry-run previews without applying", async () => {
	const cap = makeIo();
	let body: unknown;
	const code = await runCli(["doctor", "--dry-run", "--json"], {
		io: cap.io,
		api: stubApi({
			call: (_target, path, options) => {
				expect(path).toBe("/api/gateway/doctor/fix");
				expect(options?.method).toBe("POST");
				body = options?.body;
				return Promise.resolve({
					appliedFixes: [],
					dryRun: true,
					plannedFixes: [
						{
							action: "Enable PII and secret redaction",
							checkId: "security.redaction-disabled",
							settingPath: "firewall.redact_pii",
							summary: "Enable redaction",
						},
					],
					report: doctorReport,
				});
			},
		}),
	});
	expect(code).toBe(0);
	expect(body).toEqual({ dryRun: true });
	expect(JSON.parse(cap.out()).dryRun).toBe(true);
});

test("plugin doctor: audits an installed app and supports the app alias", async () => {
	const cap = makeIo();
	let capturedPath = "";
	const code = await runCli(["app", "doctor", "com.example.mail"], {
		io: cap.io,
		api: stubApi({
			call: (_target, path, options) => {
				capturedPath = path;
				expect(options?.method).toBe("GET");
				return Promise.resolve(pluginDoctorReport);
			},
		}),
	});
	expect(code).toBe(0);
	expect(capturedPath).toBe("/api/plugins/doctor?id=com.example.mail");
	expect(cap.out()).toContain("com.example.mail");
	expect(cap.out()).toContain("no findings");
});

test("plugin eval: runs an installed app suite and returns its score", async () => {
	const cap = makeIo();
	let capturedPath = "";
	let capturedBody: unknown;
	const code = await runCli(["plugin", "eval", "com.example.mail"], {
		io: cap.io,
		api: stubApi({
			call: (_target, path, options) => {
				capturedPath = path;
				capturedBody = options?.body;
				expect(options?.method).toBe("POST");
				return Promise.resolve(pluginEvalReport);
			},
		}),
	});
	expect(code).toBe(0);
	expect(capturedPath).toBe("/api/plugins/evals/run");
	expect(capturedBody).toEqual({ id: "com.example.mail" });
	expect(cap.out()).toContain("Plugin Evals");
	expect(cap.out()).toContain("100/100");
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
	const parsed = errorOutputObservation.parse(JSON.parse(cap.err()));
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
	const parsed = chatOutputObservation.parse(JSON.parse(cap.out()));
	expect(parsed.text).toBe("full reply");
});

test("chat opens a continuation turn on a new paragraph", async () => {
	const cap = makeIo();
	const code = await runCli(["chat", "hi", "--json"], {
		io: cap.io,
		api: stubApi({
			streamChat: (_t, _turns, _o, handlers) => {
				handlers.onTextDelta("Done step A.");
				handlers.onTurnBoundary?.();
				handlers.onTextDelta("Now step B");
				handlers.onTextDelta(".");
				handlers.onDone();
				return Promise.resolve();
			},
		}),
	});
	expect(code).toBe(0);
	const parsed = chatOutputObservation.parse(JSON.parse(cap.out()));
	expect(parsed.text).toBe("Done step A.\n\nNow step B.");
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
	const code = await runCli(["mail-contributor", "status"], {
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
	expect(capturedId).toBe("mail-contributor");
	expect(capturedPath).toBe("/status");
	expect(capturedMethod).toBe("GET");
	expect(cap.out()).toContain("ok");
	expect(cap.err()).toBe("");
});

test("app command passes trailing args through to the sidecar", async () => {
	const cap = makeIo();
	let receivedArgs: string[] = [];
	await runCli(["mail-contributor", "send", "a@b.com", "hi"], {
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
	const code = await runCli(["mail-contributor"], {
		io: cap.io,
		api: stubApi({ fetchApps: () => Promise.resolve([mailApp]) }),
	});
	expect(code).toBe(0);
	expect(cap.out()).toContain("status");
	expect(cap.out()).toContain("Show inbox status");
	expect(cap.out()).toContain("ryu-cli mail-contributor send");
});

test("unknown subcommand for a known app is a usage error listing options", async () => {
	const cap = makeIo();
	const code = await runCli(["mail-contributor", "bogus"], {
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
	const code = await runCli(["mail-contributor", "status"], {
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
	const code = await runCli(["mail-contributor", "status"], {
		io: cap.io,
		api: stubApi({
			fetchApps: () => Promise.resolve([mailApp]),
			execAppCommand: () => Promise.resolve({ status: 500, body: "boom" }),
		}),
	});
	expect(code).toBe(1);
	expect(cap.err()).toContain("boom");
});

test("built-in mail sends resource requests with JSON bodies", async () => {
	const cap = makeIo();
	let called: CapturedResourceCall = {};
	const code = await runCli(
		[
			"mail",
			"send",
			"inbox-1",
			'{"to":["person@example.com"],"subject":"Hi","text":"Body"}',
		],
		{
			io: cap.io,
			api: stubApi({
				call: (_target, path, options) => {
					called = { body: options?.body, method: options?.method, path };
					return Promise.resolve({ message: { id: "sent-1" } });
				},
			}),
		}
	);
	expect(code).toBe(0);
	expect(called).toEqual({
		body: { to: ["person@example.com"], subject: "Hi", text: "Body" },
		method: "POST",
		path: "/api/mail/inboxes/inbox-1/send",
	});
});
