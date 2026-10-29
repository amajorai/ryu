import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const desktopDir = path.resolve(import.meta.dirname, "..");
const repositoryDir = path.resolve(desktopDir, "../..");
const uiDirectory = path.join(repositoryDir, "apps-store/feedback-board/ui");
const proofBuildDirectory = await mkdtemp(
	path.join(os.tmpdir(), "ryu-feedback-board-proof-")
);
const adminHtmlPath = path.join(proofBuildDirectory, "admin/index.html");
const publicHtmlPath = path.join(proofBuildDirectory, "public/public.html");
const port = 5198;

import {
	AutomationBodySchema,
	BoardPatchSchema,
	BriefBodySchema,
	type FixtureComment as CommentRecord,
	CommentReviewSchema,
	FailureBodySchema,
	type FixtureAutomationRun,
	type FixtureBoard,
	type FixtureRelease,
	type FixtureWorkspace,
	MergeBodySchema,
	PublicCommentBodySchema,
	PublicRequestBodySchema,
	parseFeedbackFixtureBody,
	ReleaseDraftSchema,
	ReleasePublishSchema,
	RequestPatchSchema,
	type FixtureRequest as RequestRecord,
	ResetBodySchema,
	TriageBodySchema,
	WorkspacePatchSchema,
} from "./feedback-board-fixture-contract.ts";
import type { ProofJsonRecord } from "./fixture-json.ts";

interface FixtureState {
	automationRuns: Map<string, FixtureAutomationRun[]>;
	board: FixtureBoard;
	calls: ProofJsonRecord[];
	comments: Map<string, CommentRecord[]>;
	docs: Map<string, { source: string; title: string }>;
	failNext: { method: string; path: string; status: number } | null;
	releases: FixtureRelease[];
	requests: Map<string, RequestRecord>;
	votes: Map<string, Set<string>>;
	workflowDefinitions: Map<string, ProofJsonRecord>;
	workflowInputs: ProofJsonRecord[];
	workspace: FixtureWorkspace;
}

function seedState(emptyBoard = false): FixtureState {
	const now = 1_780_000_000_000;
	const statuses = [
		{ code: "new", label: "New", tone: "blue", terminal: false },
		{ code: "review", label: "Under review", tone: "amber", terminal: false },
		{ code: "planned", label: "Planned", tone: "violet", terminal: false },
		{
			code: "in_progress",
			label: "In progress",
			tone: "lime",
			terminal: false,
		},
		{ code: "shipped", label: "Shipped", tone: "green", terminal: true },
		{ code: "closed", label: "Closed", tone: "neutral", terminal: true },
	];
	const workspace: FixtureWorkspace = {
		allow_guest_posts: true,
		default_agent_id: "agent-feedback",
		default_automation_mode: "assist",
		default_workflow_id: "workflow-feedback",
		description: "Help us decide what to build next.",
		id: "workspace-feedback",
		moderate_public_writes: false,
		name: "Ryu Product Board",
		primary_color: "#2563eb",
		revision: 1,
		slug: "product",
		updated_at: now,
	};
	const board: FixtureBoard = {
		allow_guest_posts: true,
		automation_mode: null,
		description: "Tell us what would make the product better.",
		id: "board-feedback",
		moderate_public_writes: false,
		name: "Feedback",
		revision: 1,
		slug: "demo",
		statuses,
		updated_at: now,
		workspace_id: "workspace-feedback",
	};
	const makeRequest = (
		id: string,
		title: string,
		status: string,
		vote_count: number,
		created_at: number,
		public_visible = true
	): RequestRecord => ({
		ai_summary: null,
		author_email: null,
		author_name: "Ada",
		automation_mode: null,
		board_id: "board-feedback",
		body: `${title} would help customers complete a common product task.`,
		category: "Ideas",
		comment_count: 0,
		created_at,
		duplicate_confidence: null,
		duplicate_of: null,
		id,
		impact_score: null,
		internal_notes: "Private operator note",
		moderation_state: public_visible ? "approved" : "pending",
		plan_id: null,
		priority: 0,
		public_visible,
		revision: 1,
		shipped_at: status === "shipped" ? created_at : null,
		space_doc_id: null,
		status,
		tags: [],
		title,
		updated_at: created_at,
		vote_count,
		workflow_run_id: null,
	});
	const csvRequest = makeRequest(
		"req-export",
		"CSV export",
		"review",
		3,
		now - 30_000
	);
	csvRequest.comment_count = 1;
	const requests = new Map([
		["req-export", csvRequest],
		[
			"req-dark-mode",
			makeRequest("req-dark-mode", "Dark mode toggle", "new", 1, now - 10_000),
		],
		[
			"req-shipped",
			makeRequest(
				"req-shipped",
				"Keyboard navigation",
				"shipped",
				7,
				now - 1000
			),
		],
	]);
	if (emptyBoard) {
		requests.clear();
	}
	return {
		board,
		comments: new Map([
			[
				"req-export",
				[
					{
						author_name: "Lin",
						body: "This would save our support team time.",
						created_at: now - 2000,
						id: "comment-seed",
						moderation_state: "approved",
						request_id: "req-export",
						visibility: "public",
					},
				],
			],
		]),
		docs: new Map(),
		failNext: null,
		calls: [],
		requests,
		releases: [
			{
				body: "Keyboard users can now move through the primary controls.",
				created_at: now - 500,
				id: "release-seed",
				published_at: now - 100,
				request_ids: ["req-shipped"],
				status: "published",
				title: "Keyboard navigation",
				updated_at: now - 100,
				workspace_id: "workspace-feedback",
			},
		],
		votes: new Map(),
		workspace,
		automationRuns: new Map(),
		workflowDefinitions: new Map(),
		workflowInputs: [],
	};
}

