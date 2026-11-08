// The `ryu secrets` AI agent guard: detection, refusal of value-printing
// subcommands, the `--human` override, `run` defaulting to the broker, and the
// environment-dump block. Core is faked through the target's `fetch`.

import { expect, test } from "bun:test";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { runCli } from "../cli/dispatch.ts";
import { detectAgentSession } from "../cli/secrets-agent-guard.ts";
import {
	dumpsEnvironment,
	readsScriptFromStdin,
} from "../cli/secrets-env-dump.ts";
import type { CoreApi, LinePrompter, ProcessRunner } from "../cli/types.ts";

const T = "2026-01-01T00:00:00Z";
const CA_PEM =
	"-----BEGIN CERTIFICATE-----\nbroker\n-----END CERTIFICATE-----\n";
const AGENT_ENV = { HOME: "/home/me", PATH: "/usr/bin", CLAUDECODE: "1" };

type Responder = () => Response;
type Routes = Record<string, Responder>;

function json(body: Parameters<typeof Response.json>[0]): Responder {
	return () => Response.json(body);
}

function fakeNode(routes: Routes, url = "http://127.0.0.1:7777") {
	const calls: { body: string; route: string }[] = [];
	const target: ApiTarget = {
		url,
		token: "node-token",
		fetch: (input, init) => {
			const parsed = new URL(String(input));
			const route = `${init?.method ?? "GET"} ${parsed.pathname}`;
			calls.push({ route, body: String(init?.body ?? "") });
			const respond = routes[route];
			return Promise.resolve(
				respond
					? respond()
					: Response.json({ error: "no route" }, { status: 404 })
			);
		},
	};
	return { calls, target };
}

function stubApi(): CoreApi {
	const notCalled = () => Promise.reject(new Error("unexpected CoreApi call"));
	return {
		fetchApps: notCalled,
		fetchAppsCatalog: notCalled,
		installApp: notCalled,
		enableApp: notCalled,
		disableApp: notCalled,
		uninstallApp: notCalled,
		execAppCommand: notCalled,
		streamChat: notCalled,
	};
}

interface RunOptions {
	env?: Record<string, string>;
	promptLine?: LinePrompter;
	spawn?: ProcessRunner;
}

async function run(
	argv: string[],
	node: ReturnType<typeof fakeNode>,
	options: RunOptions = {}
) {
	let out = "";
	let err = "";
	const code = await runCli(argv, {
		api: stubApi(),
		env: options.env ?? AGENT_ENV,
		io: {
			out: (text) => {
				out += text;
			},
			err: (text) => {
				err += text;
			},
		},
		promptLine: options.promptLine ?? (() => Promise.resolve(null)),
		spawn: options.spawn ?? (() => Promise.resolve(0)),
		target: node.target,
	});
	return { code, err, out };
}

test("detectAgentSession recognises coding-agent markers only", () => {
	expect(detectAgentSession({ CLAUDECODE: "1" })).toBe("CLAUDECODE");
	expect(detectAgentSession({ CURSOR_AGENT: "1" })).toBe("CURSOR_AGENT");
	expect(detectAgentSession({ AGENT: "amp" })).toBe("AGENT");
	expect(detectAgentSession({ CODEX_SANDBOX: "seatbelt" })).toBe(
		"CODEX_SANDBOX"
	);
	expect(detectAgentSession({ CODEX_HOME: "/home/me/.codex" })).toBeNull();
	expect(detectAgentSession({ CLAUDECODE: "0", AGENT: "false" })).toBeNull();
	expect(detectAgentSession({ CLAUDECODE: " " })).toBeNull();
	expect(detectAgentSession({ HOME: "/home/me" })).toBeNull();
});

test("dumpsEnvironment flags env dumps but not commands that use the env", () => {
	const dumps = [
		["printenv"],
		["printenv", "API_KEY"],
		["/usr/bin/env"],
		["env", "-0"],
		["env", "-u", "HOME"],
		["env", "FOO=1"],
		["env", "FOO=1", "printenv"],
		["export", "-p"],
		["declare", "-px"],
		["typeset"],
		["set"],
		["compgen", "-e"],
		["cat", "/proc/self/environ"],
		["sh", "-c", "npm test && env"],
		["bash", "-lc", "echo $(printenv API_KEY)"],
		["zsh", "-c", "declare -x | grep KEY"],
		["FOO=1", "env"],
		// Transparent wrappers do not hide the dump.
		["exec", "env"],
		["sh", "-c", "exec env"],
		["nohup", "printenv"],
		["timeout", "5", "env"],
		["timeout", "-s", "KILL", "5s", "printenv"],
		["nice", "-n", "10", "env"],
		["nice", "-10", "printenv"],
		["time", "-p", "env"],
		["stdbuf", "-o", "L", "printenv"],
		["stdbuf", "-oL", "env"],
		["xargs", "-0", "printenv"],
		["sudo", "-E", "-u", "me", "env"],
		["/usr/bin/sudo", "--", "printenv"],
		["busybox", "env"],
		["command", "env"],
		["builtin", "export", "-p"],
		["nohup", "timeout", "5", "exec", "env"],
		["bash", "-c", "npm test; nohup printenv"],
		["timeout", "5", "sh", "-c", "env"],
	];
	for (const command of dumps) {
		expect({ command, dumps: dumpsEnvironment(command) }).toEqual({
			command,
			dumps: true,
		});
	}
	const runs = [
		["npm", "test"],
		["env", "NODE_ENV=test", "node", "app.js"],
		["env", "-u", "HOME", "node", "app.js"],
		["bash", "-c", "npm run build && npm test"],
		["bash", "script.sh"],
		["export-report", "-p"],
		["node", "-e", "require('./app')"],
		["timeout", "60", "npm", "test"],
		["nohup", "node", "server.js"],
		["sudo", "-u", "me", "npm", "test"],
		["command", "-v", "env"],
		["exec"],
		[],
	];
	for (const command of runs) {
		expect({ command, dumps: dumpsEnvironment(command) }).toEqual({
			command,
			dumps: false,
		});
	}
});

