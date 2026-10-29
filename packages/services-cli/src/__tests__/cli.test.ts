import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { RyuFetch } from "@ryuhq/services";
import {
	NPM_PUBLISHED_VERSION,
	Ryu,
	RyuConfigurationError,
	RyuError,
	RyuWebhookVerificationError,
} from "@ryuhq/services";
import { RYU_TOOLS } from "@ryuhq/services/tools";
import packageJson from "../../package.json";
import {
	CliUsageError,
	firstPositional,
	GLOBAL_FLAGS,
	mergeFlagSpecs,
	parseTokens,
	requireStringFlag,
	stringFlag,
} from "../args.ts";
import {
	type CliIo,
	DEFAULT_PROGRAM,
	exitCodeFor,
	MCP_CLIENT_EXAMPLE,
	mcpClientExample,
	runCli,
	workspaceMcpExample,
} from "../cli.ts";
import { DOCTOR_FLAGS } from "../commands/doctor.ts";
import { runWebhooksVerify } from "../commands/webhooks.ts";
import { workspaceProgram } from "../program.ts";
import {
	bindCallOptions,
	CLI_SERVICES,
	type CliService,
	type CommandIo,
	matchCommand,
	SERVICE_COMMANDS,
	type ServiceCommand,
} from "../registry.ts";
import {
	NPM_INSTALL_CALLOUT,
	NPM_STATUS_CLAUSE,
	NPM_STATUS_NOTE,
	npmStatusNote,
} from "../version.ts";

interface Captured {
	readonly io: CliIo;
	stderr(): string;
	stdout(): string;
}

function capture(overrides: Partial<CliIo> = {}): Captured {
	let out = "";
	let err = "";
	return {
		io: {
			env: {},
			stdin: "",
			stdout: { write: (chunk: string) => (out += chunk) },
			stderr: { write: (chunk: string) => (err += chunk) },
			fetch: () => Promise.reject(new Error("unexpected network call")),
			...overrides,
		},
		stdout: () => out,
		stderr: () => err,
	};
}

const NOTIFY_ENV = {
	RYU_NOTIFY_URL: "https://notify.example.com",
	RYU_NOTIFY_API_KEY: "notify-secret-key",
};

function notifyError(status: number, code: string): Response {
	const error = {
		code,
		message: `notify said ${code}`,
		requestId: "req_42",
		status,
	};
	return new Response(
		JSON.stringify({ ok: false, type: "notify.error", ...error, error }),
		{
			status,
			headers: { "content-type": "application/json", "x-request-id": "req_42" },
		}
	);
}

/** A fake service exercising the framework, so the tests do not depend on the service work packages. */
function fakeService(commands: readonly ServiceCommand[]): CliService[] {
	return CLI_SERVICES.map((entry) =>
		entry.name === "notify"
			? { ...entry, title: "Fake Notify", commands }
			: entry
	);
}

const publish: ServiceCommand = {
	path: ["publish"],
	summary: "Publish an event.",
	flags: {
		title: { type: "string", description: "Title." },
		tag: { type: "strings", description: "Tag." },
	},
	// No `.with(ctx.call)`: ctx.ryu is already bound, so --idempotency-key still reaches the wire.
	run: (ctx) =>
		ctx.ryu.notify.publish({ title: requireStringFlag(ctx.flags, "title") }),
};

const echo: ServiceCommand = {
	path: ["events", "echo"],
	summary: "Echo arguments.",
	usage: "<id>",
	readOnly: true,
	flags: { tag: { type: "strings", description: "Tag." } },
	run: (ctx) => ({
		args: ctx.args,
		rest: ctx.rest,
		tags: ctx.flags.tag ?? null,
	}),
};

const stream: ServiceCommand = {
	path: ["events", "stream"],
	summary: "Stream events.",
	async *run() {
		yield { n: 1 };
		yield { n: 2 };
	},
};

const SERVICES = fakeService([publish, echo, stream]);

describe("parseTokens", () => {
	const specs = mergeFlagSpecs(GLOBAL_FLAGS, {
		title: { type: "string", description: "" },
		to: { type: "strings", description: "" },
		limit: { type: "number", description: "" },
	});

	test("reads values, inline values, booleans, lists and the -- rest", () => {
		const parsed = parseTokens(
			[
				"events",
				"--title",
				"Deploy",
				"--limit=5",
				"--json",
				"--to",
				"a@example.com",
				"-h",
				"--to=b@example.com",
				"get",
				"--",
				"ls",
				"--json",
			],
			specs
		);
		expect(parsed.positionals).toEqual(["events", "get"]);
		expect(parsed.rest).toEqual(["ls", "--json"]);
		expect(parsed.flags).toEqual({
			title: "Deploy",
			limit: 5,
			json: true,
			help: true,
			to: ["a@example.com", "b@example.com"],
		});
	});

	test("rejects unknown flags, missing values, bad numbers and valued booleans", () => {
		expect(() => parseTokens(["--nope"], specs)).toThrow(CliUsageError);
		expect(() => parseTokens(["--title"], specs)).toThrow("needs a value");
		expect(() => parseTokens(["--title", "--"], specs)).toThrow(
			"needs a value"
		);
		expect(() => parseTokens(["--limit", "ten"], specs)).toThrow(
			"expects a number"
		);
		expect(() => parseTokens(["--json=false"], specs)).toThrow(
			"does not take a value"
		);
	});

	test("firstPositional skips the values of value flags", () => {
		expect(
			firstPositional(
				["--base-url", "http://x.example.com", "--json", "notify"],
				GLOBAL_FLAGS
			)
		).toEqual({ index: 3, value: "notify" });
		expect(firstPositional(["--json"], GLOBAL_FLAGS)).toBeNull();
		expect(firstPositional(["--", "notify"], GLOBAL_FLAGS)).toBeNull();
	});

	test("mergeFlagSpecs refuses one name with two types", () => {
		expect(() =>
			mergeFlagSpecs(
				{ limit: { type: "number", description: "" } },
				{ limit: { type: "string", description: "" } }
			)
		).toThrow("declared as both");
	});

	test("flag helpers", () => {
		expect(stringFlag({ a: "x" }, "a")).toBe("x");
		expect(stringFlag({ a: true }, "a")).toBeUndefined();
		expect(() => requireStringFlag({}, "title")).toThrow("--title is required");
	});
});