let state = seedState();

async function buildSurface(surface: "admin" | "public") {
	const build = Bun.spawn(
		[
			"bun",
			"x",
			"vite",
			"build",
			"--config",
			"vite.config.ts",
			"--outDir",
			path.join(proofBuildDirectory, surface),
		],
		{
			cwd: uiDirectory,
			env: { ...process.env, FEEDBACK_BOARD_SURFACE: surface },
			stderr: "inherit",
			stdout: "inherit",
		}
	);
	const code = await build.exited;
	if (code !== 0) {
		throw new Error(
			`Feedback Board ${surface} build failed with exit code ${code}.`
		);
	}
}

function json<FixturePayload>(body: FixturePayload, status = 200) {
	return Response.json(body, { status });
}

function errorResponse(status: number, code: string, message: string) {
	return json({ error: { code, message } }, status);
}

async function requestBody(request: Request) {
	try {
		return parseFeedbackFixtureBody(await request.text());
	} catch {
		return {};
	}
}

function publicRequest(request: RequestRecord) {
	const statuses = state.board.statuses;
	const status = statuses.find(
		(candidate) => candidate.code === request.status
	);
	return {
		author_name: request.author_name,
		body: request.body,
		category: request.category,
		comment_count: request.comment_count,
		created_at: request.created_at,
		id: request.id,
		shipped_at: request.shipped_at,
		status: {
			code: request.status,
			label: status?.label ?? request.status,
			terminal: status?.terminal ?? false,
			tone: status?.tone ?? "neutral",
		},
		tags: request.tags,
		title: request.title,
		updated_at: request.updated_at,
		vote_count: request.vote_count,
	};
}

function publicBoard() {
	return {
		board_description: state.board.description,
		board_id: state.board.id,
		board_name: state.board.name,
		board_slug: state.board.slug,
		statuses: state.board.statuses,
		workspace_description: state.workspace.description,
		workspace_name: state.workspace.name,
		workspace_primary_color: state.workspace.primary_color,
	};
}

function recordCall(
	surface: string,
	method: string,
	path: string,
	body?: ProofJsonRecord,
	metadata?: ProofJsonRecord
) {
	const call: ProofJsonRecord = {};
	if (body !== undefined) {
		call.body = body;
	}
	Object.assign(call, { method, path, surface, ...metadata });
	state.calls.push(call);
}