test("readsScriptFromStdin flags shells that run whatever stdin carries", () => {
	const stdin = [
		["sh"],
		["/bin/bash"],
		["bash", "-s"],
		["bash", "-s", "arg1"],
		["zsh", "-i"],
		["bash", "-o", "pipefail"],
		["nohup", "sh"],
		["env", "FOO=1", "bash"],
		["sh", "-c", "cat | sh"],
	];
	for (const command of stdin) {
		expect({ command, stdin: readsScriptFromStdin(command) }).toEqual({
			command,
			stdin: true,
		});
	}
	const scripted = [
		["bash", "script.sh"],
		["bash", "-o", "pipefail", "script.sh"],
		["sh", "-c", "npm test"],
		["npm", "test"],
		["timeout", "5", "bash", "build.sh"],
		[],
	];
	for (const command of scripted) {
		expect({ command, stdin: readsScriptFromStdin(command) }).toEqual({
			command,
			stdin: false,
		});
	}
});

test("value-printing subcommands refuse in an agent session before calling Core", async () => {
	const node = fakeNode({
		"POST /api/vault/secrets/API_KEY/reveal": json({ value: "sk_live_123" }),
	});
	// `get` and `export` redact by value type (cli.secrets.agent-redaction.test.ts).
	const commands = [
		["secrets", "unwrap", "rvw_token"],
		["secrets", "items", "reveal", "stripe", "number"],
		["secrets", "pm", "read", "op://vault/item/field"],
	];
	for (const argv of commands) {
		const result = await run(argv, node);
		expect({ argv, code: result.code, out: result.out }).toEqual({
			argv,
			code: 1,
			out: "",
		});
		expect(result.err).toContain("Refusing to print secret values");
		expect(result.err).toContain("CLAUDECODE");
	}
	expect(node.calls).toEqual([]);
	const get = await run(["secrets", "get", "API_KEY"], node);
	expect(get.code).toBe(1);
	expect(get.out).toBe("");
	expect(node.calls.map((call) => call.route)).toEqual([
		"GET /api/vault/secrets",
	]);
	// The same command outside an agent session prints the value.
	const human = await run(["secrets", "get", "API_KEY"], node, {
		env: { HOME: "/home/me" },
	});
	expect(human).toEqual({ code: 0, err: "", out: "sk_live_123\n" });
});

test("--human lifts the guard only when a person confirms at a terminal", async () => {
	const node = fakeNode({
		"POST /api/vault/secrets/API_KEY/reveal": json({ value: "sk_live_123" }),
	});
	const questions: string[] = [];
	const confirmed = await run(["secrets", "get", "API_KEY", "--human"], node, {
		promptLine: (question) => {
			questions.push(question);
			return Promise.resolve(" Human ");
		},
	});
	expect(confirmed.code).toBe(0);
	expect(confirmed.out).toBe("sk_live_123\n");
	expect(questions[0]).toContain("Type human to confirm");

	// No terminal to answer on (an agent's shell): the guard stays on.
	const headless = await run(["secrets", "get", "API_KEY", "--human"], node);
	expect(headless.code).toBe(1);
	expect(headless.out).toBe("");
	expect(headless.err).toContain("--human needs a person to confirm");

	// A wrong answer keeps it on too.
	const wrong = await run(["secrets", "get", "API_KEY", "--human"], node, {
		promptLine: () => Promise.resolve("yes"),
	});
	expect(wrong.code).toBe(1);
	expect(
		node.calls.filter((call) => call.route.endsWith("/reveal"))
	).toHaveLength(1);
});