describe("registry", () => {
	test("SERVICE_COMMANDS covers exactly the CLI services", () => {
		expect(Object.keys(SERVICE_COMMANDS).sort()).toEqual(
			[
				"box",
				"connect",
				"gateway",
				"mail",
				"managed-agents",
				"messaging",
				"notify",
				"passport",
				"sites",
			].sort()
		);
	});

	test("every service's command flags parse one way and leave the global flags alone", () => {
		for (const entry of CLI_SERVICES) {
			const paths = new Set<string>();
			for (const command of entry.commands) {
				const key = command.path.join(" ");
				expect(paths.has(key)).toBe(false);
				paths.add(key);
				expect(command.summary.length).toBeGreaterThan(0);
				for (const name of Object.keys(command.flags ?? {})) {
					expect(Object.hasOwn(GLOBAL_FLAGS, name)).toBe(false);
				}
			}
			expect(() =>
				mergeFlagSpecs(
					GLOBAL_FLAGS,
					...entry.commands.map((command) => command.flags ?? {})
				)
			).not.toThrow();
		}
	});

	test("matchCommand picks the longest path", () => {
		const short: ServiceCommand = {
			path: ["events"],
			summary: "s",
			run: () => null,
		};
		const long: ServiceCommand = {
			path: ["events", "get"],
			summary: "l",
			run: () => null,
		};
		expect(matchCommand([short, long], ["events", "get", "id1"])).toEqual({
			command: long,
			args: ["id1"],
		});
		expect(matchCommand([short, long], ["events", "x"])).toEqual({
			command: short,
			args: ["x"],
		});
		expect(matchCommand([long], ["other"])).toBeNull();
	});
});