function consumeFailure(method: string, path: string) {
	if (
		state.failNext &&
		state.failNext.method === method &&
		state.failNext.path === path
	) {
		const failure = state.failNext;
		state.failNext = null;
		return failure;
	}
	return null;
}

function adminRequestList(query: string) {
	const normalized = query.trim().toLowerCase();
	return [...state.requests.values()].filter(
		(request) =>
			!normalized ||
			`${request.title} ${request.body} ${request.category}`
				.toLowerCase()
				.includes(normalized)
	);
}

function roadmap() {
	const requests = adminRequestList("");
	return {
		board: state.board,
		requests,
		statuses: state.board.statuses,
	};
}

async function handleAdmin(request: Request, url: URL) {
	const path = url.pathname.slice("/__admin".length);
	const method = request.method;
	const body =
		method === "GET" || method === "HEAD"
			? undefined
			: await requestBody(request);
	recordCall("admin-api", method, path, body);
	const failure = consumeFailure(method, path);
	if (failure) {
		return errorResponse(
			failure.status,
			"fixture_failure",
			"The fixture rejected this operator action."
		);
	}
	if (method === "GET" && path === "/admin/workspace") {
		return json({ workspace: state.workspace });
	}
	if (method === "PUT" && path === "/admin/workspace") {
		const input = WorkspacePatchSchema.parse(body);
		if (input.revision !== state.workspace.revision) {
			return errorResponse(
				409,
				"conflict",
				"The workspace changed. Refresh before saving."
			);
		}
		state.workspace = {
			...state.workspace,
			...input,
			revision: Number(state.workspace.revision) + 1,
			updated_at: Date.now(),
		};
		if (input.moderate_public_writes !== undefined) {
			state.board.moderate_public_writes = input.moderate_public_writes;
		}
		return json({ workspace: state.workspace });
	}
	if (method === "GET" && path === "/admin/boards") {
		return json({ boards: [state.board] });
	}
	const boardPath = path.match(/^\/admin\/boards\/([^/]+)$/u);
	if (boardPath && method === "PUT") {
		const input = BoardPatchSchema.parse(body);
		if (input.revision !== state.board.revision) {
			return errorResponse(
				409,
				"conflict",
				"The board changed. Refresh before saving."
			);
		}
		state.board = {
			...state.board,
			...input,
			revision: Number(input.revision) + 1,
			updated_at: Date.now(),
		};
		return json({ board: state.board });
	}
	if (method === "GET" && path === "/admin/requests") {
		return json({
			requests: adminRequestList(url.searchParams.get("query") ?? ""),
		});
	}
	const requestRoute = path.match(/^\/admin\/requests\/([^/]+)(?:\/(.*))?$/u);
	if (requestRoute) {
		const requestId = decodeURIComponent(requestRoute[1] ?? "");
		const action = requestRoute[2] ?? "";
		const current = state.requests.get(requestId);
		if (!current) {
			return errorResponse(404, "not_found", "Request not found.");
		}
		if (method === "GET" && !action) {
			return json({
				comments: state.comments.get(requestId) ?? [],
				request: current,
			});
		}
		if (method === "PUT" && !action) {
			const input = RequestPatchSchema.parse(body);
			if (input.revision !== current.revision) {
				return errorResponse(
					409,
					"conflict",
					"The request changed. Refresh before saving."
				);
			}
			const { revision: _revision, ...patch } = input;
			const next: RequestRecord = {
				...current,
				...patch,
				revision: current.revision + 1,
				updated_at: Date.now(),
			};
			if (next.status === "shipped" && !next.shipped_at) {
				next.shipped_at = Date.now();
			}
			state.requests.set(requestId, next);
			return json({ request: next });
		}
		const commentReview = action.match(/^comments\/([^/]+)$/u);
		if (method === "PUT" && commentReview) {
			const input = CommentReviewSchema.parse(body);
			if (input.revision !== current.revision) {
				return errorResponse(
					409,
					"conflict",
					"The request changed. Refresh before reviewing comments."
				);
			}
			const commentId = decodeURIComponent(commentReview[1] ?? "");
			const comment = (state.comments.get(requestId) ?? []).find(
				(item) => item.id === commentId
			);
			if (comment?.moderation_state !== "pending") {
				return errorResponse(404, "not_found", "Pending comment not found.");
			}
			comment.moderation_state = input.approved ? "approved" : "rejected";
			const next: RequestRecord = {
				...current,
				comment_count: current.comment_count + Number(input.approved),
				revision: current.revision + 1,
				updated_at: Date.now(),
			};
			state.requests.set(requestId, next);
			return json({ comment, request: next });
		}
		if (method === "POST" && action === "triage") {
			const suggestion = TriageBodySchema.parse(body).suggestion;
			const next = {
				...current,
				ai_summary: suggestion.summary,
				category: suggestion.category,
				duplicate_confidence: suggestion.confidence,
				impact_score: suggestion.impact_score,
				tags: suggestion.tags,
				revision: current.revision + 1,
				updated_at: Date.now(),
			};
			state.requests.set(requestId, next);
			return json({ request: next, suggestion });
		}
		if (method === "POST" && action === "brief") {
			const docId = BriefBodySchema.parse(body).space_doc_id;
			const next = {
				...current,
				space_doc_id: docId,
				revision: current.revision + 1,
				updated_at: Date.now(),
			};
			state.requests.set(requestId, next);
			return json({ request: next });
		}
		if (method === "POST" && action === "merge") {
			const duplicateId = MergeBodySchema.parse(body).duplicate_request_id;
			const duplicate = state.requests.get(duplicateId);
			if (!duplicate) {
				return errorResponse(404, "not_found", "Duplicate request not found.");
			}
			const survivor = {
				...current,
				vote_count: current.vote_count + duplicate.vote_count,
				comment_count: current.comment_count + duplicate.comment_count,
				revision: current.revision + 1,
				updated_at: Date.now(),
			};
			state.requests.set(requestId, survivor);
			state.requests.set(duplicateId, {
				...duplicate,
				duplicate_of: requestId,
				public_visible: false,
				moderation_state: "merged",
				revision: duplicate.revision + 1,
			});
			return json({ merge: { survivor, merged_request_id: duplicateId } });
		}
		if (method === "GET" && action === "automation") {
			return json({
				request: current,
				runs: state.automationRuns.get(requestId) ?? [],
				workspace: state.workspace,
			});
		}
		if (method === "POST" && action === "automation/run") {
			const input = AutomationBodySchema.parse(body);
			const run = {
				agent_id: input.agent_id ?? null,
				created_at: Date.now(),
				error: null,
				id: `run-${state.calls.length}`,
				mode: input.mode,
				plan_id: input.plan_id ?? null,
				request_id: requestId,
				result_summary: null,
				status: input.status ?? "queued",
				updated_at: Date.now(),
				workflow_id: input.workflow_id ?? null,
				workflow_run_id: input.workflow_run_id ?? null,
			};
			state.automationRuns.set(requestId, [
				...(state.automationRuns.get(requestId) ?? []),
				run,
			]);
			const next = {
				...current,
				plan_id: run.plan_id,
				workflow_run_id: run.workflow_run_id,
				revision: current.revision + 1,
				updated_at: Date.now(),
			};
			state.requests.set(requestId, next);
			return json({ run });
		}
		const resume = action.match(/^automation\/([^/]+)\/resume$/u);
		if (method === "POST" && resume) {
			const runId = decodeURIComponent(resume[1] ?? "");
			const run = (state.automationRuns.get(requestId) ?? []).find(
				(item) => item.id === runId
			);
			if (!run) {
				return errorResponse(404, "not_found", "Automation run not found.");
			}
			Object.assign(run, body, { updated_at: Date.now() });
			return json({ run });
		}
	}
	if (method === "GET" && path === "/admin/roadmap") {
		return json(roadmap());
	}
	if (method === "GET" && path === "/admin/changelog") {
		return json({ releases: state.releases });
	}
	if (method === "POST" && path === "/admin/changelog/drafts") {
		const input = ReleaseDraftSchema.parse(body);
		const release = {
			id: `release-${state.releases.length + 1}`,
			title: input.title,
			body: input.body,
			request_ids: input.request_ids,
			status: "draft",
			published_at: null,
			workspace_id: state.workspace.id,
			created_at: Date.now(),
			updated_at: Date.now(),
		};
		state.releases.push(release);
		return json({ release });
	}
	const publishPath = path.match(/^\/admin\/changelog\/([^/]+)\/publish$/u);
	if (method === "POST" && publishPath) {
		const release = state.releases.find(
			(item) => item.id === decodeURIComponent(publishPath[1] ?? "")
		);
		if (!release) {
			return errorResponse(404, "not_found", "Release draft not found.");
		}
		Object.assign(release, {
			body: ReleasePublishSchema.parse(body).body ?? release.body,
			status: "published",
			published_at: Date.now(),
			updated_at: Date.now(),
		});
		return json({ release });
	}
	return errorResponse(
		404,
		"not_found",
		`No fixture route for ${method} ${path}`
	);
}

