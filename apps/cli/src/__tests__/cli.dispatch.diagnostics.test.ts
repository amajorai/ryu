// Dispatcher tests for the Gateway/plugin doctor, observability, trace, redteam
// and plugin eval subcommands. The HTTP layer is mocked via an injected CoreApi,
// so nothing hits a Core node.

import { expect, test } from "bun:test";
import { runCli } from "../cli/dispatch.ts";
import {
	auditOutputObservation,
	makeIo,
	stubApi,
} from "./cli-dispatch-fixtures.ts";

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
