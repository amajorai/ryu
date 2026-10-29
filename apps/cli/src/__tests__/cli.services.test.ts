// `ryu services …` delegates verbatim to the ryu-services command line from
// `@ryuhq/services-cli`. These tests drive both the dispatcher (`runCli` with an
// injected IO + env, the path `ryu` takes) and `runServices` directly (to inject
// fetch), and never touch the network or the real process streams.

import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
	NPM_PUBLISHED_VERSION,
	NPM_STATUS_CLAUSE,
	npmStatusNote,
} from "@ryuhq/services-cli";
import { findCommand, renderHelp } from "../cli/commands.ts";
import { runCli } from "../cli/dispatch.ts";
import { runServices, servicesCommand } from "../cli/services.ts";
import type { CliContext, CliIO, CoreApi } from "../cli/types.ts";
import { VERSION } from "../cli/version.ts";

interface Captured {
	readonly io: CliIO;
	stderr(): string;
	stdout(): string;
}

function capture(): Captured {
	let out = "";
	let err = "";
	return {
		io: {
			out: (chunk) => {
				out += chunk;
			},
			err: (chunk) => {
				err += chunk;
			},
		},
		stdout: () => out,
		stderr: () => err,
	};
}

const NOTIFY_ENV = {
	RYU_NOTIFY_URL: "https://notify.example.com",
	RYU_NOTIFY_API_KEY: "notify-secret-key",
};

/** A CoreApi whose every call fails the test: `ryu services` never reaches Core. */
const noCoreApi = new Proxy({} as CoreApi, {
	get: (_target, property) => () => {
		throw new Error(`ryu services must not call Core (${String(property)})`);
	},
});

function runRyu(argv: string[], env: Record<string, string | undefined> = {}) {
	const run = capture();
	const code = runCli(argv, {
		api: noCoreApi,
		env,
		io: run.io,
		target: { url: "http://127.0.0.1:1", token: null },
	});
	return { code, run };
}

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

