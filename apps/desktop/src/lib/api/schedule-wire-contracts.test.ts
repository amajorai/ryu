import { afterEach, expect, test } from "bun:test";
import { type PluginValue, pluginValueSchema } from "./plugin-wire-values.ts";
import { scheduledJobWireSchema } from "./schedule-wire-contracts.ts";
import { createJob, fetchJobs, runJobNow, updateJob } from "./schedules.ts";

const originalFetch = globalThis.fetch;
const target = { token: null, url: "https://schedules.test" };
const job = {
	created_at: "created",
	id: "job",
	name: "Routine",
	schedule: { kind: "every", interval: "1h" },
	target: { type: "agent", agent_id: "agent", prompt: "hello" },
	updated_at: "updated",
};
afterEach(() => {
	globalThis.fetch = originalFetch;
});
function respond(body: PluginValue, status = 200) {
	globalThis.fetch = Object.assign(
		async () => Response.json(pluginValueSchema.parse(body), { status }),
		{ preconnect: originalFetch.preconnect }
	);
}

test("scheduler records validate complete fields and retain raw metadata identity", async () => {
	const raw = {
		...job,
		target: {
			type: "monitor",
			monitor_id: "monitor",
			future: { preserved: true },
		},
		owner_user_id: "user",
		org_id: "org",
		future: [null],
	};
	expect(scheduledJobWireSchema.parse(raw)).toBe(raw);
	expect(scheduledJobWireSchema.parse(raw).target).toBe(raw.target);
	respond({
		jobs: [
			raw,
			{ ...job, target: { type: "identity_health" } },
			{ ...job, target: { type: "learning_cycle" } },
			{ ...job, target: { type: "future_target", future: [1] } },
		],
	});
	const rows = await fetchJobs(target);
	expect(rows.map((row) => row.system)).toEqual([true, true, true, false]);
	expect(rows[0]).toEqual({
		appId: null,
		id: "job",
		name: "Routine",
		schedule: { kind: "every", interval: "1h" },
		system: true,
		target: {
			type: "agent",
			agentId: "",
			conversationId: null,
			prompt: "",
			model: null,
		},
		enabled: true,
		requireApproval: false,
		ownerApp: null,
		providerAccount: null,
		createdAt: "created",
		updatedAt: "updated",
		lastRunAt: null,
		lastOutcome: null,
		history: [],
	});
	respond({ jobs: [{ id: "job", name: "incomplete" }] });
	await expect(fetchJobs(target)).rejects.toThrow();
});

test("app jobs are requested, attributed to their app, and read as system rows", async () => {
	const urls: string[] = [];
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL) => {
			urls.push(String(input));
			return Response.json({
				jobs: [
					{
						...job,
						name: "monitor: Site",
						target: {
							type: "app_job",
							plugin_id: "@ryu/monitors",
							job_id: "m1",
						},
						owner_app: "@ryu/monitors",
					},
					job,
				],
			});
		},
		{ preconnect: originalFetch.preconnect }
	);
	const [app, agent] = await fetchJobs(target);
	expect(urls).toEqual([
		"https://schedules.test/heartbeat/jobs?include=app_jobs",
	]);
	expect(app?.system).toBe(true);
	expect(app?.appId).toBe("@ryu/monitors");
	expect(app?.ownerApp).toBe("@ryu/monitors");
	expect(agent?.system).toBe(false);
	expect(agent?.appId).toBeNull();
});

test("workflow string inputs validate every own JSON key without stripping metadata", () => {
	const input = pluginValueSchema.parse(
		JSON.parse('{"__proto__":"retained","ordinary":"value"}')
	);
	const raw = {
		...job,
		target: { type: "workflow", workflow_id: "workflow", input },
	};
	expect(Object.is(scheduledJobWireSchema.parse(raw).target.input, input)).toBe(
		true
	);
	const invalid = JSON.parse(
		'{"__proto__":{"invalid":true},"ordinary":"value"}'
	);
	expect(
		scheduledJobWireSchema.safeParse({
			...job,
			target: { type: "workflow", input: invalid },
		}).success
	).toBe(false);
});

