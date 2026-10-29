import { readFile } from "node:fs/promises";
import path from "node:path";
import {
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";

interface ProjectTask {
	dueDate: string;
	id: string;
	owner: string;
	status: "todo" | "doing" | "done";
	title: string;
}

interface ProjectRecord {
	client: string;
	coordinatorAgent?: string | null;
	coordinatorConversationId?: string | null;
	createdAt: number;
	cwd?: string | null;
	description: string;
	dueDate: string;
	executionMode: "auto" | "cloud" | "local";
	id: string;
	name: string;
	owner: string;
	status: "planned" | "active" | "blocked" | "done";
	tasks: ProjectTask[];
	updatedAt: number;
}

const ProjectSchema = z.object({
	client: z.string(),
	coordinatorAgent: z.string().nullable().optional(),
	coordinatorConversationId: z.string().nullable().optional(),
	createdAt: z.number(),
	cwd: z.string().nullable().optional(),
	description: z.string(),
	dueDate: z.string(),
	executionMode: z.enum(["auto", "cloud", "local"]),
	id: z.string(),
	name: z.string(),
	owner: z.string(),
	status: z.enum(["planned", "active", "blocked", "done"]),
	tasks: z.array(
		z.object({
			dueDate: z.string(),
			id: z.string(),
			owner: z.string(),
			status: z.enum(["todo", "doing", "done"]),
			title: z.string(),
		})
	),
	updatedAt: z.number(),
}) satisfies z.ZodType<ProjectRecord>;

interface ContextRecord {
	content: string;
	id: string;
	kind: string;
	projectId: string;
	title: string;
	updatedAt: number;
}

interface WorkerRecord {
	conversationId: string | null;
	createdAt: number;
	id: string;
	projectId: string;
	status: string;
	task: string;
	title: string;
	updatedAt: number;
}

interface SubscriptionRecord {
	enabled: boolean;
	id: string;
	kind: string;
	name: string;
	projectId: string;
	schedule?: string | null;
	updatedAt: number;
}

interface SpaceDoc {
	id: string;
	source: string;
	title: string;
	updated_at: number;
}

interface FixtureCall {
	body?: unknown;
	method: string;
	path: string;
}

interface FixtureState {
	calls: FixtureCall[];
	context: Map<string, ContextRecord[]>;
	createFailures: number;
	docs: SpaceDoc[];
	failPatch: number;
	failRun: number;
	failWorker: number;
	nextId: number;
	projects: ProjectRecord[];
	spaceCalls: { method: string; payload: unknown }[];
	subscriptions: Map<string, SubscriptionRecord[]>;
	workers: Map<string, WorkerRecord[]>;
}

const appHtmlPath = path.resolve(
	import.meta.dirname,
	"../../../apps-store/projects/ui/dist/index.html"
);
const port = 62_843;
const appHtml = await readFile(appHtmlPath, "utf8");
const bridgeScript = `<script>
const postFixture = async (kind, payload) => {
  const response = await fetch("/__fixture/" + kind, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Projects fixture request failed");
  return result;
};
window.ryu = {
  app: { request: (input) => postFixture("request", input) },
  spaces: {
    ensureSpace: (input) => postFixture("space/ensure", input),
    listDocs: (input) => postFixture("space/list", input),
    getDoc: (input) => postFixture("space/get", input),
    createDoc: (input) => postFixture("space/create", input),
    updateDoc: (input) => postFixture("space/update", input),
  },
  ui: { toast: { show: async () => "fixture-toast" } },
};
</script>`;
const html = appHtml.replace("<head>", `<head>${bridgeScript}`);
if (html === appHtml) {
	throw new Error("The compiled Projects app is missing its document head.");
}

const timestamp = 1_790_000_000_000;
function project(
	id: string,
	name: string,
	status: ProjectRecord["status"],
	tasks: ProjectTask[] = []
): ProjectRecord {
	return {
		client: "Northstar Labs",
		coordinatorAgent: null,
		coordinatorConversationId: null,
		createdAt: timestamp,
		cwd: "/workspace/ryu",
		description: `${name} outcome brief`,
		dueDate: "2026-10-10",
		executionMode: "auto",
		id,
		name,
		owner: "Mira",
		status,
		tasks,
		updatedAt: timestamp,
	};
}

function standardProjects(): ProjectRecord[] {
	return [
		project("project-launch", "Launch workspace", "active", [
			{
				dueDate: "2026-10-02",
				id: "task-review",
				owner: "Mira",
				status: "todo",
				title: "Review launch brief",
			},
		]),
		project("project-planned", "Planned workspace", "planned"),
		project("project-blocked", "Blocked workspace", "blocked"),
		project("project-done", "Done workspace", "done"),
	];
}

function freshState(
	options: {
		createFailures?: number;
		failPatch?: number;
		failRun?: number;
		failWorker?: number;
		seed?: string;
	} = {}
): FixtureState {
	return {
		calls: [],
		context: new Map(),
		createFailures: isNativeNumber(options.createFailures)
			? options.createFailures
			: 0,
		docs: [],
		failPatch: isNativeNumber(options.failPatch) ? options.failPatch : 0,
		failRun: isNativeNumber(options.failRun) ? options.failRun : 0,
		failWorker: isNativeNumber(options.failWorker) ? options.failWorker : 0,
		projects: options.seed === "empty" ? [] : standardProjects(),
		spaceCalls: [],
		subscriptions: new Map(),
		nextId: 1,
		workers: new Map(),
	};
}

let state = freshState();
function json<FixturePayload>(value: FixturePayload, status = 200): Response {
	return Response.json(value, { status });
}

function ensureSnapshotLists(projectId: string) {
	state.context.set(projectId, state.context.get(projectId) ?? []);
	state.workers.set(projectId, state.workers.get(projectId) ?? []);
	state.subscriptions.set(projectId, state.subscriptions.get(projectId) ?? []);
}

function projectSnapshot(projectId: string) {
	const item = state.projects.find((candidate) => candidate.id === projectId);
	if (!item) {
		return null;
	}
	ensureSnapshotLists(projectId);
	return {
		context: structuredClone(state.context.get(projectId)),
		project: structuredClone(item),
		subscriptions: structuredClone(state.subscriptions.get(projectId)),
		workers: structuredClone(state.workers.get(projectId)),
	};
}

function requestResult(input: {
	body?: unknown;
	method?: string;
	path: string;
}): Response {
	const method = input.method ?? "GET";
	const requestPath = input.path;
	const body = z.record(z.string(), z.json()).parse(input.body ?? {});
	state.calls.push({
		body: structuredClone(input.body),
		method,
		path: requestPath,
	});

	if (method === "GET" && requestPath === "/bootstrap") {
		return json({
			execution: { node: "active" },
			projects: structuredClone(state.projects),
		});
	}
	if (method === "POST" && requestPath === "/projects") {
		if (state.createFailures > 0) {
			state.createFailures -= 1;
			return json(
				{ error: "Fixture project create temporarily unavailable." },
				503
			);
		}
		const created: ProjectRecord = {
			client: String(body.client ?? "Internal"),
			coordinatorAgent: null,
			coordinatorConversationId: null,
			createdAt: timestamp + state.nextId,
			cwd: String(body.cwd ?? "") || null,
			description: String(body.description ?? ""),
			dueDate: String(body.dueDate ?? ""),
			executionMode:
				body.executionMode === "cloud" || body.executionMode === "local"
					? body.executionMode
					: "auto",
			id: `project-created-${state.nextId++}`,
			name: String(body.name ?? ""),
			owner: String(body.owner ?? ""),
			status: "planned",
			tasks: [],
			updatedAt: timestamp + state.nextId,
		};
		state.projects.unshift(created);
		ensureSnapshotLists(created.id);
		return json(structuredClone(created), 201);
	}

	const projectRoute = requestPath.match(/^\/projects\/([^/]+)(.*)$/);
	if (!projectRoute) {
		return json(
			{ error: `Unsupported Projects fixture path: ${method} ${requestPath}` },
			404
		);
	}
	const projectId = decodeURIComponent(projectRoute[1] ?? "");
	const suffix = projectRoute[2] ?? "";
	const existing = state.projects.find((item) => item.id === projectId);
	if (method === "GET" && !suffix) {
		const snapshot = projectSnapshot(projectId);
		return snapshot
			? json(snapshot)
			: json({ error: "Project not found." }, 404);
	}
	if (method === "PATCH" && !suffix) {
		if (state.failPatch > 0) {
			state.failPatch -= 1;
			return json({ error: "Fixture rejected project update." }, 503);
		}
		if (!existing) {
			return json({ error: "Project not found." }, 404);
		}
		Object.assign(existing, structuredClone(body), {
			updatedAt: timestamp + state.nextId++,
		});
		return json(structuredClone(existing));
	}
	if (method === "POST" && suffix === "/context") {
		if (!existing) {
			return json({ error: "Project not found." }, 404);
		}
		ensureSnapshotLists(projectId);
		const note: ContextRecord = {
			content: String(body.content ?? ""),
			id: `context-${state.nextId++}`,
			kind: String(body.kind ?? "note"),
			projectId,
			title: String(body.title ?? ""),
			updatedAt: timestamp + state.nextId,
		};
		state.context.get(projectId)?.unshift(note);
		return json(structuredClone(note), 201);
	}
	if (method === "POST" && suffix === "/run") {
		if (state.failRun > 0) {
			state.failRun -= 1;
			return json(
				{ error: "Fixture coordinator is temporarily offline." },
				503
			);
		}
		if (!existing) {
			return json({ error: "Project not found." }, 404);
		}
		existing.coordinatorConversationId ??= `conversation-${projectId}`;
		existing.status = "active";
		return json({
			conversation_id: existing.coordinatorConversationId,
			status: "started",
		});
	}
	if (method === "POST" && suffix === "/workers") {
		if (state.failWorker > 0) {
			state.failWorker -= 1;
			return json(
				{ error: "Fixture worker dispatch temporarily unavailable." },
				503
			);
		}
		if (!existing) {
			return json({ error: "Project not found." }, 404);
		}
		ensureSnapshotLists(projectId);
		const now = timestamp + state.nextId++;
		const worker: WorkerRecord = {
			conversationId: `worker-conversation-${now}`,
			createdAt: now,
			id: `worker-${now}`,
			projectId,
			status: "running",
			task: String(body.task ?? ""),
			title: String(body.title ?? ""),
			updatedAt: now,
		};
		state.workers.get(projectId)?.unshift(worker);
		return json(structuredClone(worker), 201);
	}
	if (method === "POST" && suffix === "/subscriptions") {
		if (!existing) {
			return json({ error: "Project not found." }, 404);
		}
		ensureSnapshotLists(projectId);
		const now = timestamp + state.nextId++;
		const subscription: SubscriptionRecord = {
			enabled: body.enabled !== false,
			id: `subscription-${now}`,
			kind: String(body.kind ?? "schedule"),
			name: String(body.name ?? ""),
			projectId,
			schedule: isNativeText(body.schedule) ? body.schedule : null,
			updatedAt: now,
		};
		state.subscriptions.get(projectId)?.unshift(subscription);
		return json(structuredClone(subscription), 201);
	}
	if (method === "POST" && requestPath === "/projects/import") {
		const imported = ProjectSchema.optional().parse(body.project);
		if (imported && !state.projects.some((item) => item.id === imported.id)) {
			state.projects.push(structuredClone(imported));
		}
		return json({ imported: false, project: imported ?? null });
	}
	return json(
		{ error: `Unsupported Projects fixture route: ${method} ${requestPath}` },
		404
	);
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__ready") {
			return new Response("ok");
		}
		if (url.pathname === "/__fixture/reset" && request.method === "POST") {
			state = freshState(await request.json());
			return json({ ok: true });
		}
		if (url.pathname === "/__fixture/state") {
			return json({
				calls: state.calls,
				context: Object.fromEntries(state.context),
				docs: state.docs,
				projects: state.projects,
				spaceCalls: state.spaceCalls,
				subscriptions: Object.fromEntries(state.subscriptions),
				workers: Object.fromEntries(state.workers),
			});
		}
		if (url.pathname === "/__fixture/request" && request.method === "POST") {
			return requestResult(await request.json());
		}
		if (
			url.pathname.startsWith("/__fixture/space/") &&
			request.method === "POST"
		) {
			const method = url.pathname.slice("/__fixture/space/".length);
			const payload = await request.json();
			state.spaceCalls.push({ method, payload: structuredClone(payload) });
			if (method === "ensure") {
				return json("projects-space");
			}
			if (method === "list") {
				return json(
					state.docs.map(({ id, title, updated_at }) => ({
						id,
						title,
						updated_at,
					}))
				);
			}
			if (method === "get") {
				const doc = state.docs.find((item) => item.id === payload.doc_id);
				return json(
					doc ? { id: doc.id, source: doc.source, title: doc.title } : null
				);
			}
			if (method === "create") {
				const id = `spaces-doc-${state.nextId++}`;
				state.docs.push({
					id,
					source: "",
					title: String(payload.title ?? ""),
					updated_at: timestamp,
				});
				return json(id);
			}
			if (method === "update") {
				const doc = state.docs.find((item) => item.id === payload.doc_id);
				if (!doc) {
					return json({ error: "Spaces document not found." }, 404);
				}
				doc.title = String(payload.title ?? doc.title);
				doc.source = String(payload.source ?? doc.source);
				doc.updated_at = timestamp + state.nextId++;
				return json({ ok: true });
			}
			return json({ error: `Unsupported Spaces fixture call: ${method}` }, 404);
		}
		if (url.pathname === "/favicon.ico") {
			return new Response(null, { status: 204 });
		}
		return new Response(html, {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	},
});

const stop = () => server.stop();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