function safePublicRequests() {
	return [...state.requests.values()]
		.filter(
			(item) => item.public_visible && item.moderation_state === "approved"
		)
		.sort((left, right) => right.created_at - left.created_at)
		.map(publicRequest);
}

async function handlePublic(request: Request, url: URL) {
	const match = url.pathname.match(/^\/feedback\/([^/]+)(?:\/(.*))?$/u);
	if (!match) {
		return errorResponse(404, "not_found", "Board not found.");
	}
	const slug = decodeURIComponent(match[1] ?? "");
	if (slug !== state.board.slug) {
		return errorResponse(404, "not_found", "Board not found.");
	}
	const suffix = match[2] ?? "";
	if (!suffix && request.method === "GET") {
		return new Response(await Bun.file(publicHtmlPath).text(), {
			headers: { "content-type": "text/html" },
		});
	}
	const path = `/feedback/${slug}/${suffix}`;
	const method = request.method;
	const body =
		method === "GET" || method === "HEAD"
			? undefined
			: await requestBody(request);
	recordCall("public-api", method, path, body, {
		voter: request.headers.get("x-feedback-voter"),
	});
	const failure = consumeFailure(method, path);
	if (failure) {
		return errorResponse(
			failure.status,
			"fixture_failure",
			"The public fixture rejected that action."
		);
	}
	if (suffix === "requests" && method === "GET") {
		return json({ board: publicBoard(), requests: safePublicRequests() });
	}
	const requestMatch = suffix.match(
		/^requests\/([^/]+)(?:\/(vote|comments))?$/u
	);
	if (requestMatch) {
		const id = decodeURIComponent(requestMatch[1] ?? "");
		const requestRecord = state.requests.get(id);
		if (
			requestRecord?.public_visible !== true ||
			requestRecord?.moderation_state !== "approved"
		) {
			return errorResponse(404, "not_found", "Public request not found.");
		}
		const action = requestMatch[2] ?? "";
		if (!action && method === "GET") {
			return json({
				request: publicRequest(requestRecord),
				comments: (state.comments.get(id) ?? [])
					.filter((comment) => comment.moderation_state === "approved")
					.map(({ author_name, body, created_at, id: commentId }) => ({
						author_name,
						body,
						created_at,
						id: commentId,
					})),
			});
		}
		if (action === "vote" && method === "POST") {
			const voter = request.headers.get("x-feedback-voter") || "anonymous";
			const voters = state.votes.get(id) ?? new Set<string>();
			const voted = !voters.has(voter);
			if (voted) {
				voters.add(voter);
			}
			state.votes.set(id, voters);
			requestRecord.vote_count = 3 + voters.size;
			requestRecord.updated_at = Date.now();
			return json({ voted, vote_count: requestRecord.vote_count });
		}
		if (action === "comments" && method === "POST") {
			const input = PublicCommentBodySchema.parse(body);
			if (!input.body?.trim()) {
				return errorResponse(400, "invalid_request", "Comment is required.");
			}
			const comment = {
				author_name: input.author_name?.trim() || "Anonymous",
				body: input.body.trim(),
				created_at: Date.now(),
				id: `comment-${(state.comments.get(id) ?? []).length + 1}`,
				moderation_state: state.board.moderate_public_writes
					? "pending"
					: "approved",
				request_id: id,
				visibility: "public",
			};
			const comments = state.comments.get(id) ?? [];
			comments.push(comment);
			state.comments.set(id, comments);
			if (comment.moderation_state === "approved") {
				requestRecord.comment_count += 1;
			}
			return json({
				comment: {
					author_name: comment.author_name,
					body: comment.body,
					created_at: comment.created_at,
					id: comment.id,
				},
				pendingReview: comment.moderation_state === "pending",
			});
		}
	}
	if (suffix === "requests" && method === "POST") {
		const input = PublicRequestBodySchema.parse(body);
		if (!(input.title?.trim() && input.body?.trim())) {
			return errorResponse(
				400,
				"invalid_request",
				"A title and description are required."
			);
		}
		if (!state.board.allow_guest_posts) {
			return errorResponse(
				403,
				"guest_posts_disabled",
				"Guest submissions are disabled."
			);
		}
		const pending = state.board.moderate_public_writes === true;
		const id = `req-${state.requests.size + 1}`;
		const created: RequestRecord = {
			ai_summary: null,
			author_email: input.email ?? null,
			author_name: input.author_name?.trim() || "Anonymous",
			automation_mode: null,
			board_id: state.board.id,
			body: input.body.trim(),
			category: input.category ?? "Ideas",
			comment_count: 0,
			created_at: Date.now(),
			duplicate_confidence: null,
			duplicate_of: null,
			id,
			impact_score: null,
			internal_notes: "",
			moderation_state: pending ? "pending" : "approved",
			plan_id: null,
			priority: 0,
			public_visible: !pending,
			revision: 1,
			shipped_at: null,
			space_doc_id: null,
			status: "new",
			tags: [],
			title: input.title.trim(),
			updated_at: Date.now(),
			vote_count: 0,
			workflow_run_id: null,
		};
		state.requests.set(id, created);
		return json({ request: publicRequest(created), pendingReview: pending });
	}
	if (suffix === "roadmap" && method === "GET") {
		const requests = safePublicRequests();
		const statuses = state.board.statuses;
		return json({
			board: publicBoard(),
			columns: statuses.map((status) => ({
				...status,
				requests: requests.filter((item) => item.status.code === status.code),
			})),
		});
	}
	if (suffix === "changelog" && method === "GET") {
		return json({
			board: publicBoard(),
			releases: state.releases.filter(
				(release) => release.status === "published"
			),
		});
	}
	return errorResponse(
		404,
		"not_found",
		`No public fixture route for ${method} ${path}`
	);
}

