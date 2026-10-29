import { afterAll, beforeEach, expect, test } from "bun:test";
import {
	addProjectMember,
	clearScopeDefault,
	createProject,
	type EffectiveDefaults,
	ensureMainThread,
	ensureProjectMainThread,
	fetchEffectiveDefaults,
	fetchProjects,
	fetchScopeDefaults,
	fetchThreadSessions,
	findMainThread,
	rekeyProjectMemory,
	saveProjectDefaults,
	setScopeDefault,
	setThreadCoordination,
	setThreadProject,
} from "./hierarchy.ts";

// Run in a separate Bun process. Only the HTTP authority is finite: these are
// the production hierarchy callers and shared authentication/error plumbing.
interface ExpectedCall {
	body?: unknown;
	method: string;
	path: string;
	response: unknown;
	status?: number;
}
const expected: ExpectedCall[] = [];
const received: Omit<ExpectedCall, "response" | "status">[] = [];
const mismatches: string[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const text = await request.text();
		const call: Omit<ExpectedCall, "response" | "status"> = {
			path: url.pathname + url.search,
			method: request.method,
			...(text ? { body: JSON.parse(text) } : undefined),
		};
		received.push(call);
		const next = expected.shift();
		if (
			!next ||
			request.headers.get("authorization") !== "Bearer fixture-node" ||
			request.headers.get("x-ryu-user-jwt") !== "fixture-delegation" ||
			request.headers.get("content-type") !== "application/json" ||
			call.path !== next.path ||
			call.method !== next.method ||
			JSON.stringify(call.body) !== JSON.stringify(next.body)
		) {
			mismatches.push(`${call.method} ${call.path}`);
			return Response.json(
				{ error: "unexpected hierarchy request" },
				{ status: 422 }
			);
		}
		return Response.json(next.response, { status: next.status ?? 200 });
	},
});
const target = {
	url: server.url.toString(),
	token: "fixture-node",
	userJwt: "fixture-delegation",
};
beforeEach(() => {
	expected.length = 0;
	received.length = 0;
	mismatches.length = 0;
});
afterAll(() => server.stop(true));

test("main-thread lookup, creation and session assignment keep identities and explicit clearing", async () => {
	expected.push(
		{
			path: "/api/hierarchy/main-threads?project_id=p+%26+1&owner_kind=agent&owner_id=bot%3F1",
			method: "GET",
			response: { conversation_id: null },
		},
		{
			path: "/api/hierarchy/main-threads",
			method: "POST",
			body: {
				project_id: "p & 1",
				owner_kind: "agent",
				owner_id: "bot?1",
				agent_id: "runtime-agent",
				title: "Main",
			},
			response: { conversation_id: "main/1" },
		},
		{
			path: "/api/hierarchy/main-threads?owner_kind=group&owner_id=group-1",
			method: "GET",
			response: { conversation_id: "main/1" },
		},
		{
			path: "/api/hierarchy/threads/main%2F1/sessions",
			method: "GET",
			response: {
				sessions: [
					{
						id: "session-1",
						title: "Work",
						agent_id: "runtime-agent",
						run_status: "running",
						message_count: 2,
						updated_at: 42,
					},
				],
			},
		},
		{
			path: "/api/hierarchy/threads/session%2F1/project",
			method: "PUT",
			body: { project_id: "p & 1", spawned_by_conversation_id: "main/1" },
			response: { ok: true },
		},
		{
			path: "/api/hierarchy/threads/session%2F1/project",
			method: "PUT",
			body: { project_id: null },
			response: { ok: true },
		},
		{
			path: "/api/hierarchy/threads/main%2F1/coordination",
			method: "PUT",
			body: { coordination: null },
			response: { ok: true },
		}
	);
	expect(
		await findMainThread(target, {
			projectId: "p & 1",
			ownerKind: "agent",
			ownerId: "bot?1",
		})
	).toBeNull();
	expect(
		await ensureMainThread(target, {
			projectId: "p & 1",
			ownerKind: "agent",
			ownerId: "bot?1",
			agentId: "runtime-agent",
			title: "Main",
		})
	).toBe("main/1");
	expect(
		await findMainThread(target, { ownerKind: "group", ownerId: "group-1" })
	).toBe("main/1");
	expect(await fetchThreadSessions(target, "main/1")).toEqual([
		{
			id: "session-1",
			title: "Work",
			agent_id: "runtime-agent",
			run_status: "running",
			message_count: 2,
			updated_at: 42,
		},
	]);
	await setThreadProject(target, "session/1", "p & 1", "main/1");
	await setThreadProject(target, "session/1", null);
	await setThreadCoordination(target, "main/1", null);
	expect(mismatches).toEqual([]);
	expect(expected).toEqual([]);
	expect(received).toHaveLength(7);
});