test("legacy null fields and execution history preserve normalization", async () => {
	respond({
		jobs: [
			{
				...job,
				enabled: null,
				history: [
					{
						started_at: "start",
						finished_at: "finish",
						outcome: "failure",
						error: "",
						run_id: null,
					},
				],
				require_approval: null,
				owner_app: null,
				schedule: { kind: "cron", tz: null },
				target: { type: "workflow" },
			},
		],
	});
	const [row] = await fetchJobs(target);
	expect(row?.schedule).toEqual({ kind: "cron", expr: "", tz: null });
	expect(row?.target).toEqual({
		type: "workflow",
		workflowId: "",
		input: undefined,
	});
	expect(row?.history).toEqual([
		{
			startedAt: "start",
			finishedAt: "finish",
			outcome: "failure",
			runId: null,
			error: "",
		},
	]);
	expect(row?.enabled).toBe(true);
	respond({});
	expect(await fetchJobs(target)).toEqual([]);
});

test("creation preserves exact omission and ordering of scheduling fields", async () => {
	const bodies: string[] = [];
	globalThis.fetch = Object.assign(
		async (_input: RequestInfo | URL, init?: RequestInit) => {
			bodies.push(String(init?.body));
			return Response.json({ job });
		},
		{ preconnect: originalFetch.preconnect }
	);
	await createJob(target, {
		name: "Routine",
		schedule: { kind: "cron", expr: "0 5 * * *", tz: "" },
		target: {
			type: "agent",
			agentId: "agent",
			conversationId: null,
			prompt: "hello",
			model: "",
		},
		enabled: false,
		quickRoutine: false,
		ownerApp: "",
	});
	expect(bodies[0]).toBe(
		'{"name":"Routine","schedule":{"kind":"cron","expr":"0 5 * * *"},"target":{"type":"agent","agent_id":"agent","conversation_id":null,"prompt":"hello"},"enabled":false,"require_approval":false,"quick_routine":false}'
	);
	await createJob(target, {
		name: "Routine",
		schedule: { kind: "every", interval: "1h" },
		target: { type: "workflow", workflowId: "workflow" },
		enabled: true,
		ownerApp: "app",
	});
	expect(bodies[1]).toBe(
		'{"name":"Routine","schedule":{"kind":"every","interval":"1h"},"target":{"type":"workflow","workflow_id":"workflow","input":{}},"enabled":true,"require_approval":false,"owner_app":"app"}'
	);
});

test("updates preserve false values, conversation omission, and model order", async () => {
	const bodies: string[] = [];
	globalThis.fetch = Object.assign(
		async (_input: RequestInfo | URL, init?: RequestInit) => {
			bodies.push(String(init?.body));
			return Response.json({ job });
		},
		{ preconnect: originalFetch.preconnect }
	);
	await updateJob(target, "job", {
		target: {
			type: "agent",
			agentId: "agent",
			prompt: "hello",
			model: "model",
		},
		enabled: false,
		requireApproval: false,
	});
	expect(bodies[0]).toBe(
		'{"target":{"type":"agent","agent_id":"agent","prompt":"hello","model":"model"},"enabled":false,"require_approval":false}'
	);
	await updateJob(target, "job", {});
	expect(bodies[1]).toBe("{}");
});

test("Core errors keep empty messages, status fallbacks, and run outcomes", async () => {
	const input = {
		name: "Routine",
		schedule: { kind: "every", interval: "1h" },
		target: { type: "agent", agentId: "agent", prompt: "hello" },
		enabled: true,
	} satisfies Parameters<typeof createJob>[1];
	respond({ error: "" }, 400);
	await expect(createJob(target, input)).rejects.toMatchObject({ message: "" });
	respond({ error: 12 }, 403);
	await expect(updateJob(target, "job", {})).rejects.toThrow(
		"Failed to update job (403)"
	);
	respond({ success: false, error: "failure" });
	await expect(runJobNow(target, "job")).rejects.toThrow("failure");
	respond({ success: false });
	await expect(runJobNow(target, "job")).rejects.toThrow(
		"The job failed to run."
	);
	respond({ success: true, run_id: "run" });
	expect(await runJobNow(target, "job")).toBe("run");
	respond({});
	expect(await runJobNow(target, "job")).toBeNull();
});