await buildSurface("admin");
await buildSurface("public");
const adminBridge = `<script>window.ryu={context:{view:new URLSearchParams(location.search).get('view')||'requests'},app:{request:async(input)=>{const response=await fetch('/__admin'+input.path,{method:input.method||'GET',headers:{'content-type':'application/json'},...(input.body===undefined?{}:{body:JSON.stringify(input.body)})});const result=await response.json();if(!response.ok)throw new Error(result.error?.message||'Feedback Board request failed.');return result;}},model:{complete:async(input)=>{const response=await fetch('/__fixture/bridge/model',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});return (await response.json()).result;}},spaces:{ensureSpace:async(input)=>{const response=await fetch('/__fixture/bridge/spaces/ensure',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});return (await response.json()).space_id;},createDoc:async(input)=>{const response=await fetch('/__fixture/bridge/spaces/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});return (await response.json()).id;},updateDoc:async(input)=>{await fetch('/__fixture/bridge/spaces/update',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});},getDoc:async(input)=>{const response=await fetch('/__fixture/bridge/spaces/get',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});return (await response.json()).doc;}},workflows:{save:async(input)=>{const response=await fetch('/__fixture/bridge/workflows/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});return await response.json();},run:async(input)=>{const response=await fetch('/__fixture/bridge/workflows/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});return await response.json();},resume:async(input)=>{const response=await fetch('/__fixture/bridge/workflows/resume',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});return await response.json();}}};</script>`;
const adminHtml = (await Bun.file(adminHtmlPath).text()).replace(
	"<head>",
	`<head>${adminBridge}`
);
const publicHtml = await Bun.file(publicHtmlPath).text();
const server = Bun.serve({
	hostname: "127.0.0.1",
	port,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__ready") {
			return new Response("ok");
		}
		if (url.pathname === "/__fixture/reset" && request.method === "POST") {
			const input = ResetBodySchema.parse(await requestBody(request));
			state = seedState(input.emptyBoard === true);
			return json({ reset: true });
		}
		if (url.pathname === "/__fixture/state") {
			return json({
				board: state.board,
				calls: state.calls,
				comments: [...state.comments.entries()],
				docs: [...state.docs.entries()],
				failNext: state.failNext,
				releases: state.releases,
				requests: [...state.requests.values()],
				votes: [...state.votes.entries()].map(([id, voters]) => [
					id,
					[...voters],
				]),
				workflowDefinitions: [...state.workflowDefinitions.entries()],
				workflowInputs: state.workflowInputs,
				workspace: state.workspace,
			});
		}
		if (url.pathname === "/__fixture/fail-next" && request.method === "POST") {
			const input = FailureBodySchema.parse(await requestBody(request));
			state.failNext = {
				method: input.method,
				path: input.path,
				status: input.status ?? 503,
			};
			return json({ armed: true });
		}
		if (
			url.pathname === "/__fixture/bridge/model" &&
			request.method === "POST"
		) {
			const input = await requestBody(request);
			recordCall("model-bridge", "POST", url.pathname, input);
			return json({
				result: JSON.stringify({
					summary: "Export helps teams report demand.",
					tags: ["reporting", "exports"],
					category: "Ideas",
					impact_score: 84,
					duplicate_request_ids: ["req-dark-mode"],
					confidence: 91,
				}),
			});
		}
		if (
			url.pathname.startsWith("/__fixture/bridge/spaces/") &&
			request.method === "POST"
		) {
			const input = await requestBody(request);
			recordCall("spaces-bridge", "POST", url.pathname, input);
			if (url.pathname.endsWith("/ensure")) {
				return json({ space_id: "space-feedback" });
			}
			if (url.pathname.endsWith("/create")) {
				const id = `doc-${state.docs.size + 1}`;
				state.docs.set(id, { title: String(input.title ?? ""), source: "" });
				return json({ id });
			}
			if (url.pathname.endsWith("/update")) {
				const id = String(input.doc_id ?? "");
				state.docs.set(id, {
					title: String(input.title ?? ""),
					source: String(input.source ?? ""),
				});
				return json({ updated: true });
			}
			const doc = state.docs.get(String(input.doc_id ?? ""));
			return json({ doc: doc ? { id: input.doc_id, ...doc } : null });
		}
		if (
			url.pathname.startsWith("/__fixture/bridge/workflows/") &&
			request.method === "POST"
		) {
			const input = await requestBody(request);
			recordCall("workflows-bridge", "POST", url.pathname, input);
			if (url.pathname.endsWith("/save")) {
				const id = String(
					input.id ?? `workflow-${state.workflowDefinitions.size + 1}`
				);
				state.workflowDefinitions.set(id, input);
				return json({ id });
			}
			if (url.pathname.endsWith("/run")) {
				const runId = `workflow-run-${state.workflowInputs.length + 1}`;
				state.workflowInputs.push({ ...input, runId });
				return json({ runId });
			}
			return json({ status: "completed" });
		}
		if (url.pathname.startsWith("/__admin/")) {
			return handleAdmin(request, url);
		}
		if (url.pathname.startsWith("/feedback/")) {
			if (url.pathname === "/feedback/demo") {
				return new Response(publicHtml, {
					headers: { "content-type": "text/html" },
				});
			}
			return handlePublic(request, url);
		}
		return new Response(adminHtml, {
			headers: { "content-type": "text/html" },
		});
	},
});
let stopping = false;
async function stop() {
	if (stopping) {
		return;
	}
	stopping = true;
	server.stop();
	await rm(proofBuildDirectory, { force: true, recursive: true });
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