test("scope defaults preserve coordinator fields, inheritance and reset rather than manufacturing defaults", async () => {
	const defaults = {
		provider: "provider",
		model: "worker",
		effort: "high",
		coordinatorProvider: "other",
		coordinatorModel: "coordinator",
		coordinatorEffort: "low",
	};
	const effective: EffectiveDefaults = {
		levels: {
			agent: defaults,
			project: null,
			agent_binding_model: null,
			global: null,
			project_agent: null,
			session: null,
			settings: null,
		},
		resolved: {
			provider: "other",
			model: "coordinator",
			effort: "low",
			model_source: "agent",
			effort_source: "agent",
		},
	};
	expected.push(
		{
			path: "/api/scope-defaults/project%3Ap1%2Fagent%3Aa1",
			method: "PUT",
			body: defaults,
			response: { ok: true },
		},
		{
			path: "/api/scope-defaults",
			method: "GET",
			response: { defaults: { "project:p1/agent:a1": defaults } },
		},
		{
			path: "/api/hierarchy/effective-defaults?project_id=p+%26+1&agent_id=bot%3F1&session_provider=provider&session_model=worker&session_effort=high&inherited_only=true&thread_role=main",
			method: "GET",
			response: effective,
		},
		{
			path: "/api/scope-defaults/project%3Ap1%2Fagent%3Aa1",
			method: "DELETE",
			response: { ok: true },
		},
		{
			path: "/api/hierarchy/effective-defaults",
			method: "GET",
			response: effective,
		}
	);
	await setScopeDefault(target, "project:p1/agent:a1", defaults);
	expect(await fetchScopeDefaults(target)).toEqual({
		"project:p1/agent:a1": defaults,
	});
	expect(
		await fetchEffectiveDefaults(target, {
			projectId: "p & 1",
			agentId: "bot?1",
			session: defaults,
			inheritedOnly: true,
			role: "coordinator",
		})
	).toEqual(effective);
	await clearScopeDefault(target, "project:p1/agent:a1");
	expect(
		await fetchEffectiveDefaults(target, {
			projectId: "",
			inheritedOnly: false,
			role: "thread",
		})
	).toEqual(effective);
	expect(mismatches).toEqual([]);
	expect(expected).toEqual([]);
	expect(received).toHaveLength(5);
});

test("project creation, membership and defaults use the owning app and acknowledged main thread", async () => {
	const defaults = { provider: "p", model: "m", effort: "medium" };
	const project = {
		id: "p/1",
		name: "Atlas",
		description: "Goal",
		status: "active",
		coordinatorConversationId: "main-1",
	};
	expected.push(
		{
			path: "/api/projects/projects",
			method: "POST",
			body: {
				name: "Atlas",
				description: "Goal",
				instructions: "Instructions",
				icon: null,
				coordinatorAgent: "ryu",
				cwd: "/work/atlas",
				defaults: { effort: "", model: "", provider: "" },
				executionMode: "auto",
			},
			response: project,
		},
		{
			path: "/api/projects/projects",
			method: "GET",
			response: { projects: [project] },
		},
		{
			path: "/api/projects/projects/p%2F1/main-thread",
			method: "POST",
			response: { conversationId: "main-1" },
		},
		{
			path: "/api/projects/projects/p%2F1/members",
			method: "POST",
			body: { id: "review", kind: "agent", name: "Reviewer" },
			response: {
				...project,
				members: [
					{
						id: "review",
						kind: "agent",
						name: "Reviewer",
						mainThreadId: "review-main",
					},
				],
			},
		},
		{
			path: "/api/projects/projects/p%2F1/defaults",
			method: "PUT",
			body: defaults,
			response: { ...project, defaults },
		},
		{
			path: "/api/hierarchy/memory/rekey-project",
			method: "POST",
			body: { from_scope_id: "/work/atlas", to_project_id: "p/1" },
			response: { moved: 3 },
		}
	);
	expect(
		await createProject(target, {
			name: "Atlas",
			description: "Goal",
			instructions: "Instructions",
			coordinatorAgent: "ryu",
			cwd: "/work/atlas",
		})
	).toEqual(project);
	expect(await fetchProjects(target)).toEqual([project]);
	expect(await ensureProjectMainThread(target, "p/1")).toBe("main-1");
	expect(
		(
			await addProjectMember(target, "p/1", {
				id: "review",
				kind: "agent",
				name: "Reviewer",
			})
		).members?.[0]?.mainThreadId
	).toBe("review-main");
	expect((await saveProjectDefaults(target, "p/1", defaults)).defaults).toEqual(
		defaults
	);
	expect(await rekeyProjectMemory(target, "/work/atlas", "p/1")).toBe(3);
	expect(mismatches).toEqual([]);
	expect(expected).toEqual([]);
	expect(received).toHaveLength(6);
});