describe("runCli", () => {
	test("--help prints the root help to stdout and exits 0", async () => {
		const run = capture();
		expect(await runCli(["--help"], run.io)).toBe(0);
		expect(run.stdout()).toContain("ryu-services <service> <command>");
		expect(run.stdout()).toContain("managed-agents");
	});

	test("--version and -V print the package version and exit 0", async () => {
		for (const flag of ["--version", "-V"]) {
			const run = capture();
			expect(await runCli([flag], run.io)).toBe(0);
			expect(run.stdout().trim()).toBe(packageJson.version);
			// stdout stays the bare version; the npm-status note is on stderr.
			expect(run.stderr()).toBe(`note: ${NPM_STATUS_NOTE}\n`);
		}
		const json = capture();
		expect(await runCli(["--version", "--json"], json.io)).toBe(0);
		expect(json.stderr()).toBe("");
		expect(JSON.parse(json.stdout())).toEqual({
			data: {
				name: "ryu-services",
				npmNote: NPM_STATUS_NOTE,
				npmPublishedVersion: null,
				version: packageJson.version,
			},
			meta: null,
		});
		const help = capture();
		expect(await runCli(["--help"], help.io)).toBe(0);
		expect(help.stdout()).toContain("-V, --version");
		// It is listed apart from the global flags, which work after a command.
		const [globalSection, rootOnlySection] = help
			.stdout()
			.split("With no command only");
		expect(globalSection).not.toContain("--version");
		expect(rootOnlySection).toContain("-V, --version");
		// Only the root takes it: a command still refuses the unknown flag.
		const scoped = capture();
		expect(await runCli(["doctor", "--version"], scoped.io)).toBe(2);
	});

	test("the npm-status note names the workspace build and the published clause", () => {
		// Flip with NPM_PUBLISHED_VERSION: the note exists only while unpublished.
		expect(NPM_PUBLISHED_VERSION).toBeNull();
		expect(NPM_STATUS_NOTE).toBe(
			`This @ryuhq/services-cli is a workspace build, not an npm install. ${NPM_STATUS_CLAUSE}`
		);
		// The runtime note drops the callout's @ryuhq/client freshness clause,
		// which nothing in a built binary would notice going stale.
		expect(NPM_INSTALL_CALLOUT.startsWith(NPM_STATUS_CLAUSE.slice(0, -1))).toBe(
			true
		);
		expect(NPM_STATUS_NOTE).not.toContain("latest is");
		expect(npmStatusNote({ publishedVersion: null, bundledWith: " " })).toBe(
			NPM_STATUS_NOTE
		);
		expect(
			npmStatusNote({ publishedVersion: null, bundledWith: "ryu-cli 9.9.9" })
		).toBe(
			`This command line is bundled with ryu-cli 9.9.9, not installed from npm. ${NPM_STATUS_CLAUSE}`
		);
		for (const bundledWith of [undefined, "ryu-cli 9.9.9"]) {
			expect(
				npmStatusNote({
					publishedVersion: "1.0.0",
					...(bundledWith === undefined ? {} : { bundledWith }),
				})
			).toBeNull();
		}
		// `standalone-sdk-docs.test.ts` checks the callout and the note against
		// the docs' CLI page.
	});

	test("--version names a bundling host and prints no note once published", async () => {
		const bundled = capture({ bundledWith: "ryu-cli 9.9.9" });
		expect(await runCli(["--version"], bundled.io)).toBe(0);
		expect(bundled.stderr()).toBe(
			`note: ${npmStatusNote({ publishedVersion: null, bundledWith: "ryu-cli 9.9.9" })}\n`
		);

		const published = capture({ npmPublishedVersion: "1.2.3" });
		expect(await runCli(["--version"], published.io)).toBe(0);
		expect(published.stdout()).toBe(`${packageJson.version}\n`);
		expect(published.stderr()).toBe("");
		const json = capture({
			bundledWith: "ryu-cli 9.9.9",
			npmPublishedVersion: "1.2.3",
		});
		expect(await runCli(["--version", "--json"], json.io)).toBe(0);
		expect(json.stderr()).toBe("");
		expect(JSON.parse(json.stdout())).toEqual({
			data: {
				name: "ryu-services",
				npmNote: null,
				npmPublishedVersion: "1.2.3",
				version: packageJson.version,
			},
			meta: null,
		});
	});

	test("no arguments prints help to stderr and exits 2", async () => {
		const run = capture();
		expect(await runCli([], run.io)).toBe(2);
		expect(run.stderr()).toContain("Usage:");
		expect(run.stdout()).toBe("");
	});

	test("unknown commands and flags exit 2", async () => {
		const run = capture();
		expect(await runCli(["frobnicate"], run.io)).toBe(2);
		expect(run.stderr()).toContain('Unknown command "frobnicate"');
		expect(
			await runCli(["notify", "publish", "--bogus"], run.io, {
				services: SERVICES,
			})
		).toBe(2);
		expect(
			await runCli(["notify", "nope"], run.io, { services: SERVICES })
		).toBe(2);
		expect(run.stderr()).toContain('Unknown notify command "nope"');
	});

	test("a flag of another command is rejected", async () => {
		const run = capture();
		expect(
			await runCli(["notify", "events", "echo", "--title", "x"], run.io, {
				services: SERVICES,
			})
		).toBe(2);
		expect(run.stderr()).toContain("does not take --title");
	});

	test("--json usage errors are a JSON error object on stdout", async () => {
		const run = capture({ npmPublishedVersion: "1.2.3" });
		expect(await runCli(["frobnicate", "--json"], run.io)).toBe(2);
		expect(JSON.parse(run.stdout())).toEqual({
			error: {
				code: "usage_error",
				message: 'Unknown command "frobnicate".',
				hint: "Run ryu-services --help for usage.",
			},
		});
	});

	test("positionals, the -- rest and list flags reach the command; --json wraps { data, meta }", async () => {
		const run = capture();
		const code = await runCli(
			[
				"notify",
				"events",
				"echo",
				"evt_1",
				"--json",
				"--tag",
				"a",
				"--tag",
				"b",
				"--",
				"x",
				"--y",
			],
			run.io,
			{ services: SERVICES }
		);
		expect(code).toBe(0);
		const printed = JSON.parse(run.stdout()) as {
			data: unknown;
			meta: { status: number };
		};
		expect(printed.data).toEqual({
			args: ["evt_1"],
			rest: ["x", "--y"],
			tags: ["a", "b"],
		});
		expect(printed.meta.status).toBe(0);
	});

	test("human output prints the data as indented JSON", async () => {
		const run = capture();
		expect(
			await runCli(["notify", "events", "echo", "e"], run.io, {
				services: SERVICES,
			})
		).toBe(0);
		expect(run.stdout()).toContain('"args": [\n');
	});

	test("async iterables print one JSON line per item", async () => {
		const run = capture();
		expect(
			await runCli(["notify", "events", "stream"], run.io, {
				services: SERVICES,
			})
		).toBe(0);
		expect(run.stdout()).toBe('{"n":1}\n{"n":2}\n');
	});

	test("service and command help", async () => {
		const run = capture();
		expect(
			await runCli(["notify", "--help"], run.io, { services: SERVICES })
		).toBe(0);
		expect(run.stdout()).toContain("ryu-services notify events echo <id>");
		expect(
			await runCli(["notify", "publish", "--help"], run.io, {
				services: SERVICES,
			})
		).toBe(0);
		expect(run.stdout()).toContain(
			"Usage: ryu-services notify publish [flags]"
		);
		expect(run.stdout()).toContain("--title <value>");
		expect(
			await runCli(["help", "notify"], run.io, { services: SERVICES })
		).toBe(0);
	});

	test("a RyuError exits 1 and prints code, message, requestId and hint", async () => {
		const run = capture({
			env: NOTIFY_ENV,
			fetch: async () => notifyError(401, "unauthorized"),
		});
		expect(
			await runCli(["notify", "publish", "--title", "x"], run.io, {
				services: SERVICES,
			})
		).toBe(1);
		expect(run.stderr()).toContain(
			"error unauthorized: notify said unauthorized"
		);
		expect(run.stderr()).toContain("requestId: req_42");
		expect(run.stderr()).toContain("status: 401");
		expect(run.stderr()).not.toContain("notify-secret-key");
	});

	test("--json RyuErrors print { error } with RyuError.toJSON() on stdout", async () => {
		const run = capture({
			env: NOTIFY_ENV,
			fetch: async () => notifyError(404, "not_found"),
		});
		expect(
			await runCli(["notify", "publish", "--title", "x", "--json"], run.io, {
				services: SERVICES,
			})
		).toBe(1);
		const printed = JSON.parse(run.stdout()) as {
			error: { code: string; requestId: string; service: string };
		};
		expect(printed.error).toMatchObject({
			code: "not_found",
			requestId: "req_42",
			service: "notify",
		});
		expect(run.stdout()).not.toContain("notify-secret-key");
	});

	test("a configuration error exits 2 and names the env var", async () => {
		// Notify's URL defaults to hosted Notify; its key has no default.
		const run = capture();
		expect(
			await runCli(["notify", "publish", "--title", "x"], run.io, {
				services: SERVICES,
			})
		).toBe(2);
		expect(run.stderr()).toContain("RYU_NOTIFY_API_KEY");
	});

	test("--idempotency-key, --base-url and --api-key reach the wire", async () => {
		const seen: Request[] = [];
		const fetch: RyuFetch = async (input, init) => {
			seen.push(new Request(input, init));
			return notifyError(401, "unauthorized");
		};
		const run = capture({ fetch });
		const code = await runCli(
			[
				"notify",
				"publish",
				"--title",
				"x",
				"--base-url",
				"https://flag.example.com",
				"--api-key",
				"flag-key",
				"--idempotency-key",
				"deploy-4821",
			],
			run.io,
			{ services: SERVICES }
		);
		expect(code).toBe(1);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.url).toBe("https://flag.example.com/v1/events");
		expect(seen[0]?.headers.get("authorization")).toBe("Bearer flag-key");
		expect(seen[0]?.headers.get("idempotency-key")).toBe("deploy-4821");
	});

	test("bindCallOptions binds every namespace, ryu.safe included, and is a no-op without options", async () => {
		const seen: Request[] = [];
		const fetch: RyuFetch = async (input, init) => {
			seen.push(new Request(input, init));
			return notifyError(401, "unauthorized");
		};
		const ryu = new Ryu({ env: NOTIFY_ENV, fetch, maxRetries: 0 });
		expect(bindCallOptions(ryu, {})).toBe(ryu);
		const bound = bindCallOptions(ryu, { idempotencyKey: "bound-1" });
		expect(bound.isConfigured("notify")).toBe(true);
		const { error } = await bound.safe.notify.publish({ title: "a" });
		expect(error?.code).toBe("unauthorized");
		await expect(
			bound.notify.with({}).publish({ title: "b" })
		).rejects.toMatchObject({ code: "unauthorized" });
		expect(
			seen.map((request) => request.headers.get("idempotency-key"))
		).toEqual(["bound-1", "bound-1"]);
	});

	test("bad --timeout and --max-retries values exit 2", async () => {
		const run = capture({ env: NOTIFY_ENV });
		expect(
			await runCli(
				["notify", "publish", "--title", "x", "--max-retries", "-1"],
				run.io,
				{ services: SERVICES }
			)
		).toBe(2);
		expect(
			await runCli(
				["notify", "publish", "--title", "x", "--timeout", "1.5"],
				run.io,
				{ services: SERVICES }
			)
		).toBe(2);
	});

	test("connect prints a pointer to its /mcp endpoint", async () => {
		const run = capture({
			env: {
				RYU_CONNECT_URL: "https://connect.example.com/?token=abc",
				RYU_CONNECT_API_KEY: "connect-secret",
			},
		});
		expect(await runCli(["connect"], run.io)).toBe(0);
		expect(run.stdout()).toContain("https://connect.example.com/mcp");
		expect(run.stdout()).toContain("$RYU_CONNECT_API_KEY");
		expect(run.stdout()).not.toContain("connect-secret");
		expect(run.stdout()).not.toContain("token=abc");
		// No pointer to Ryu CLI connect commands, which do not exist; account
		// and trigger management point at the Connect API page instead.
		expect(run.stdout()).not.toContain("Ryu CLI");
		expect(run.stdout()).toContain(
			"https://docs.ryuhq.com/docs/standalone/connect-api-triggers"
		);

		const other = capture();
		expect(await runCli(["connect", "tools", "list"], other.io)).toBe(2);
		expect(other.stderr()).toContain(
			'error usage_error: Unknown connect command "tools list".'
		);
		expect(other.stderr()).toContain("$RYU_CONNECT_URL/mcp");

		const json = capture();
		expect(await runCli(["connect", "--json"], json.io)).toBe(0);
		expect((JSON.parse(json.stdout()) as { data: string }).data).toContain(
			"/mcp"
		);
	});

	test("a command group alone lists that group's commands", async () => {
		const run = capture();
		expect(await runCli(["mail", "inboxes"], run.io)).toBe(2);
		expect(run.stderr()).toContain("ryu-services mail inboxes list");
		expect(run.stderr()).not.toContain("ryu-services mail send");
		expect(run.stderr()).not.toContain("Unknown mail command");

		const help = capture();
		expect(await runCli(["passport", "connections", "--help"], help.io)).toBe(
			0
		);
		expect(help.stdout()).toContain("ryu-services passport connections list");

		const unknown = capture();
		expect(await runCli(["mail", "inboxes", "nope"], unknown.io)).toBe(2);
		expect(unknown.stderr()).toContain('Unknown mail command "inboxes nope"');
	});

	test("webhooks verify without --secret is a usage error", async () => {
		const run = capture({ stdin: "{}" });
		expect(
			await runCli(
				["webhooks", "verify", "--service", "mail", "--headers", "{}"],
				run.io
			)
		).toBe(2);
		expect(run.stderr()).toContain("A signing secret is required");
		expect(run.stderr()).toContain("RYU_WEBHOOK_SECRET");
		expect(await runCli(["webhooks", "sign"], run.io)).toBe(2);
		expect(
			await runCli(
				[
					"webhooks",
					"verify",
					"--service",
					"sms",
					"--secret",
					"s",
					"--headers",
					"{}",
				],
				run.io
			)
		).toBe(2);
		expect(
			await runCli(
				[
					"webhooks",
					"verify",
					"--service",
					"mail",
					"--kind",
					"callback",
					"--secret",
					"s",
					"--headers",
					"{}",
				],
				run.io
			)
		).toBe(2);
		expect(
			await runCli(
				[
					"webhooks",
					"verify",
					"--service",
					"mail",
					"--secret",
					"s",
					"--headers",
					"[1]",
				],
				run.io
			)
		).toBe(2);
	});

	test("webhooks verify rejects request flags instead of ignoring them", async () => {
		for (const flag of [
			["--dry-run"],
			["--api-key", "k"],
			["--base-url", "https://x.example.com"],
			["--idempotency-key", "i"],
			["--max-retries", "1"],
			["--timeout", "5"],
		]) {
			const run = capture({ stdin: "{}" });
			expect(
				await runCli(
					[
						"webhooks",
						"verify",
						"--service",
						"mail",
						"--secret",
						"s",
						"--headers",
						"{}",
						...flag,
					],
					run.io
				)
			).toBe(2);
			expect(run.stderr()).toContain(
				`${workspaceProgram()} webhooks verify does not take ${flag[0]}`
			);
		}
	});

	test("mcp rejects unknown services and flags before serving", async () => {
		const run = capture();
		expect(await runCli(["mcp", "--services", "notify,sms"], run.io)).toBe(2);
		expect(run.stderr()).toContain('Unknown service "sms"');
		expect(await runCli(["mcp", "--dry-run"], run.io)).toBe(2);
		expect(await runCli(["mcp", "--help"], run.io)).toBe(0);
		expect(run.stdout()).toContain("--allow-writes");
		expect(run.stdout()).toContain("--read-only");
		// Matches doctor and cli.mdx: status tools need no credentials. The
		// names listed are exactly the registry's credential-free tools.
		const credentialFree = RYU_TOOLS.filter((tool) => tool.credentialFree)
			.map((tool) => tool.name)
			.sort()
			.join(", ");
		expect(credentialFree).toBe("mail_status, messaging_status");
		expect(run.stdout()).toContain(
			"except the credential-free status tools (mail_status, messaging_status), which are registered even when Mail or Messaging is not configured unless --services leaves that service out"
		);
	});

	test("a workspace build's mcp --help runs this checkout's bin with bun, not an uninstalled ryu-services", async () => {
		const run = capture({ npmPublishedVersion: null });
		expect(await runCli(["mcp", "--help"], run.io)).toBe(0);
		const text = run.stdout();
		const start = text.indexOf("  {\n");
		const end = text.indexOf("\n  }\n", start);
		const entry = JSON.parse(text.slice(start, end + 4)) as {
			mcpServers: Record<string, { args: string[]; command: string }>;
		};
		const server = entry.mcpServers["ryu-services"];
		expect(server?.command).toBe("bun");
		expect(server?.args[0]).toMatch(/packages\/services-cli\/src\/bin\.ts$/u);
		expect(server?.args.slice(1)).toEqual(["mcp", "--services", "notify,box"]);
		expect(text).not.toContain('"command": "ryu-services"');
		expect(text).not.toContain("-- ryu-services mcp");
		expect(text).toMatch(
			/-- bun \S+\/packages\/services-cli\/src\/bin\.ts mcp --services notify/u
		);
		expect(text).toContain(
			"This is a workspace build, which installs no ryu-services executable, so the entry runs this checkout's bin with bun."
		);
	});

	test("workspaceMcpExample quotes a checkout path with spaces in the claude mcp add line", () => {
		const lines = workspaceMcpExample(["bun", "/My Code/ryu/bin.ts"]);
		expect(lines.join("\n")).toContain(
			"-- bun '/My Code/ryu/bin.ts' mcp --services notify"
		);
		expect(lines.join("\n")).toContain('"args": ["/My Code/ryu/bin.ts", "mcp"');
	});

	test("mcp --help prints an MCP client entry that parses as JSON", async () => {
		const run = capture({ npmPublishedVersion: "1.0.0" });
		expect(await runCli(["mcp", "--help"], run.io)).toBe(0);
		const text = run.stdout();
		expect(text).toContain("claude_desktop_config.json, .mcp.json");
		const start = text.indexOf("  {\n");
		const end = text.indexOf("\n  }\n", start);
		const entry = JSON.parse(text.slice(start, end + 4)) as {
			mcpServers: Record<string, { args: string[]; command: string }>;
		};
		expect(entry.mcpServers["ryu-services"]).toMatchObject({
			command: "ryu-services",
			args: ["mcp", "--services", "notify,box"],
		});
		expect(text).toContain("claude mcp add ryu-services");
		expect(text).toContain(
			"Docs: https://docs.ryuhq.com/docs/standalone/sdk/mcp"
		);
		expect(text).toContain("Usage: ryu-services mcp [flags]");
		expect(text).toContain("-- ryu-services mcp --services notify");
	});

	test("mcp --help renders the entry for the host program that delegates to it", async () => {
		const run = capture();
		expect(
			await runCli(["mcp", "--help"], {
				...run.io,
				program: "ryu-cli services",
			})
		).toBe(0);
		const text = run.stdout();
		expect(text).toContain("Usage: ryu-cli services mcp [flags]");
		expect(text).toContain("run `ryu-cli services doctor` to check");
		const start = text.indexOf("  {\n");
		const end = text.indexOf("\n  }\n", start);
		const entry = JSON.parse(text.slice(start, end + 4)) as {
			mcpServers: Record<string, { args: string[]; command: string }>;
		};
		expect(entry.mcpServers["ryu-services"]).toMatchObject({
			command: "ryu-cli",
			args: ["services", "mcp", "--services", "notify,box"],
		});
		expect(text).toContain(
			"claude mcp add ryu-services --env RYU_NOTIFY_API_KEY=<key> -- ryu-cli services mcp --services notify"
		);
		expect(text).not.toContain('"command": "ryu-services"');
	});

	test("ryu-cli services names itself in every help, usage, example and hint line", async () => {
		const program = { program: "ryu-cli services" };
		const commandLine = /(?<![\w"@/.-])(?<!mcp add )ryu-services /u;
		const outputs: string[] = [];
		for (const argv of [
			["--help"],
			["box", "--help"],
			["mail", "send", "--help"],
			["notify", "publish", "--help"],
			["doctor", "--help"],
			["webhooks", "--help"],
		]) {
			const run = capture(program);
			expect(await runCli(argv, run.io)).toBe(0);
			outputs.push(run.stdout());
		}
		const [root, box, mailSend] = outputs;
		expect(root).toContain("ryu-cli services <service> <command>");
		// The --version line stays true under a host: it prints this package's
		// version, and the stderr note is not always "a workspace build".
		expect(root).toContain("Print the @ryuhq/services-cli version and exit.");
		expect(root).not.toContain("workspace build");
		expect(box).toContain("ryu-cli services box list");
		expect(mailSend).toContain("Usage: ryu-cli services mail send");
		expect(mailSend).toContain("  ryu-cli services mail send --from");
		for (const text of outputs) {
			expect(text).not.toMatch(commandLine);
		}
		// A usage error and its hint.
		const usage = capture(program);
		expect(await runCli(["box", "get"], usage.io)).toBe(2);
		expect(usage.stderr()).toContain("Run ryu-cli services box get --help");
		expect(usage.stderr()).not.toMatch(commandLine);
		const unknown = capture(program);
		expect(await runCli(["box", "nope"], unknown.io)).toBe(2);
		expect(unknown.stderr()).toContain("Run ryu-cli services box --help.");
		expect(unknown.stderr()).toContain(
			"Run ryu-cli services --help for usage."
		);
		const json = capture(program);
		expect(await runCli(["box", "get", "--json"], json.io)).toBe(2);
		expect(json.stdout()).toContain("ryu-cli services box get --help");
		expect(json.stdout()).not.toMatch(commandLine);
	});

	test("ryu-cli services rewrites the SDK's connection hint to its own doctor command", async () => {
		const program = { program: "ryu-cli services" };
		const unreachable: RyuFetch = () =>
			Promise.reject(new TypeError("fetch failed"));
		for (const json of [false, true]) {
			const run = capture({
				...program,
				env: NOTIFY_ENV,
				fetch: unreachable,
			});
			const argv = ["notify", "events", "list", "--max-retries", "0"];
			expect(await runCli(json ? [...argv, "--json"] : argv, run.io)).toBe(1);
			const text = json ? run.stdout() : run.stderr();
			expect(text).toContain("ryu-cli services doctor --check");
			expect(text).not.toContain("ryu-services doctor");
		}
	});

	test("ryu-cli services doctor names its own command in every hint, human and --json", async () => {
		const commandLine = /(?<![\w"@/.-])(?<!mcp add )ryu-services /u;
		for (const json of [false, true]) {
			const run = capture({ program: "ryu-cli services", env: {} });
			const argv = json ? ["doctor", "--json"] : ["doctor"];
			expect(await runCli(argv, run.io)).toBe(0);
			const text = run.stdout();
			// Human output spells out the missing variables instead of the
			// hint; --json carries each service's hint.
			if (json) {
				expect(text).toContain("`ryu-cli services box` command");
			}
			expect(text).not.toMatch(commandLine);
			expect(text).not.toContain("a `ryu-services");
		}
	});

	test("mcpClientExample defaults to ryu-services and ignores a blank program", () => {
		expect(mcpClientExample()).toEqual([...MCP_CLIENT_EXAMPLE]);
		expect(mcpClientExample("  ")).toEqual([...MCP_CLIENT_EXAMPLE]);
		expect(mcpClientExample(DEFAULT_PROGRAM)).toContain(
			'        "command": "ryu-services",'
		);
	});
});

/** Every service's env, so each command's configuration resolves. */
const ALL_SERVICES_ENV = {
	RYU_API_KEY: "ryu_guard",
	RYU_ORGANIZATION_ID: "org_guard",
	RYU_MAIL_URL: "http://127.0.0.1:7996",
	RYU_MAIL_API_KEY: "guard",
	RYU_NOTIFY_API_KEY: "guard",
	RYU_BOX_API_KEY: "guard",
	RYU_GATEWAY_URL: "http://127.0.0.1:7981",
	RYU_CONNECT_URL: "http://127.0.0.1:8090",
	RYU_CONNECT_API_KEY: "guard",
	RYU_PASSPORT_URL: "http://127.0.0.1:8093",
	RYU_PASSPORT_API_KEY: "guard",
	RYU_SITES_URL: "http://127.0.0.1:8021",
	RYU_SITES_API_KEY: "guard",
};

/** Placeholder positionals for a usage synopsis (`<id> -- <cmd…>` gives `x -- ls`). */
function placeholderArgs(usage: string | undefined): string[] {
	if (usage === undefined) {
		return [];
	}
	const [before = "", after] = usage.split(" -- ");
	const args = before
		.split(" ")
		.filter((word) => word.startsWith("<") || word.startsWith('"<'))
		.map(() => "x");
	return after === undefined ? args : [...args, "--", "ls"];
}

describe("command help", () => {
	test("doctor --check lists the Messaging settings probe", async () => {
		expect(DOCTOR_FLAGS.check?.description).toContain(
			"Messaging /api/messaging/orgs/{orgId}/settings, which needs messaging:read"
		);
		const run = capture();
		expect(await runCli(["doctor", "--help"], run.io)).toBe(0);
		expect(run.stdout()).toContain("/api/messaging/orgs/{orgId}/settings");
	});

	test("every flag a command refuses to run without is marked required", async () => {
		const checked: string[] = [];
		for (const entry of CLI_SERVICES) {
			for (const command of entry.commands) {
				const given: string[] = [];
				for (let step = 0; step < 10; step += 1) {
					const run = capture({
						env: ALL_SERVICES_ENV,
						readFile: () => Promise.resolve("<!doctype html><p>x</p>"),
					});
					await runCli(
						[
							entry.name,
							...command.path,
							...given,
							// Nothing is sent: a complete command prints curl instead.
							"--dry-run",
							// Last, so the `--` of `box exec <id> -- <cmd…>` ends the flags.
							...placeholderArgs(command.usage),
						],
						run.io
					);
					const missing = /usage_error: --([a-z-]+) is required/u.exec(
						run.stderr()
					)?.[1];
					if (missing === undefined) {
						break;
					}
					const spec = command.flags?.[missing];
					const line = `${entry.name} ${command.path.join(" ")} --${missing}`;
					expect({ line, required: spec?.required }).toEqual({
						line,
						required: true,
					});
					checked.push(line);
					given.push(`--${missing}`, spec?.type === "number" ? "1" : "x");
				}
			}
		}
		// The loop reached the commands with required flags.
		expect(checked).toEqual(
			expect.arrayContaining([
				"mail send --from",
				"mail send --to",
				"mail send --subject",
				"mail inboxes create --name",
				"notify publish --title",
				"sites create --name",
				"sites deploy --project",
				"gateway chat --model",
				"messaging sms send --from",
			])
		);
	});

	test("command help shows (required), the example, the effect and the docs page", async () => {
		const run = capture();
		expect(await runCli(["sites", "deploy", "--help"], run.io)).toBe(0);
		const text = run.stdout();
		expect(text).toMatch(/--project <id\|slug>\s+.*\(required\)/u);
		expect(text).not.toMatch(/--message <text>.*\(required\)/u);
		expect(text).toContain("Effect: Replaces what the Site serves");
		expect(text).toContain(
			"Example:\n  ryu-services sites deploy ./index.html --project launch-notes"
		);
		expect(text).toContain(
			"Docs: https://docs.ryuhq.com/docs/standalone/sdk/sites"
		);
		const reads = capture();
		expect(await runCli(["sites", "list", "--help"], reads.io)).toBe(0);
		expect(reads.stdout()).not.toContain("Effect:");
		expect(reads.stdout()).toContain("Docs: ");
	});

	test("a usage error in a known command points at that command's help", async () => {
		const installed = { env: ALL_SERVICES_ENV, npmPublishedVersion: "1.2.3" };
		const run = capture(installed);
		expect(await runCli(["mail", "send", "--to", "a@b.c"], run.io)).toBe(2);
		expect(run.stderr()).toContain("error usage_error: --from is required.");
		expect(run.stderr()).toContain(
			"hint: Run ryu-services mail send --help for usage."
		);
		const json = capture(installed);
		expect(
			await runCli(["mail", "send", "--to", "a@b.c", "--json"], json.io)
		).toBe(2);
		expect(
			(JSON.parse(json.stdout()) as { error: { hint: string } }).error.hint
		).toBe("Run ryu-services mail send --help for usage.");
		// Before a command is matched, the root help is still the pointer.
		const unknown = capture({ npmPublishedVersion: "1.2.3" });
		expect(await runCli(["nope"], unknown.io)).toBe(2);
		expect(unknown.stderr()).toContain("Run ryu-services --help for usage.");
	});

	test("a workspace build's usage and error hints name its bun launch line, not an uninstalled ryu-services", async () => {
		const launch = workspaceProgram();
		expect(launch).toMatch(/^bun \S+\/packages\/services-cli\/src\/bin\.ts$/u);
		const usageCases: [string[], string][] = [
			[["mcp", "--read-only", "--allow-writes"], `Run ${launch} --help`],
			[["mcp", "--services", "nope"], `Run ${launch} --help`],
			[["notify", "publish", "--allow-writes"], `Run ${launch} --help`],
			[
				["mail", "send", "--to", "a@b.c"],
				`Run ${launch} mail send --help for usage.`,
			],
		];
		for (const [argv, hint] of usageCases) {
			const run = capture({ env: ALL_SERVICES_ENV, npmPublishedVersion: null });
			expect(await runCli(argv, run.io)).toBe(2);
			expect(run.stderr()).toContain(`hint: ${hint}`);
			expect(run.stderr()).not.toMatch(/(?<![\w/.-])ryu-services(?![\w-])/u);
			const json = capture({
				env: ALL_SERVICES_ENV,
				npmPublishedVersion: null,
			});
			expect(await runCli([...argv, "--json"], json.io)).toBe(2);
			expect(
				(JSON.parse(json.stdout()) as { error: { hint: string } }).error.hint
			).toContain(hint);
		}
		// A service error's default hint names the same launch line for doctor.
		const failed = capture({
			env: { ...NOTIFY_ENV, RYU_NOTIFY_URL: "http://127.0.0.1:1" },
			fetch: () => Promise.reject(new TypeError("fetch failed")),
			npmPublishedVersion: null,
		});
		expect(await runCli(["notify", "usage"], failed.io)).toBe(1);
		expect(failed.stderr()).toContain(`\`${launch} doctor --check\``);
		// An installed CLI, and a host that names itself, keep their own name.
		const installed = capture({ npmPublishedVersion: "1.2.3" });
		expect(await runCli(["nope"], installed.io)).toBe(2);
		expect(installed.stderr()).toContain("Run ryu-services --help for usage.");
		const hosted = capture({
			npmPublishedVersion: null,
			program: "ryu-cli services",
		});
		expect(await runCli(["nope"], hosted.io)).toBe(2);
		expect(hosted.stderr()).toContain("Run ryu-cli services --help for usage.");
	});
});

describe("webhooks verify", () => {
	function webhookIo(files: Record<string, string> = {}): {
		io: CommandIo;
		out: () => string;
		err: () => string;
	} {
		let out = "";
		let err = "";
		return {
			io: {
				env: {},
				readFile: (path) => {
					const file = files[path];
					return file === undefined
						? Promise.reject(new Error("missing"))
						: Promise.resolve(file);
				},
				readStdin: () => Promise.resolve('{"type":"message.received"}'),
				stdout: { write: (chunk: string) => (out += chunk) },
				stderr: { write: (chunk: string) => (err += chunk) },
			},
			out: () => out,
			err: () => err,
		};
	}

	const flags = { service: "mail", secret: "whsec_abc", headers: "@h.json" };

	test("passes the raw stdin payload, @file headers and the secret to the verifier; exit 0", async () => {
		const run = webhookIo({ "h.json": '{"webhook-id":"msg_1"}' });
		let received: unknown;
		const code = await runWebhooksVerify(flags, run.io, true, (options) => {
			received = options;
			return Promise.resolve({ type: "message.received" });
		});
		expect(code).toBe(0);
		expect(received).toEqual({
			service: "mail",
			secret: "whsec_abc",
			headers: { "webhook-id": "msg_1" },
			payload: new TextEncoder().encode('{"type":"message.received"}'),
		});
		expect(JSON.parse(run.out())).toEqual({
			data: { type: "message.received" },
			meta: null,
		});
	});

	test("passes stdin bytes unchanged, including a BOM and non-UTF-8 bytes", async () => {
		const raw = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0xff, 0x7d]);
		const run = webhookIo({ "h.json": "{}" });
		let payload: unknown;
		const code = await runWebhooksVerify(
			flags,
			{ ...run.io, readStdinBytes: () => Promise.resolve(raw) },
			true,
			(options) => {
				payload = options.payload;
				return Promise.resolve({});
			}
		);
		expect(code).toBe(0);
		expect(payload).toEqual(raw);
	});

	test("the secret comes from @file or RYU_WEBHOOK_SECRET; --scheme legacy is Mail only", async () => {
		const fromFile = webhookIo({
			"h.json": "{}",
			"secret.txt": "whsec_file\n",
		});
		let received: { secret?: string; scheme?: string } = {};
		const verify = (options: { secret: string; scheme?: string }) => {
			received = options;
			return Promise.resolve(null);
		};
		expect(
			await runWebhooksVerify(
				{ ...flags, secret: "@secret.txt", scheme: "legacy" },
				fromFile.io,
				false,
				verify
			)
		).toBe(0);
		expect(received).toMatchObject({ secret: "whsec_file", scheme: "legacy" });

		const fromEnv = webhookIo({ "h.json": "{}" });
		const envIo = {
			...fromEnv.io,
			env: { RYU_WEBHOOK_SECRET: "whsec_env" },
		};
		expect(
			await runWebhooksVerify(
				{ service: "mail", headers: "@h.json" },
				envIo,
				false,
				verify
			)
		).toBe(0);
		expect(received.secret).toBe("whsec_env");
		expect(received.scheme).toBeUndefined();

		await expect(
			runWebhooksVerify(
				{ ...flags, scheme: "v2" },
				webhookIo({ "h.json": "{}" }).io,
				false,
				verify
			)
		).rejects.toThrow("--scheme must be one of standard, legacy");
		await expect(
			runWebhooksVerify(
				{
					service: "notify",
					secret: "s",
					headers: "{}",
					scheme: "legacy",
				},
				webhookIo().io,
				false,
				verify
			)
		).rejects.toThrow("--scheme applies to --service mail only");
		await expect(
			runWebhooksVerify(
				{ service: "mail", headers: "{}" },
				webhookIo().io,
				false,
				verify
			)
		).rejects.toThrow(CliUsageError);
	});

	test("--require-timestamp passes requireTimestamp for Notify destinations only", async () => {
		let received: { requireTimestamp?: boolean } = {};
		const verify = (options: { requireTimestamp?: boolean }) => {
			received = options;
			return Promise.resolve(null);
		};
		const notify = { service: "notify", secret: "s", headers: "{}" };
		expect(
			await runWebhooksVerify(
				{ ...notify, "require-timestamp": true },
				webhookIo().io,
				false,
				verify
			)
		).toBe(0);
		expect(received.requireTimestamp).toBe(true);
		expect(await runWebhooksVerify(notify, webhookIo().io, false, verify)).toBe(
			0
		);
		expect(received.requireTimestamp).toBeUndefined();
		await expect(
			runWebhooksVerify(
				{ ...flags, headers: "{}", "require-timestamp": true },
				webhookIo().io,
				false,
				verify
			)
		).rejects.toThrow("--require-timestamp applies to --service notify only");
		await expect(
			runWebhooksVerify(
				{ ...notify, kind: "callback", "require-timestamp": true },
				webhookIo().io,
				false,
				verify
			)
		).rejects.toThrow("not --kind callback");
	});

	test("--allow-body-only-signature passes allowBodyOnlySignature for Notify destinations only", async () => {
		let received: { allowBodyOnlySignature?: boolean } = {};
		const verify = (options: { allowBodyOnlySignature?: boolean }) => {
			received = options;
			return Promise.resolve(null);
		};
		const notify = { service: "notify", secret: "s", headers: "{}" };
		expect(
			await runWebhooksVerify(
				{ ...notify, "allow-body-only-signature": true },
				webhookIo().io,
				false,
				verify
			)
		).toBe(0);
		expect(received.allowBodyOnlySignature).toBe(true);
		expect(await runWebhooksVerify(notify, webhookIo().io, false, verify)).toBe(
			0
		);
		expect(received.allowBodyOnlySignature).toBeUndefined();
		await expect(
			runWebhooksVerify(
				{ ...flags, headers: "{}", "allow-body-only-signature": true },
				webhookIo().io,
				false,
				verify
			)
		).rejects.toThrow(
			"--allow-body-only-signature applies to --service notify only"
		);
		await expect(
			runWebhooksVerify(
				{ ...notify, kind: "callback", "allow-body-only-signature": true },
				webhookIo().io,
				false,
				verify
			)
		).rejects.toThrow("not --kind callback");
		await expect(
			runWebhooksVerify(
				{
					...notify,
					"allow-body-only-signature": true,
					"require-timestamp": true,
				},
				webhookIo().io,
				false,
				verify
			)
		).rejects.toThrow("contradict each other");
	});

	test("a body-only Notify delivery is rejected by default and accepted with --allow-body-only-signature", async () => {
		const payload = "{}";
		const signature = createHmac("sha256", "s3cret")
			.update(payload)
			.digest("hex");
		const headers = JSON.stringify({
			"x-ryu-notify-signature": `sha256=${signature}`,
		});
		const args = [
			"webhooks",
			"verify",
			"--service",
			"notify",
			"--secret",
			"s3cret",
			"--headers",
			headers,
			"--json",
		];
		const refused = capture({ stdin: payload });
		expect(await runCli(args, refused.io)).toBe(4);
		expect(refused.stdout()).toContain("webhook_missing_headers");
		const allowed = capture({ stdin: payload });
		expect(
			await runCli([...args, "--allow-body-only-signature"], allowed.io)
		).toBe(0);
	});

	test("--require-timestamp is a known flag and rejects a body-only Notify delivery end to end", async () => {
		const run = capture({ stdin: "{}" });
		const code = await runCli(
			[
				"webhooks",
				"verify",
				"--service",
				"notify",
				"--secret",
				"s3cret",
				"--require-timestamp",
				"--headers",
				'{"x-ryu-notify-signature":"sha256=00"}',
				"--json",
			],
			run.io
		);
		expect(code).toBe(4);
		expect(run.stdout()).toContain("requireTimestamp");
	});

	test("a rejected delivery exits 4", async () => {
		const run = webhookIo({ "h.json": "{}" });
		const code = await runWebhooksVerify(
			{ ...flags, kind: undefined } as never,
			run.io,
			false,
			() =>
				Promise.reject(
					new RyuWebhookVerificationError({
						service: "mail",
						status: 0,
						code: "webhook_invalid_signature",
						message: "No signature matched.",
					})
				)
		);
		expect(code).toBe(4);
		expect(run.err()).toContain("webhook_invalid_signature");
		expect(run.err()).not.toContain("whsec_abc");
	});

	test("a verifier configuration error exits 2", async () => {
		const run = webhookIo({ "h.json": "{}" });
		const code = await runWebhooksVerify(flags, run.io, false, () =>
			Promise.reject(
				new RyuConfigurationError({
					service: "mail",
					status: 0,
					code: "not_implemented",
					message: "later",
				})
			)
		);
		expect(code).toBe(2);
	});

	test("Notify callbacks pass --kind and --tolerance", async () => {
		const run = webhookIo();
		let received: unknown;
		await runWebhooksVerify(
			{
				service: "notify",
				kind: "callback",
				secret: "s",
				headers: '{"x-ryu-notify-timestamp":"1"}',
				tolerance: 60,
			},
			run.io,
			false,
			(options) => {
				received = options;
				return Promise.resolve(null);
			}
		);
		expect(received).toMatchObject({
			kind: "callback",
			toleranceSeconds: 60,
			service: "notify",
		});
	});
});

describe("exitCodeFor", () => {
	test("maps webhook, configuration and service errors", () => {
		expect(
			exitCodeFor(
				new RyuWebhookVerificationError({
					service: "mail",
					status: 0,
					code: "webhook_missing_headers",
					message: "",
				})
			)
		).toBe(4);
		expect(
			exitCodeFor(
				new RyuConfigurationError({ service: "notify", status: 0, message: "" })
			)
		).toBe(2);
		expect(
			exitCodeFor(
				new RyuError({
					service: "notify",
					status: 500,
					code: "internal_error",
					message: "",
				})
			)
		).toBe(1);
	});
});