test("run in an agent session defaults to the broker with the enabled services", async () => {
	const proxyUrl = "http://rvb:rvb_session_secret@127.0.0.1:8123";
	const service = (name: string, enabled: boolean) => ({
		name,
		environment: "prod",
		host: `${name}.example`,
		pathPrefix: "/",
		enabled,
		auth: { kind: "bearer" },
		createdAt: T,
		updatedAt: T,
	});
	const node = fakeNode({
		"GET /api/vault/broker/services": json({
			services: [
				service("github", true),
				service("legacy", false),
				service("stripe", true),
			],
		}),
		"POST /api/vault/broker/sessions": json({
			token: "rvb_session_secret",
			session: {
				id: "bs_1",
				environment: "prod",
				services: ["github", "stripe"],
				label: "ryu secrets run node",
				mintedBy: "user:u1",
				createdAt: T,
				expiresAt: T,
			},
			proxy: {
				url: "http://127.0.0.1:8123",
				port: 8123,
				caPath: "/nonexistent/ryu/ca.pem",
				caBundlePath: "/nonexistent/ryu/ca-bundle.pem",
				caUrl: "/api/vault/broker/ca.pem",
				env: { HTTPS_PROXY: proxyUrl },
			},
		}),
		"GET /api/vault/broker/ca.pem": () => new Response(CA_PEM),
		"DELETE /api/vault/broker/sessions/bs_1": json({ revoked: true }),
	});
	const children: Record<string, string>[] = [];
	const result = await run(
		["secrets", "run", "--env", "prod", "--", "node", "agent.js"],
		node,
		{
			spawn: (_command, env) => {
				children.push(env);
				return Promise.resolve(5);
			},
		}
	);
	expect(result.code).toBe(5);
	expect(result.err).toContain("credential broker with github, stripe");
	// The value types could not be listed, so no config values were added.
	expect(result.err).toContain("Could not list value types");
	expect(node.calls.map((call) => call.route)).toEqual([
		"GET /api/vault/broker/services",
		"GET /api/vault/secrets",
		"POST /api/vault/broker/sessions",
		"GET /api/vault/broker/ca.pem",
		"DELETE /api/vault/broker/sessions/bs_1",
	]);
	expect(JSON.parse(node.calls[2]?.body ?? "{}").services).toEqual([
		"github",
		"stripe",
	]);
	expect(children[0]?.HTTPS_PROXY).toBe(proxyUrl);
	expect(node.calls.some((call) => call.route.includes("/export"))).toBe(false);
});

test("run in an agent session without broker services injects values but blocks env dumps", async () => {
	const node = fakeNode({
		"GET /api/vault/broker/services": json({ services: [] }),
		"POST /api/vault/export": json({
			format: "json",
			contentType: "application/json",
			count: 1,
			environment: "prod",
			path: "/",
			content: JSON.stringify({ API_KEY: "sk_live_123" }),
		}),
	});
	const children: Record<string, string>[] = [];
	const spawn: ProcessRunner = (_command, env) => {
		children.push(env);
		return Promise.resolve(0);
	};
	for (const command of [["printenv"], ["sh", "-c", "env | sort"]]) {
		const refused = await run(["secrets", "run", "--", ...command], node, {
			spawn,
		});
		expect(refused.code).toBe(1);
		expect(refused.err).toContain("prints its environment");
	}
	expect(node.calls).toEqual([]);
	expect(children).toEqual([]);

	const allowed = await run(["secrets", "run", "--", "npm", "test"], node, {
		spawn,
	});
	expect(allowed.code).toBe(0);
	expect(allowed.err).toContain("no broker services are available");
	expect(children[0]?.API_KEY).toBe("sk_live_123");
	expect(allowed.out).toBe("");
	expect(allowed.err).not.toContain("sk_live_123");
});

test("run in an agent session refuses a stdin shell when values would be injected", async () => {
	const node = fakeNode({
		"GET /api/vault/broker/services": json({ services: [] }),
	});
	const children: Record<string, string>[] = [];
	const refused = await run(["secrets", "run", "--", "sh"], node, {
		spawn: (_command, env) => {
			children.push(env);
			return Promise.resolve(0);
		},
	});
	expect(refused.code).toBe(1);
	expect(refused.err).toContain("reads its script from stdin");
	expect(node.calls.map((call) => call.route)).toEqual([
		"GET /api/vault/broker/services",
	]);
	expect(children).toEqual([]);
});

test("run in an agent session refuses when the broker services cannot be listed", async () => {
	for (const status of [500, 403]) {
		const node = fakeNode({
			"GET /api/vault/broker/services": () =>
				Response.json({ error: "unavailable" }, { status }),
			"POST /api/vault/export": json({
				format: "json",
				contentType: "application/json",
				count: 1,
				environment: "prod",
				path: "/",
				content: JSON.stringify({ API_KEY: "sk_live_123" }),
			}),
		});
		const children: Record<string, string>[] = [];
		const result = await run(["secrets", "run", "--", "npm", "test"], node, {
			spawn: (_command, env) => {
				children.push(env);
				return Promise.resolve(0);
			},
		});
		expect({ status, code: result.code }).toEqual({ status, code: 1 });
		expect(result.err).toContain("broker services could not be listed");
		expect(result.err).toContain("--broker SERVICE");
		expect(node.calls.map((call) => call.route)).toEqual([
			"GET /api/vault/broker/services",
		]);
		expect(children).toEqual([]);
	}
});