test("permission and conflict refusals propagate without automatic duplicate writes; retry is explicit", async () => {
	const value = { provider: "p", model: "m", effort: "high" };
	expected.push(
		{
			path: "/api/scope-defaults/global",
			method: "PUT",
			body: value,
			response: { error: "not allowed to change these defaults" },
			status: 403,
		},
		{
			path: "/api/projects/projects/p1/main-thread",
			method: "POST",
			response: { error: "owner conflict" },
			status: 409,
		},
		{
			path: "/api/projects/projects/p1/main-thread",
			method: "POST",
			response: { conversationId: "main-1" },
		}
	);
	await expect(setScopeDefault(target, "global", value)).rejects.toMatchObject({
		status: 403,
		serverMessage: "not allowed to change these defaults",
	});
	expect(received).toHaveLength(1);
	await expect(ensureProjectMainThread(target, "p1")).rejects.toMatchObject({
		status: 409,
		serverMessage: "owner conflict",
	});
	expect(received).toHaveLength(2);
	expect(await ensureProjectMainThread(target, "p1")).toBe("main-1");
	expect(mismatches).toEqual([]);
	expect(expected).toEqual([]);
	expect(received).toHaveLength(3);
});

test("main-thread callers reject unusable acknowledgement IDs before returning them", async () => {
	expected.push(
		{
			path: "/api/hierarchy/main-threads",
			method: "POST",
			body: { owner_kind: "agent", owner_id: "review" },
			response: {},
		},
		{
			path: "/api/projects/projects/p1/main-thread",
			method: "POST",
			response: { conversationId: "   " },
		},
		{
			path: "/api/projects/projects/p1/main-thread",
			method: "POST",
			response: { conversationId: " main-1 " },
		},
		{
			path: "/api/projects/projects/p1/main-thread",
			method: "POST",
			response: { conversationId: "main-1" },
		}
	);
	await expect(
		ensureMainThread(target, { ownerKind: "agent", ownerId: "review" })
	).rejects.toThrow("no main thread id");
	await expect(ensureProjectMainThread(target, "p1")).rejects.toThrow(
		"no main thread id"
	);
	await expect(ensureProjectMainThread(target, "p1")).rejects.toThrow(
		"no main thread id"
	);
	expect(await ensureProjectMainThread(target, "p1")).toBe("main-1");
	expect(mismatches).toEqual([]);
	expect(expected).toEqual([]);
	expect(received).toHaveLength(4);
});

test("scope writes and resets preserve legal identifier punctuation on the wire", async () => {
	const scope = "project:p#1/agent:bot?1 & ü";
	const value = { provider: "provider", model: "worker", effort: "" };
	const path =
		"/api/scope-defaults/project%3Ap%231%2Fagent%3Abot%3F1%20%26%20%C3%BC";
	expected.push(
		{ path, method: "PUT", body: value, response: { ok: true } },
		{ path, method: "DELETE", response: { ok: true } }
	);
	await setScopeDefault(target, scope, value);
	await clearScopeDefault(target, scope);
	expect(mismatches).toEqual([]);
	expect(expected).toEqual([]);
	expect(received).toHaveLength(2);
});