describe("ryu services (dispatcher)", () => {
	test("with no args prints the ryu-services root help on stdout and exits 0", async () => {
		const { code, run } = runRyu(["services"]);
		expect(await code).toBe(0);
		expect(run.stdout()).toContain(
			"ryu-cli services <service> <command> [args] [flags]"
		);
		expect(run.stdout()).not.toContain("interactive TUI");
		expect(run.stderr()).toBe("");
	});

	test("--help after services is ryu-services help, not `ryu help`", async () => {
		const { code, run } = runRyu(["services", "--help"]);
		expect(await code).toBe(0);
		expect(run.stdout()).toContain("ryu-cli services: command line");
		expect(run.stdout()).not.toContain("interactive TUI");
	});

	test("help and usage errors never print a `ryu-services ` command line", async () => {
		// A bare `ryu-services` binary is not installable while @ryuhq/services-cli is
		// unpublished, so everything `ryu-cli services` prints names its own command.
		// The package name (`@ryuhq/services-cli`), `mcp add ryu-services` server
		// names and quoted JSON values are allowed.
		const standaloneCommand = /(?<![\w"@/.-])(?<!mcp add )ryu-services /;
		const cases: [string[], number][] = [
			[["services", "--help"], 0],
			[["services", "box", "--help"], 0],
			[["services", "mail", "send", "--help"], 0],
			[["services", "notify", "publish", "--no-such-flag"], 2],
		];
		for (const [argv, expected] of cases) {
			const { code, run } = runRyu(argv);
			expect(await code).toBe(expected);
			expect(`${run.stdout()}${run.stderr()}`).not.toMatch(standaloneCommand);
		}
	});

	test("a command's --help reaches ryu-services with the command's flags", async () => {
		const { code, run } = runRyu(["services", "notify", "publish", "--help"]);
		expect(await code).toBe(0);
		expect(run.stdout()).toContain("--title");
	});

	test("the injected env is what the service clients read (exit 2 names the var)", async () => {
		const { code, run } = runRyu(
			["services", "notify", "publish", "--title", "x"],
			{}
		);
		expect(await code).toBe(2);
		expect(run.stderr()).toContain("RYU_NOTIFY_API_KEY");
	});

	test("--dry-run prints the request from the injected env without sending it", async () => {
		const { code, run } = runRyu(
			["services", "notify", "publish", "--title", "x", "--dry-run"],
			NOTIFY_ENV
		);
		expect(await code).toBe(0);
		expect(run.stdout()).toContain("https://notify.example.com/v1/events");
		expect(run.stdout()).not.toContain("notify-secret-key");
	});

	test("an unknown service is a ryu-services usage error (exit 2)", async () => {
		const { code, run } = runRyu(["services", "no-such-service"]);
		expect(await code).toBe(2);
		expect(run.stderr()).not.toBe("");
	});

	test("a ryu-services global flag before services is forwarded", async () => {
		const json = runRyu([
			"--json",
			"services",
			"notify",
			"publish",
			"--title",
			"x",
		]);
		expect(await json.code).toBe(2);
		expect(JSON.parse(json.run.stdout())).toHaveProperty("error.code");

		const dryRun = runRyu(
			["--dry-run", "services", "notify", "publish", "--title", "x"],
			NOTIFY_ENV
		);
		expect(await dryRun.code).toBe(0);
		expect(dryRun.run.stdout()).toContain("curl");
		expect(dryRun.run.stdout()).not.toContain("notify-secret-key");

		const inline = runRyu([
			"--timeout=5000",
			"--json",
			"services",
			"notify",
			"publish",
			"--title",
			"x",
			"--dry-run",
		]);
		expect(await inline.code).toBe(0);
		expect(JSON.parse(inline.run.stdout())).toHaveProperty("data.dryRun", true);

		for (const leading of [["--help"], ["-h"]]) {
			const { code, run } = runRyu([...leading, "services", "notify"]);
			expect(await code).toBe(0);
			expect(run.stdout()).toContain("ryu-cli services notify publish");
			expect(run.stderr()).toBe("");
		}
	});

	test("`ryu --help services` and `ryu --json services` print the ryu-services root help", async () => {
		for (const leading of [["--help"], ["--json"], ["-h"]]) {
			const { code, run } = runRyu([...leading, "services"]);
			expect(await code).toBe(0);
			expect(run.stdout()).toContain("ryu-cli services <service> <command>");
			expect(run.stdout()).not.toContain("interactive TUI");
		}
	});

	test("any other token before services exits 2 with the exact corrected command", async () => {
		const cases: [string[], string][] = [
			[
				["--json", "--force", "services", "box", "exec", "b1", "--", "ls -la"],
				"ryu-cli services --json box exec b1 --force -- 'ls -la'",
			],
			[
				["--timeout", "5000", "--force", "services", "box", "list"],
				"ryu-cli services --timeout 5000 box list --force",
			],
		];
		for (const [argv, corrected] of cases) {
			const { code, run } = runRyu(argv);
			expect(await code).toBe(2);
			expect(run.stderr()).toContain("is not a ryu-services global flag");
			expect(run.stderr()).toContain(`\n  ${corrected}\n`);
			expect(run.stderr()).not.toMatch(/\bryu services\b/);
			expect(run.stdout()).toBe("");
		}
	});

	test("value flags written with a space before services take their value", async () => {
		const baseUrl = runRyu(
			[
				"--base-url",
				"https://alt.example.com",
				"--dry-run",
				"services",
				"notify",
				"publish",
				"--title",
				"x",
			],
			NOTIFY_ENV
		);
		expect(await baseUrl.code).toBe(0);
		expect(baseUrl.run.stdout()).toContain("https://alt.example.com");
		expect(baseUrl.run.stderr()).not.toContain("Unknown command");

		const timeout = runRyu([
			"--timeout",
			"5000",
			"--json",
			"services",
			"notify",
			"publish",
			"--title",
			"x",
			"--dry-run",
		]);
		expect(await timeout.code).toBe(0);
		expect(JSON.parse(timeout.run.stdout())).toHaveProperty(
			"data.dryRun",
			true
		);
	});

	test("an --api-key value before services is forwarded and never echoed", async () => {
		const forwarded = runRyu(
			[
				"--api-key",
				"sekrit-key",
				"--dry-run",
				"services",
				"notify",
				"publish",
				"--title",
				"x",
			],
			{ RYU_NOTIFY_URL: "https://notify.example.com" }
		);
		expect(await forwarded.code).toBe(0);
		expect(forwarded.run.stdout()).toContain("curl");
		expect(forwarded.run.stdout()).not.toContain("sekrit-key");
		expect(forwarded.run.stderr()).not.toContain("sekrit-key");

		for (const leading of [
			["--api-key", "sekrit-key", "--force"],
			["--api-key=sekrit-key", "--force"],
		]) {
			const { code, run } = runRyu([...leading, "services", "box", "list"]);
			expect(await code).toBe(2);
			expect(run.stderr()).not.toContain("sekrit-key");
			expect(run.stderr()).toContain("<key>");
			expect(run.stderr()).toContain("box list --force");
		}
	});

	test("an --api-key value after services is never echoed in the corrected command", async () => {
		for (const keyed of [
			["--api-key", "SECRET_KEY_123"],
			["--api-key=SECRET_KEY_123"],
		]) {
			for (const tail of [[], ["--", "x"]]) {
				const { code, run } = runRyu([
					"--force",
					"services",
					"notify",
					"events",
					"list",
					...keyed,
					...tail,
				]);
				expect(await code).toBe(2);
				expect(run.stderr()).not.toContain("SECRET_KEY_123");
				expect(run.stderr()).toContain("<key>");
				expect(run.stderr()).toContain("replace <key> with your key");
			}
		}
	});

	test("--version before services runs `ryu-services --version` only with no command", async () => {
		for (const flag of ["--version", "-V"]) {
			const bare = runRyu([flag, "services"]);
			expect(await bare.code).toBe(0);
			expect(bare.run.stdout()).toMatch(/^\d+\.\d+\.\d+/u);

			const { code, run } = runRyu([
				flag,
				"services",
				"notify",
				"events",
				"list",
			]);
			expect(await code).toBe(2);
			expect(run.stderr()).toContain("Run: ryu-cli services --version\n");
			expect(run.stderr()).not.toContain("events list --version");
			expect(run.stdout()).toBe("");
		}
	});

	test("services --version and doctor name ryu-cli, not a workspace build, in the npm note", async () => {
		const expected = npmStatusNote({
			bundledWith: `ryu-cli ${VERSION}`,
			publishedVersion: NPM_PUBLISHED_VERSION,
		});
		expect(NPM_PUBLISHED_VERSION).toBeNull();
		expect(expected).toBe(
			`This command line is bundled with ryu-cli ${VERSION}, not installed from npm. ${NPM_STATUS_CLAUSE}`
		);
		const version = runRyu(["services", "--version"]);
		expect(await version.code).toBe(0);
		expect(version.run.stderr()).toBe(`note: ${expected}\n`);
		expect(version.run.stderr()).not.toContain("workspace build");

		const doctor = runRyu(["services", "doctor"]);
		expect(await doctor.code).toBe(0);
		expect(doctor.run.stdout().endsWith(`\n\nnote: ${expected}\n`)).toBe(true);
		expect(doctor.run.stdout()).not.toContain("workspace build");

		const json = runRyu(["services", "doctor", "--json"]);
		expect(await json.code).toBe(0);
		const report = JSON.parse(json.run.stdout()) as {
			data: { npmNote: string | null };
		};
		expect(report.data.npmNote).toBe(expected);
	});

	test("a value flag with no value before services is a plain usage error", async () => {
		for (const argv of [
			["--limit", "services", "notify", "events", "list"],
			["--base-url", "services", "notify", "events", "list"],
		]) {
			const { code, run } = runRyu(argv);
			expect(await code).toBe(2);
			expect(run.stderr()).toContain("before `services` has no value");
			expect(run.stderr()).not.toContain("Put it after the command:\n");
			expect(run.stdout()).toBe("");
		}
	});

	test("--json after services keeps ryu-services semantics", async () => {
		const { code, run } = runRyu(
			["services", "notify", "publish", "--title", "x", "--json"],
			{}
		);
		expect(await code).toBe(2);
		expect(JSON.parse(run.stdout())).toHaveProperty("error");
	});

	test("`ryu services -- --help` hands the literal `--` on verbatim (ryu-services rejects it)", async () => {
		const { code, run } = runRyu(["services", "--", "--help"]);
		expect(await code).toBe(2);
		expect(run.stdout()).not.toContain("interactive TUI");
		expect(run.stdout()).not.toContain("ryu-services: command line");
	});

	test("`ryu services mcp --help` is ryu-services' mcp help", async () => {
		const { code, run } = runRyu(["services", "mcp", "--help"]);
		expect(await code).toBe(0);
		expect(run.stdout()).toContain("--allow-writes");
	});

	test("`ryu services mcp --help` prints a client entry that runs with only ryu-cli installed", async () => {
		const { code, run } = runRyu(["services", "mcp", "--help"]);
		expect(await code).toBe(0);
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
		expect(text).toContain("-- ryu-cli services mcp --services notify");
		expect(text).not.toContain('"command": "ryu-services"');
		expect(text).not.toContain("Usage: ryu-services");
	});

	test("ryu flags before another command still short-circuit as before", async () => {
		const { code, run } = runRyu(["status", "--help"]);
		expect(await code).toBe(0);
		expect(run.stdout()).toContain("interactive TUI");
	});
});

describe("runServices", () => {
	test("returns ryu-services' exit code and renders RyuErrors on the ryu sink", async () => {
		const run = capture();
		const seen: Request[] = [];
		const code = await runServices(["notify", "publish", "--title", "x"], {
			env: NOTIFY_ENV,
			fetch: async (input, init) => {
				seen.push(new Request(input, init));
				return notifyError(401, "unauthorized");
			},
			io: run.io,
		});
		expect(code).toBe(1);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.url).toBe("https://notify.example.com/v1/events");
		expect(run.stderr()).toContain("requestId: req_42");
		expect(run.stderr()).not.toContain("notify-secret-key");
	});

	test("--json errors go to stdout as { error }", async () => {
		const run = capture();
		const code = await runServices(
			["notify", "publish", "--title", "x", "--json"],
			{
				env: NOTIFY_ENV,
				fetch: async () => notifyError(404, "not_found"),
				io: run.io,
			}
		);
		expect(code).toBe(1);
		const printed = JSON.parse(run.stdout()) as {
			error: { code: string; requestId: string };
		};
		expect(printed.error).toMatchObject({
			code: "not_found",
			requestId: "req_42",
		});
	});
});

describe("process env fallback", () => {
	const saved = {
		url: process.env.RYU_NOTIFY_URL,
		key: process.env.RYU_NOTIFY_API_KEY,
	};
	afterEach(() => {
		for (const [name, value] of [
			["RYU_NOTIFY_URL", saved.url],
			["RYU_NOTIFY_API_KEY", saved.key],
		] as const) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
	});

	test("with no env override the dispatcher path reads process.env", async () => {
		process.env.RYU_NOTIFY_URL = "https://notify-from-process.example.com";
		process.env.RYU_NOTIFY_API_KEY = "process-key";
		const run = capture();
		const code = await runCli(
			["services", "notify", "publish", "--title", "x", "--dry-run"],
			{
				api: noCoreApi,
				io: run.io,
				target: { url: "http://127.0.0.1:1", token: null },
			}
		);
		expect(code).toBe(0);
		expect(run.stdout()).toContain(
			"https://notify-from-process.example.com/v1/events"
		);
	});
});

describe("stdin and mcp passthrough", () => {
	const SECRET_KEY = Buffer.from("ryu-services-cli-delegation-key!");
	const SECRET = `whsec_${SECRET_KEY.toString("base64")}`;
	const PAYLOAD = JSON.stringify({
		type: "event",
		event_type: "message.delivered",
		event_id: "evt_1",
		data: { message: { id: "msg_1" } },
	});

	function mailHeaders(body: string): string {
		const id = "evt_1";
		const timestamp = String(Math.floor(Date.now() / 1000));
		const signature = createHmac("sha256", SECRET_KEY)
			.update(`${id}.${timestamp}.${body}`)
			.digest("base64");
		return JSON.stringify({
			"webhook-id": id,
			"webhook-timestamp": timestamp,
			"webhook-signature": `v1,${signature}`,
		});
	}

	function verify(stdin: string, headers: string) {
		const run = capture();
		const code = runServices(
			[
				"webhooks",
				"verify",
				"--service",
				"mail",
				"--headers",
				headers,
				"--json",
			],
			{ env: { RYU_WEBHOOK_SECRET: SECRET }, io: run.io, stdin }
		);
		return { code, run };
	}

	test("webhooks verify reads the payload from the injected stdin (exit 0)", async () => {
		const { code, run } = verify(PAYLOAD, mailHeaders(PAYLOAD));
		expect(await code).toBe(0);
		expect(run.stdout()).toContain("message.delivered");
	});

	test("a tampered payload on stdin is rejected with exit 4", async () => {
		const { code, run } = verify(
			PAYLOAD.replace("msg_1", "msg_2"),
			mailHeaders(PAYLOAD)
		);
		expect(await code).toBe(4);
		expect(run.stdout()).toContain("RyuWebhookVerificationError");
		expect(run.stdout()).not.toContain("webhook_payload_invalid");
	});

	test("mcp speaks JSON-RPC on the injected streams and nothing else on stdout", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		let protocol = "";
		output.on("data", (chunk: Buffer) => {
			protocol += chunk.toString();
		});
		const run = capture();
		const running = runServices(["mcp"], {
			env: NOTIFY_ENV,
			io: run.io,
			mcpStdio: { input, output },
		});
		input.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "ryu-cli-test", version: "1.0.0" },
				},
			})}\n`
		);
		for (let tries = 0; tries < 200 && !protocol.includes("\n"); tries++) {
			await Bun.sleep(10);
		}
		input.end();
		expect(await running).toBe(0);
		const reply = JSON.parse(protocol.split("\n")[0] ?? "") as {
			id: number;
			result: { serverInfo: { name: string } };
		};
		expect(reply.id).toBe(1);
		expect(reply.result.serverInfo.name).toBe("ryu-services");
		expect(run.stdout()).toBe("");
	});
});

describe("source resolution of the services packages", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const repo = resolve(here, "../../../..");
	const tsconfig = JSON.parse(
		readFileSync(resolve(here, "../../tsconfig.json"), "utf8")
			.replace(/^\s*\/\/.*$/gm, "")
			.replace(/,(\s*[}\]])/g, "$1")
	) as { compilerOptions: { paths: Record<string, string[]> } };
	const { paths } = tsconfig.compilerOptions;

	function sourceFiles(dir: string): string[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				return entry.name === "__tests__" ? [] : sourceFiles(full);
			}
			return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
				? [full]
				: [];
		});
	}

	const specifiers = new Set(
		["services-cli", "services", "client"].flatMap((pkg) =>
			sourceFiles(join(repo, "packages", pkg, "src")).flatMap((file) =>
				[
					...readFileSync(file, "utf8").matchAll(
						/(?:from |import\()"(@ryuhq\/[^"]+)"/g
					),
				].map((match) => match[1] ?? "")
			)
		)
	);
	specifiers.add("@ryuhq/services-cli");

	test("every @ryuhq import the delegation reaches has an alias to an existing source file", () => {
		expect(specifiers.size).toBeGreaterThan(1);
		for (const specifier of specifiers) {
			const target = paths[specifier]?.[0];
			expect({ specifier, aliased: target !== undefined }).toEqual({
				specifier,
				aliased: true,
			});
			expect(
				readFileSync(resolve(here, "../..", target ?? ""), "utf8")
			).not.toBe("");
		}
	});

	test("each aliased specifier imports from apps/cli without a built dist/", async () => {
		for (const specifier of Object.keys(paths).filter((key) =>
			key.startsWith("@ryuhq/")
		)) {
			const module = (await import(specifier)) as Record<string, unknown>;
			expect(Object.keys(module).length).toBeGreaterThan(0);
		}
	});
});

describe("registry", () => {
	test("`ryu help` lists ryu services", () => {
		expect(renderHelp()).toContain("ryu services <service> <command>");
		expect(findCommand("services")).toBe(servicesCommand);
	});

	test("the registry entry delegates ctx.rawArgs with ctx.env and ctx.io", async () => {
		const run = capture();
		const ctx = {
			args: [],
			env: {},
			io: run.io,
			rawArgs: ["notify", "publish", "--title", "x"],
		} as unknown as CliContext;
		expect(await servicesCommand.run(ctx)).toBe(2);
		expect(run.stderr()).toContain("RYU_NOTIFY_API_KEY");
	});
});
