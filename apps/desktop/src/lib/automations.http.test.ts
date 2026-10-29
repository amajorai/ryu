import { expect, test } from "bun:test";
import { createJob } from "./api/schedules.ts";
import { createScheduledAgentWorkflow } from "./automations.ts";

test("Calendar's real routine caller forwards atomic slot and omitted/null destinations with exact retry", async () => {
	const calls: {
		path: string;
		method: string;
		body: unknown;
		auth: string | null;
		identity: string | null;
	}[] = [];
	let refuse = true;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			const body: unknown =
				request.method === "POST" ? await request.json() : null;
			calls.push({
				path,
				method: request.method,
				body,
				auth: request.headers.get("authorization"),
				identity: request.headers.get("x-ryu-user-jwt"),
			});
			if (path === "/node/heartbeat/jobs" && request.method === "POST") {
				if (refuse) {
					refuse = false;
					return Response.json(
						{ success: false, error: "Reviewed routine write refused" },
						{ status: 500 }
					);
				}
				return Response.json({
					job: {
						id: "same-routine-id",
						name: "Renamed (scheduled)",
						schedule: { kind: "every", interval: "1h" },
						target: {
							type: "agent",
							agent_id: "review-agent",
							prompt: "Run",
							conversation_id: "retained-chat",
						},
						created_at: "original-created",
						updated_at: "acknowledged",
						history: [],
						enabled: true,
						require_approval: true,
					},
				});
			}
			if (path === "/node/workflows" && request.method === "GET") {
				// Accepted routine remains accepted if optional migration read fails.
				return Response.json(
					{ error: "legacy workflow visibility refused" },
					{ status: 403 }
				);
			}
			return Response.json(
				{ error: "Unexpected fixture request" },
				{ status: 400 }
			);
		},
	});
	try {
		const target = {
			url: `${server.url}node`,
			token: "node-admission",
			userJwt: "delegated-reviewer",
		};
		const args = {
			agentId: "review-agent",
			agentName: "Renamed",
			schedule: { kind: "every" as const, interval: "1h" },
			requireApproval: true,
		};
		await expect(createScheduledAgentWorkflow(target, args)).rejects.toThrow(
			"Reviewed routine write refused"
		);
		await createScheduledAgentWorkflow(target, args);
		await createScheduledAgentWorkflow(target, {
			...args,
			conversationId: null,
		});
		await createScheduledAgentWorkflow(target, {
			...args,
			conversationId: "selected-chat",
		});
		const writes = calls.filter((call) => call.method === "POST");
		const base = {
			name: "Renamed (scheduled)",
			schedule: args.schedule,
			target: { type: "agent", agent_id: "review-agent", prompt: "Run" },
			enabled: true,
			require_approval: true,
			quick_routine: true,
		};
		expect(writes.map((call) => call.body)).toEqual([
			base,
			base,
			{ ...base, target: { ...base.target, conversation_id: null } },
			{ ...base, target: { ...base.target, conversation_id: "selected-chat" } },
		]);
		expect(calls.map((call) => [call.method, call.path])).toEqual([
			["POST", "/node/heartbeat/jobs"],
			["POST", "/node/heartbeat/jobs"],
			["GET", "/node/workflows"],
			["POST", "/node/heartbeat/jobs"],
			["GET", "/node/workflows"],
			["POST", "/node/heartbeat/jobs"],
			["GET", "/node/workflows"],
		]);
		for (const call of calls) {
			expect(call.auth).toBe("Bearer node-admission");
			expect(call.identity).toBe("delegated-reviewer");
		}
		calls.length = 0;
		await createJob(target, {
			name: "Independent",
			schedule: args.schedule,
			target: { type: "agent", agentId: "review-agent", prompt: "Independent" },
			enabled: true,
		});
		expect(calls[0]?.body).toEqual({
			name: "Independent",
			schedule: args.schedule,
			target: {
				type: "agent",
				agent_id: "review-agent",
				prompt: "Independent",
			},
			enabled: true,
			require_approval: false,
		});
	} finally {
		server.stop(true);
	}
});
