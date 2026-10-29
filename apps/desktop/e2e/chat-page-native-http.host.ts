import { createHash } from "node:crypto";
import {
	canonicalPath,
	createBackgroundContracts,
} from "./chat-page-native-http-background.ts";
import { CONTEXT_PANEL_BREAKDOWN } from "./chat-page-native-http-context.ts";
import { createLiveChatFixture } from "./chat-page-native-http-live-chat.ts";
import { createPlanDocumentsFixture } from "./chat-page-native-http-plans.ts";
import {
	createReactionHttpFixture,
	REACTION_ACTION,
} from "./chat-page-native-http-reactions.ts";
import {
	CONVERSATION_ID,
	createChatPageProofDtos,
	GHOST_CHATS_FEATURE,
	OWNER_ID,
	SAVED_SIDE_CHATS,
	SIDE_CHATS_FEATURE,
	TASK_SUGGESTION_SCENARIOS,
	TASK_SUGGESTION_WITH_DRAFTS,
} from "./chat-page-native-http-state.ts";
import { createTransportDiagnostics } from "./chat-page-native-http-transport.ts";

// Held acknowledgments and idle SSE end only through owned release/abort/teardown.
export const CHAT_PAGE_NATIVE_HTTP_SERVER_OPTIONS = {
	hostname: "127.0.0.1",
	idleTimeout: 0,
} as const;
type NodeId = "a" | "b";
export interface Call {
	authorization: string | null;
	body: unknown;
	// Set on a held request when the browser abandons it before release.
	clientAborted?: boolean;
	contentType: string | null;
	id: number;
	method: string;
	node: NodeId | "backend";
	origin: string | null;
	path: string;
	rawBody: string | null;
	responseStatus?: number;
	rotationDeniedAtMs?: number;
	rotationWindowId?: number;
	status: "pending" | "accepted" | "refused";
	transitionRefusal?:
		| "retired-background-authority"
		| "bounded-authority-rotation";
	url: string;
	userJwt: string | null;
}
interface Rule {
	body?: unknown;
	message?: string;
	method: string;
	node: NodeId;
	path: string;
	status?: number;
}
export function createChatPageNativeHttpFixture(browserOrigin: string) {
	const transport = createTransportDiagnostics();
	let dtos = createChatPageProofDtos("share");
	let scenario = "share";
	let contextBreakdown: typeof CONTEXT_PANEL_BREAKDOWN | null = null;
	const planDocuments = createPlanDocumentsFixture();
	let nextId = 0;
	const calls: Call[] = [];
	const unexpected: Array<{ reason: string; call: Call }> = [];
	const holds: Rule[] = [];
	const refusals: Rule[] = [];
	const held = new Map<number, (accept: boolean) => void>();
	const authority = {
		a: {
			token: "chat-page-native-node-a-token",
			userJwt: null as string | null,
		},
		b: {
			token: "chat-page-native-node-b-token",
			userJwt: null as string | null,
		},
	};
	const rotationWindows: Array<{
		id: number;
		node: NodeId;
		authorization: string;
		userJwt: string | null;
		startedAtMs: number;
		deadlineAtMs: number;
		endedAtMs: number | null;
	}> = [];
	const retiredAuthority = { a: new Set<string>(), b: new Set<string>() };
	const credentialTuple = (token: string, userJwt: string | null) =>
		JSON.stringify([`Bearer ${token}`, userJwt]);
	const access = {
		can_manage: true,
		collaborators: [],
		owner_user_id: OWNER_ID,
		team_id: null,
		visibility: "private",
	};
	const modelSelections = new Map<
		string,
		{
			changes: Record<string, unknown>[];
			current: Record<string, unknown> | null;
		}
	>();
	const histories = new Map<string, unknown[]>();
	// Next-prompt suggestions Core returns for one node and conversation.
	const suggestions = new Map<string, string[]>();
	const uploads: Array<{ filename: string; size: number; type: string }> = [];
	// The Drafts app's rows, for the `task-suggestion` scenario's Save to Drafts.
	const drafts: Record<string, unknown>[] = [];
	const reversedEdits: unknown[] = [];
	type IdleCloseCause =
		| "request-abort"
		| "consumer-cancel"
		| "scenario-reset"
		| "fixture-teardown";
	const idleStreams = new Set<(cause: IdleCloseCause) => void>();
	let idleSequence = 0;
	let scenarioGeneration = 0;
	const idleLifecycle: Array<{
		id: number;
		node: NodeId | "backend";
		endpoint: string;
		authorityFingerprint: string;
		scenarioGeneration: number;
		bornAtMs: number;
		bornSignalAborted: boolean;
		signal: AbortSignal;
		closedAtMs: number | null;
		closeCause: IdleCloseCause | null;
	}> = [];
	const preferences = new Map<string, string>();
	const projects = new Map<string, Record<string, unknown>>();
	const background = createBackgroundContracts(CONVERSATION_ID, OWNER_ID);
	const liveChats = createLiveChatFixture(browserOrigin);
	const reactions = createReactionHttpFixture(CONVERSATION_ID);
	function idleStream(
		request: Request,
		initial: string,
		node: NodeId | "backend"
	) {
		const url = new URL(request.url);
		const diagnostic: (typeof idleLifecycle)[number] = {
			id: ++idleSequence,
			node,
			endpoint: url.pathname + url.search,
			authorityFingerprint: createHash("sha256")
				.update(
					JSON.stringify([
						request.headers.get("authorization"),
						request.headers.get("x-ryu-user-jwt"),
					])
				)
				.digest("hex"),
			scenarioGeneration,
			bornAtMs: Date.now(),
			bornSignalAborted: request.signal.aborted,
			signal: request.signal,
			closedAtMs: null,
			closeCause: null,
		};
		idleLifecycle.push(diagnostic);
		let stop = (_cause: IdleCloseCause) => {};
		const onRequestAbort = () => stop("request-abort");
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				let closed = false;
				stop = (cause) => {
					if (closed) {
						return;
					}
					closed = true;
					diagnostic.closedAtMs = Date.now();
					diagnostic.closeCause = cause;
					idleStreams.delete(stop);
					request.signal.removeEventListener("abort", onRequestAbort);
					try {
						controller.close();
					} catch {}
				};
				idleStreams.add(stop);
				request.signal.addEventListener("abort", onRequestAbort, {
					once: true,
				});
				controller.enqueue(
					new TextEncoder().encode(initial || ": owned idle stream\n\n")
				);
				if (request.signal.aborted) {
					stop("request-abort");
				}
			},
			cancel() {
				stop("consumer-cancel");
			},
		});
		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
				"x-accel-buffering": "no",
				"access-control-allow-origin": browserOrigin,
				"access-control-allow-credentials": "true",
				vary: "Origin",
			},
		});
	}
	const key = (node: NodeId, id: string) => `${node}:${id}`;
	const response = (
		body: unknown,
		status = 200,
		extraHeaders: Record<string, string> = {}
	) =>
		Response.json(body, {
			status,
			headers: {
				"access-control-allow-origin": browserOrigin,
				"access-control-allow-credentials": "true",
				vary: "Origin",
				...extraHeaders,
			},
		});
	const match = (rule: Rule, call: Call) =>
		rule.node === call.node &&
		rule.method === call.method &&
		rule.path === new URL(call.url).pathname;
	const consume = (rules: Rule[], call: Call) => {
		const index = rules.findIndex((rule) => match(rule, call));
		return index < 0 ? undefined : rules.splice(index, 1)[0];
	};
	function reset(nextScenario: string) {
		scenarioGeneration++;
		planDocuments.reset();
		liveChats.reset();
		reactions.reset();
		for (const stop of [...idleStreams]) {
			stop("scenario-reset");
		}
		preferences.clear();
		rotationWindows.length = 0;
		retiredAuthority.a.clear();
		retiredAuthority.b.clear();
		projects.clear();
		for (const resolve of held.values()) {
			resolve(false);
		}
		held.clear();
		holds.length =
			refusals.length =
			calls.length =
			unexpected.length =
			uploads.length =
			drafts.length =
			reversedEdits.length =
				0;
		scenario = nextScenario;
		contextBreakdown =
			scenario === "context-breakdown-caller"
				? structuredClone(CONTEXT_PANEL_BREAKDOWN)
				: null;
		dtos = createChatPageProofDtos(scenario);
		// The finite host exposes only conversations declared by this scenario.
		// Use the same exact idle dependency contracts for each of those records;
		// a new summary must not manufacture unknown-room failures in the real UI.
		background.core.clear();
		background.backend.clear();
		for (const summary of dtos.conversationSummaries) {
			const declared = createBackgroundContracts(summary.id, OWNER_ID);
			for (const [route, contract] of declared.core) {
				background.core.set(route, contract);
			}
			for (const [route, contract] of declared.backend) {
				background.backend.set(route, contract);
			}
		}
		nextId = 0;
		modelSelections.clear();
		histories.clear();
		suggestions.clear();
		Object.assign(access, {
			can_manage: true,
			collaborators: [],
			owner_user_id: OWNER_ID,
			team_id: null,
			visibility: "private",
		});
		for (const node of ["a", "b"] as const) {
			authority[node] = {
				token: `chat-page-native-node-${node}-token`,
				userJwt: null,
			};
			for (const summary of dtos.conversationSummaries) {
				histories.set(
					key(node, summary.id),
					summary.id === "conversation-earlier-thread-fixture"
						? dtos.earlierThreadMessages
						: summary.id === "conversation-latest-thread-fixture"
							? dtos.latestThreadMessages
							: dtos.messageRows
				);
			}
		}
	}
	reset("share");
	const snapshot = () => ({
		transport: transport.snapshot(),
		planDocuments: planDocuments.snapshot(),
		liveChats: liveChats.snapshot(),
		reactions: reactions.snapshot(),
		scenario,
		idleStreamCount: idleStreams.size,
		idleStreamLifecycle: idleLifecycle.map(({ signal, ...entry }) => ({
			...entry,
			signalAborted: signal.aborted,
		})),
		currentIdleStreams: idleLifecycle
			.filter((entry) => entry.closedAtMs === null)
			.map(({ signal, ...entry }) => ({
				...entry,
				signalAborted: signal.aborted,
			})),
		preferences: Object.fromEntries(preferences),
		projects: Object.fromEntries(projects),
		calls,
		transitionRefusals: calls.filter((call) => call.transitionRefusal),
		rotationWindows,
		unexpected,
		uploads,
		drafts,
		access,
		reversedEdits,
		heldRequestIds: [...held.keys()],
		modelSelections: Object.fromEntries(modelSelections),
		contextBreakdown,
		histories: Object.fromEntries(histories),
		authority,
	});
	async function control(request: Request) {
		if (
			request.headers.get("x-chat-page-proof-control") !== "owned-local-fixture"
		) {
			return response({ error: "Fixture control credential required" }, 403);
		}
		if (request.method !== "POST") {
			return response({ error: "Fixture control requires POST" }, 405);
		}
		const command = (await request.json()) as Record<string, unknown>;
		if (command.action === "reset" && typeof command.scenario === "string") {
			reset(command.scenario);
			return response({ ok: true });
		}
		if (
			["arm_live_chat", "arm_reasoning_chat"].includes(
				String(command.action)
			) &&
			(command.node === "a" || command.node === "b") &&
			typeof command.conversationId === "string"
		) {
			if (
				!dtos.conversationSummaries.some(
					(summary) => summary.id === command.conversationId
				)
			) {
				return response({ error: "Unknown fixture conversation" }, 409);
			}
			if (command.action === "arm_reasoning_chat") {
				liveChats.armReasoning(
					command.node,
					command.conversationId,
					"chat-page-owned-reasoning-turn"
				);
			} else {
				liveChats.arm(command.node, command.conversationId, {
					suggestTask: command.suggestTask === true,
				});
			}
			return response({ ok: true });
		}
		if (
			command.action === "arm_resumed_turn" &&
			(command.node === "a" || command.node === "b") &&
			typeof command.conversationId === "string"
		) {
			// Core runs a turn the tab did not start (another client, a queued run).
			// Only a conversation the scenario declares has a resume route to serve it.
			if (
				!dtos.conversationSummaries.some(
					(summary) => summary.id === command.conversationId
				)
			) {
				return response({ error: "Unknown fixture conversation" }, 409);
			}
			liveChats.armResume(command.node, command.conversationId, {
				suggestTask: command.suggestTask === true,
			});
			return response({ ok: true });
		}
		if (
			command.action === "arm_next_live_chat" &&
			(command.node === "a" || command.node === "b")
		) {
			// Only a scenario that starts chats under ids the browser mints can arm a
			// turn it cannot name.
			if (
				!(TASK_SUGGESTION_SCENARIOS as readonly string[]).includes(scenario)
			) {
				return response({ error: "This scenario mints no chat ids" }, 409);
			}
			liveChats.armNext(command.node, {
				suggestTask: command.suggestTask === true,
			});
			return response({ ok: true });
		}
		if (
			command.action === "finish_reasoning_answer" &&
			(command.node === "a" || command.node === "b") &&
			command.conversationId === CONVERSATION_ID &&
			command.turnId === "chat-page-owned-reasoning-turn"
		) {
			return response({
				finished: liveChats.finishAnswer(
					command.node,
					command.conversationId,
					command.turnId
				),
			});
		}
		if (
			command.action === "finish_live_chat" &&
			(command.node === "a" || command.node === "b") &&
			typeof command.conversationId === "string"
		) {
			if (
				!(
					dtos.conversationSummaries.some(
						(summary) => summary.id === command.conversationId
					) || liveChats.started(command.node, command.conversationId)
				)
			) {
				return response({ error: "Unknown fixture conversation" }, 409);
			}
			return response({
				finished: liveChats.finish(command.node, command.conversationId),
			});
		}
		if (
			command.action === "release" &&
			typeof command.requestId === "number" &&
			typeof command.accept === "boolean"
		) {
			const release = held.get(command.requestId);
			if (!release) {
				return response({ error: "No matching held request" }, 409);
			}
			held.delete(command.requestId);
			release(command.accept);
			return response({ ok: true });
		}
		if (
			command.action === "set_suggestions" &&
			(command.node === "a" || command.node === "b") &&
			typeof command.conversationId === "string" &&
			Array.isArray(command.suggestions) &&
			command.suggestions.every((item) => typeof item === "string")
		) {
			if (
				!dtos.conversationSummaries.some(
					(summary) => summary.id === command.conversationId
				)
			) {
				return response({ error: "Unknown fixture conversation" }, 409);
			}
			suggestions.set(
				key(command.node, command.conversationId),
				command.suggestions as string[]
			);
			return response({ ok: true });
		}
		// Core reports the gateway in its merged status snapshot; the shipping
		// status poll reads it on its next tick.
		if (
			command.action === "set_gateway_reachable" &&
			typeof command.reachable === "boolean"
		) {
			const route = "GET /api/system/status";
			const contract = background.core.get(route);
			if (!contract) {
				return response({ error: "No system status contract" }, 409);
			}
			background.core.set(route, {
				...contract,
				body: {
					...(contract.body as Record<string, unknown>),
					gateway: { reachable: command.reachable },
				},
			});
			return response({ ok: true });
		}
		if (
			command.action === "seed_conversation" &&
			(command.node === "a" || command.node === "b") &&
			typeof command.conversationId === "string" &&
			Array.isArray(command.messages)
		) {
			if (
				!dtos.conversationSummaries.some(
					(summary) => summary.id === command.conversationId
				)
			) {
				return response({ error: "Unknown fixture conversation" }, 409);
			}
			histories.set(
				key(command.node, command.conversationId),
				command.messages
			);
			return response({ ok: true });
		}
		if (
			(command.action === "begin_authority_rotation" ||
				command.action === "end_authority_rotation") &&
			(command.node === "a" || command.node === "b")
		) {
			const current = rotationWindows.find(
				(window) => window.node === command.node && window.endedAtMs === null
			);
			if (command.action === "begin_authority_rotation") {
				if (current) {
					return response({ error: "Rotation already open" }, 409);
				}
				const startedAtMs = Date.now();
				rotationWindows.push({
					id: rotationWindows.length + 1,
					node: command.node,
					authorization: `Bearer ${authority[command.node].token}`,
					userJwt: authority[command.node].userJwt,
					startedAtMs,
					deadlineAtMs: startedAtMs + 2000,
					endedAtMs: null,
				});
				return response({ ok: true });
			}
			if (!current) {
				return response({ error: "No open rotation" }, 409);
			}
			current.endedAtMs = Date.now();
			return response({
				window: current,
				denials: calls.filter((call) => call.rotationWindowId === current.id),
			});
		}
		if (
			command.action === "set_node_authority" &&
			(command.node === "a" || command.node === "b") &&
			typeof command.token === "string" &&
			(command.userJwt === null || typeof command.userJwt === "string")
		) {
			retiredAuthority[command.node].add(
				credentialTuple(
					authority[command.node].token,
					authority[command.node].userJwt
				)
			);
			authority[command.node] = {
				token: command.token,
				userJwt: command.userJwt,
			};
			return response({ ok: true });
		}
		if (
			(command.action === "hold_next" || command.action === "refuse_next") &&
			(command.node === "a" || command.node === "b") &&
			typeof command.path === "string" &&
			["GET", "PUT", "POST", "DELETE"].includes(String(command.method))
		) {
			const rule: Rule = {
				node: command.node,
				method: String(command.method),
				path: command.path,
				status: typeof command.status === "number" ? command.status : 503,
				message:
					typeof command.message === "string"
						? command.message
						: "Owned HTTP fixture refused this request",
				body: command.body,
			};
			(command.action === "hold_next" ? holds : refusals).push(rule);
			return response({ ok: true });
		}
		return response(
			{ error: "Unknown or malformed finite fixture control" },
			409
		);
	}
	async function fetch(
		request: Request,
		node: NodeId | "backend",
		server?: Bun.Server<undefined>
	) {
		if (!new URL(request.url).pathname.startsWith("/__")) {
			transport.record(request, node, server);
		}
		const url = new URL(request.url);
		if (url.pathname === "/__ready" && request.method === "GET") {
			return response({ ok: true });
		}
		if (url.pathname === "/__proof/state" && request.method === "GET") {
			return response(snapshot());
		}
		if (url.pathname === "/__proof/control") {
			return control(request);
		}
		const origin = request.headers.get("origin");
		if (request.method === "OPTIONS") {
			if (origin !== browserOrigin) {
				return response({ error: "Unexpected preflight origin" }, 403);
			}
			return new Response(null, {
				status: 204,
				headers: {
					"access-control-allow-origin": browserOrigin,
					"access-control-allow-credentials": "true",
					"access-control-allow-methods": "GET,POST,PUT,DELETE",
					"access-control-allow-headers":
						request.headers.get("access-control-request-headers") ??
						"authorization,content-type,x-ryu-user-jwt",
					vary: "Origin",
				},
			});
		}
		const rawBody = request.body === null ? null : await request.clone().text();
		let body: unknown = rawBody;
		if (rawBody && request.headers.get("content-type")?.includes("json")) {
			try {
				body = JSON.parse(rawBody);
			} catch {
				/* malformed data is retained and refused below */
			}
		}
		const call: Call = {
			id: ++nextId,
			node,
			origin,
			url: request.url,
			method: request.method,
			path: url.pathname + url.search,
			authorization: request.headers.get("authorization"),
			userJwt: request.headers.get("x-ryu-user-jwt"),
			contentType: request.headers.get("content-type"),
			rawBody,
			body,
			status: "pending",
		};
		calls.push(call);
		const fail = (reason: string, status = 503) => {
			call.status = "refused";
			call.responseStatus = status;
			unexpected.push({ reason, call });
			return response({ error: reason }, status);
		};
		if (origin !== browserOrigin) {
			return fail("Unexpected browser origin", 403);
		}
		if (
			node !== "backend" &&
			!(
				request.method === "GET" &&
				url.pathname === "/api/health" &&
				!url.search
			) &&
			(call.authorization !== `Bearer ${authority[node].token}` ||
				call.userJwt !== authority[node].userJwt)
		) {
			const deniedAtMs = Date.now();
			const rotation = rotationWindows.find(
				(window) =>
					window.node === node &&
					window.endedAtMs === null &&
					deniedAtMs <= window.deadlineAtMs &&
					call.authorization === window.authorization &&
					call.userJwt === window.userJwt
			);
			if (
				rotation &&
				request.method === "GET" &&
				canonicalPath(url) === "/api/background/processes?running_only=true" &&
				body === null &&
				call.rawBody === null
			) {
				call.status = "refused";
				call.responseStatus = 403;
				call.transitionRefusal = "bounded-authority-rotation";
				call.rotationWindowId = rotation.id;
				call.rotationDeniedAtMs = deniedAtMs;
				return response({ error: "Wrong node authority" }, 403);
			}
			const retired = retiredAuthority[node].has(
				JSON.stringify([call.authorization, call.userJwt])
			);
			const contextWindow =
				request.method === "GET" &&
				["auto", "model-proof-a", "model-proof-b"].some(
					(model) =>
						canonicalPath(url) === `/api/models/context-window?model=${model}`
				);
			const ticketInput = body as Record<string, unknown> | null;
			const ticket =
				request.method === "POST" &&
				url.pathname === "/api/ws/ticket" &&
				!url.search &&
				ticketInput !== null &&
				typeof ticketInput === "object" &&
				Object.keys(ticketInput).length === 3 &&
				ticketInput.kind === "conversation" &&
				ticketInput.route === "realtime" &&
				[CONVERSATION_ID, "system:plugins"].includes(
					String(ticketInput.roomId)
				);
			if (retired && (contextWindow || ticket)) {
				call.status = "refused";
				call.responseStatus = 403;
				call.transitionRefusal = "retired-background-authority";
				return response({ error: "Wrong node authority" }, 403);
			}
			return fail("Wrong node authority", 403);
		}
		if (
			node === "backend" &&
			call.authorization !== "Bearer share-toolbar-fixture-token"
		) {
			return fail("Wrong account authority", 403);
		}
		const id =
			/^\/api\/conversations\/([^/]+)(?:\/(model-selection|access|history-preview|title-history|fork))?$/.exec(
				url.pathname
			);
		const knownConversation =
			id &&
			(dtos.conversationSummaries.some(
				(summary) => summary.id === decodeURIComponent(id[1])
			) ||
				id[1] === "conversation-forked-fixture");
		// Core answers worktree status for every conversation the sidebar lists,
		// not only the scenario's first conversation.
		const worktreeStatusRoute =
			node !== "backend" &&
			request.method === "GET" &&
			!url.search &&
			dtos.conversationSummaries.some(
				(summary) =>
					url.pathname ===
					`/api/worktree/${encodeURIComponent(summary.id)}/status`
			);
		const contextRoute =
			node !== "backend" &&
			request.method === "GET" &&
			dtos.conversationSummaries.some(
				(summary) => url.pathname === `/api/conversations/${summary.id}/context`
			) &&
			!url.search;
		// Core's `get_agent_ui_state_handler` answers every listed conversation;
		// no fixture transcript renders a `ui.render` widget, so none has state.
		const uiStateRoute =
			node !== "backend" &&
			request.method === "GET" &&
			!url.search &&
			dtos.conversationSummaries.some(
				(summary) =>
					url.pathname ===
					`/api/conversations/${encodeURIComponent(summary.id)}/ui-state`
			);
		// Core lists a conversation's saved side chats for the sidebar once the
		// Side Chats plugin is enabled.
		const sideChatListMatch =
			scenario === "side-chat-sidebar" &&
			node !== "backend" &&
			request.method === "GET" &&
			!url.search
				? /^\/api\/conversations\/([^/]+)\/btw$/.exec(url.pathname)
				: null;
		const sideChatListRoute = Boolean(
			sideChatListMatch &&
				dtos.conversationSummaries.some(
					(summary) => summary.id === decodeURIComponent(sideChatListMatch[1])
				)
		);
		const readRoutes = new Set([
			"/api/conversations",
			"/api/plugins/contributions",
			"/api/ext/com.ryu.test-tools/current-run",
			"/api/agents/agent-fixture",
			"/api/agents",
			"/api/agents/agent-fixture/acp-config",
			"/api/acl/principals",
			"/api/workspace/list",
			"/api/git/status",
			"/api/background/processes",
			`/api/worktree/${CONVERSATION_ID}/status`,
			"/api/engines",
			"/api/engines/models",
		]);
		const writeRoutes = new Map([
			["/api/plugins/com.ryu.test-tools/host", "POST"],
			["/api/uploads", "POST"],
			["/api/chat/stream", "POST"],
			["/api/chat/cancel", "POST"],
			["/api/chat/control", "POST"],
			["/api/git/reverse-edits", "POST"],
			["/api/git/file-diff", "POST"],
		]);
		const planRoute =
			scenario === "plan-persistence" &&
			node !== "backend" &&
			!url.search &&
			planDocuments.matches(request.method, url.pathname);
		const backgroundContract = planRoute
			? undefined
			: (node === "backend" ? background.backend : background.core).get(
					`${request.method} ${canonicalPath(url)}`
				);
		const preferenceKey = [
			"support-access-local-enabled",
			"support-access-local-expiry",
			"voice-input",
			"default-local-agent-selection",
			"default-agent-selection",
			"managed-inference-entitled",
			"voice-mode-readback",
			"default-cloud-agent-selection",
			"editor-ai",
			"keybindings",
			"entitlement-active",
		].find(
			(key) =>
				url.pathname === `/api/preferences/${key}` &&
				!url.search &&
				request.method === "GET"
		);
		const entitlementWrite =
			[
				"/api/preferences/entitlement-active",
				"/api/preferences/managed-inference-entitled",
			].includes(url.pathname) &&
			!url.search &&
			request.method === "PUT" &&
			node !== "backend";
		const presenceWrite =
			url.pathname === "/api/presence" &&
			!url.search &&
			request.method === "PUT" &&
			node !== "backend";
		const legacyAllowed =
			node === "backend"
				? request.method === "GET" &&
					(url.pathname === "/api/auth/token" ||
						url.pathname ===
							`/api/conversation-shares/conversation/${CONVERSATION_ID}`)
				: (request.method === "GET" &&
						(readRoutes.has(url.pathname) ||
							Boolean(knownConversation && id?.[2] !== "fork") ||
							[
								"/api/plugins/%40ryu%2Fdrawesome/ui-bundle",
								"/api/plugins/com.ryu.test-tools/ui-bundle",
							].includes(url.pathname))) ||
					writeRoutes.get(url.pathname) === request.method ||
					Boolean(
						knownConversation &&
							((request.method === "PUT" &&
								["model-selection", "access"].includes(id?.[2] ?? "")) ||
								(request.method === "POST" && id?.[2] === "fork"))
					);
		const projectRoute =
			node !== "backend" &&
			!url.search &&
			((url.pathname === "/api/projects/projects" &&
				["GET", "POST"].includes(request.method)) ||
				(url.pathname ===
					"/api/projects/projects/chat-page-owned-project/main-thread" &&
					request.method === "POST") ||
				(url.pathname === "/api/hierarchy/memory/rekey-project" &&
					request.method === "POST"));
		const reactionRoute =
			node !== "backend" &&
			scenario === "message-reactions-caller" &&
			!url.search &&
			reactions.matches(request.method, url.pathname);
		// The Drafts app's sidecar, mounted by Core at `/api/drafts`. Only the
		// `task-suggestion` scenario enables the app, so every other scenario still
		// refuses these paths.
		const draftsRoute =
			node !== "backend" &&
			(TASK_SUGGESTION_WITH_DRAFTS as readonly string[]).includes(scenario) &&
			!url.search &&
			((request.method === "GET" &&
				(url.pathname === "/api/drafts/list" ||
					url.pathname === "/api/drafts/settings" ||
					/^\/api\/drafts\/drafts\/[^/]+$/.test(url.pathname))) ||
				(request.method === "POST" && url.pathname === "/api/drafts/drafts"));
		const allowed =
			draftsRoute ||
			worktreeStatusRoute ||
			sideChatListRoute ||
			contextRoute ||
			uiStateRoute ||
			planRoute ||
			reactionRoute ||
			projectRoute ||
			backgroundContract ||
			(node !== "backend" && preferenceKey) ||
			entitlementWrite ||
			presenceWrite ||
			legacyAllowed;
		if (!allowed) {
			return fail(
				"Unknown endpoint or method: finite native HTTP fixture has no implementation"
			);
		}
		if (
			["POST", "PUT"].includes(request.method) &&
			url.pathname !== "/api/uploads" &&
			!backgroundContract?.allowNoBody &&
			url.pathname !==
				"/api/projects/projects/chat-page-owned-project/main-thread" &&
			!(body && typeof body === "object" && !Array.isArray(body))
		) {
			return fail("Write requires a complete JSON object", 400);
		}
		const hold = consume(holds, call);
		const refusal = consume(refusals, call);
		if (hold) {
			const recordAbort = () => {
				call.clientAborted = true;
			};
			call.clientAborted = request.signal.aborted;
			request.signal.addEventListener("abort", recordAbort, { once: true });
			const accepted = await new Promise<boolean>((resolve) =>
				held.set(call.id, resolve)
			);
			request.signal.removeEventListener("abort", recordAbort);
			held.delete(call.id);
			if (!accepted) {
				call.status = "refused";
				call.responseStatus = hold.status;
				return response(hold.body ?? { error: hold.message }, hold.status);
			}
		}
		if (refusal) {
			call.status = "refused";
			call.responseStatus = refusal.status;
			return response(
				refusal.body ?? { error: refusal.message },
				refusal.status
			);
		}
		call.status = "accepted";
		call.responseStatus = 200;
		if (worktreeStatusRoute) {
			return response({
				active: false,
				branch: null,
				path: null,
				has_changes: false,
				changed_files: 0,
			});
		}
		if (contextRoute) {
			return response({ breakdown: contextBreakdown });
		}
		if (uiStateRoute) {
			return response({ states: {} });
		}
		if (sideChatListRoute && sideChatListMatch) {
			const saved = SAVED_SIDE_CHATS[decodeURIComponent(sideChatListMatch[1])];
			return response(saved ? [saved] : []);
		}
		// `planRoute` already requires a non-backend node.
		if (planRoute) {
			const result = planDocuments.handle(
				node,
				call.userJwt,
				request.method,
				url.pathname,
				body
			);
			call.responseStatus = result.status;
			call.status = result.status >= 400 ? "refused" : "accepted";
			return response(result.body, result.status);
		}
		// `reactionRoute` already requires a non-backend node.
		if (reactionRoute) {
			const result = reactions.handle(node, request.method, body);
			return result
				? response(result)
				: fail("Invalid exact reaction emoji DTO", 400);
		}
		if (draftsRoute) {
			if (request.method === "POST") {
				const input = body as Record<string, unknown>;
				const allowedKeys = ["agent_id", "folder_path", "source", "text"];
				if (
					Object.keys(input).some((field) => !allowedKeys.includes(field)) ||
					typeof input.text !== "string" ||
					input.text.trim() === "" ||
					input.source !== "manual"
				) {
					return fail("Invalid Save to Drafts DTO", 400);
				}
				const now = Date.now();
				const draft = {
					...input,
					created_at: now,
					id: `draft-fixture-${drafts.length + 1}`,
					preview: input.text.slice(0, 80),
					state: "draft",
					state_label: "Draft",
					trigger: { kind: "manual" },
					updated_at: now,
					waiting_for: "",
				};
				drafts.push(draft);
				return response({ draft });
			}
			if (url.pathname === "/api/drafts/list") {
				return response({ drafts });
			}
			if (url.pathname === "/api/drafts/settings") {
				return response({
					settings: {
						auto_queue_enabled: false,
						autosave_enabled: false,
						autosave_min_chars: 20,
						max_concurrent: 2,
					},
				});
			}
			return response({ draft: null });
		}
		if (preferenceKey && node !== "backend") {
			return response({
				key: preferenceKey,
				value:
					preferences.get(`${node}:${preferenceKey}`) ??
					(preferenceKey === "support-access-local-enabled" ? "false" : null),
			});
		}
		if (entitlementWrite) {
			const input = body as Record<string, unknown>;
			if (
				Object.keys(input).length !== 1 ||
				!["true", "false"].includes(String(input.value))
			) {
				return fail("Invalid entitlement preference DTO", 400);
			}
			const savedKey = url.pathname.split("/").at(-1)!;
			preferences.set(`${node}:${savedKey}`, String(input.value));
			return response({ key: savedKey, value: input.value });
		}
		if (presenceWrite) {
			const input = body as Record<string, unknown>;
			if (
				Object.keys(input).length !== 2 ||
				typeof input.clientId !== "string" ||
				!["online", "away", "do-not-disturb", "gaming", "streaming"].includes(
					String(input.status)
				)
			) {
				return fail("Invalid presence heartbeat DTO", 400);
			}
			return response({
				status: input.status,
				source: "reported",
				questionsDeferred: input.status !== "online",
				gaming: {
					active: false,
					detectedGame: null,
					modelsPaused: false,
					settings: {
						detectionEnabled: false,
						extraProcesses: [],
						ignoredProcesses: [],
						freeLocalModels: false,
					},
				},
			});
		}
		if (projectRoute) {
			if (
				url.pathname === "/api/projects/projects" &&
				request.method === "GET"
			) {
				return response({
					projects: projects.has(node) ? [projects.get(node)] : [],
				});
			}
			if (
				url.pathname === "/api/projects/projects" &&
				request.method === "POST"
			) {
				const expected = {
					name: "Project Atlas",
					description: "",
					instructions: "",
					icon: null,
					coordinatorAgent: "ryu",
					cwd: "/tmp/ryu-chat-controls-project",
					defaults: { effort: "", model: "", provider: "" },
					executionMode: "auto",
				};
				if (!Bun.deepEquals(body, expected)) {
					return fail("Unknown owned migration project DTO", 400);
				}
				const project = {
					...expected,
					id: "chat-page-owned-project",
					client: "",
					owner: "",
					dueDate: "",
					status: "planned",
					tasks: [],
					members: [],
					coordinatorConversationId: null,
					createdAt: 1_790_812_800_000,
					updatedAt: 1_790_812_800_000,
				};
				projects.set(node, project);
				return response(project);
			}
			if (!projects.has(node)) {
				return fail("Unknown owned project", 404);
			}
			if (url.pathname.endsWith("/main-thread")) {
				call.status = "refused";
				call.responseStatus = 503;
				return response(
					{
						error:
							"Core is unavailable; open this project from a connected Ryu node",
					},
					503
				);
			}
			const input = body as Record<string, unknown>;
			if (
				Object.keys(input).length !== 2 ||
				input.from_scope_id !== "/tmp/ryu-chat-controls-project" ||
				input.to_project_id !== "chat-page-owned-project"
			) {
				return fail("Unknown owned project-memory migration DTO", 400);
			}
			return response({ moved: 0 });
		}
		// Core's resume route replays the turn it is running, and otherwise answers
		// the background contract's 404 below.
		const resumeMatch =
			backgroundContract && node !== "backend" && request.method === "GET"
				? /^\/api\/chat\/stream\/resume\/([^/]+)$/.exec(url.pathname)
				: null;
		if (node !== "backend" && resumeMatch) {
			const resumed = liveChats.resume(
				node,
				call.id,
				decodeURIComponent(resumeMatch[1]),
				request
			);
			if (resumed) {
				return resumed;
			}
		}
		if (backgroundContract) {
			if (
				["/api/chat/suggestions", "/api/chat/prediction"].includes(
					url.pathname
				) &&
				(Object.keys(body as Record<string, unknown>).length !== 1 ||
					!dtos.conversationSummaries.some(
						(summary) =>
							summary.id === (body as Record<string, unknown>).conversation_id
					))
			) {
				return fail(`Unknown ${url.pathname} conversation DTO`, 400);
			}
			if (url.pathname === "/api/chat/suggestions" && node !== "backend") {
				call.status = "accepted";
				call.responseStatus = 200;
				return response({
					suggestions:
						suggestions.get(
							key(
								node,
								String((body as Record<string, unknown>).conversation_id)
							)
						) ?? [],
				});
			}
			if (url.pathname === "/api/ws/ticket") {
				const input = body as Record<string, unknown>;
				if (
					Object.keys(input).length !== 3 ||
					input.kind !== "conversation" ||
					input.route !== "realtime" ||
					!(
						input.roomId === "system:plugins" ||
						dtos.conversationSummaries.some(
							(summary) => summary.id === input.roomId
						)
					)
				) {
					return fail("Unknown realtime room binding", 400);
				}
			}
			call.responseStatus = backgroundContract.status ?? 200;
			call.status = call.responseStatus >= 400 ? "refused" : "accepted";
			return backgroundContract.stream
				? idleStream(
						request,
						typeof backgroundContract.body === "string"
							? backgroundContract.body
							: "",
						node
					)
				: response(
						backgroundContract.body,
						backgroundContract.status,
						backgroundContract.headers
					);
		}
		if (node === "backend") {
			return response(
				url.pathname === "/api/auth/token" ? {} : { ok: true, share: null }
			);
		}
		if (id && knownConversation) {
			const conversationId = decodeURIComponent(id[1]);
			if (id[2] === "model-selection") {
				const selection = modelSelections.get(key(node, conversationId)) ?? {
					changes: [],
					current: null,
				};
				if (request.method === "GET") {
					return response(selection);
				}
				const input = body as Record<string, unknown>;
				if (
					typeof input.changeId !== "string" ||
					!["initial", "change"].includes(String(input.kind)) ||
					["providerId", "providerLabel", "modelId", "modelLabel"].some(
						(field) => input[field] !== null && typeof input[field] !== "string"
					)
				) {
					return fail("Invalid model-selection DTO", 400);
				}
				const duplicate = selection.changes.find(
					(change) => change.id === input.changeId
				);
				if (duplicate) {
					return response({ change: duplicate, changed: false });
				}
				const change = {
					id: input.changeId,
					kind: input.kind,
					providerId: input.providerId,
					providerLabel: input.providerLabel,
					modelId: input.modelId,
					modelLabel: input.modelLabel,
					sequence: selection.changes.length + 1,
					createdAt: Date.now(),
					changedBy: OWNER_ID,
				};
				selection.changes.push(change);
				selection.current = change;
				modelSelections.set(key(node, conversationId), selection);
				return response({ change, changed: true });
			}
			if (id[2] === "access") {
				if (request.method === "PUT") {
					Object.assign(access, body);
				}
				return response({ ...access, ok: request.method === "PUT" });
			}
			if (id[2] === "history-preview") {
				return response(dtos.historyPreview);
			}
			// Core's `{ history }` DTO; these fixture conversations were never renamed.
			if (id[2] === "title-history") {
				return response({ history: [] });
			}
			if (id[2] === "fork") {
				const conversation = dtos.conversationSummary(
					"conversation-forked-fixture",
					"Forked launch plan",
					1_724_000_040_000
				);
				histories.set(key(node, conversation.id), [
					...(histories.get(key(node, conversationId)) ?? []),
				]);
				return response({ conversation });
			}
			return response({
				has_older_messages: false,
				messages: histories.get(key(node, conversationId)) ?? [],
			});
		}
		switch (url.pathname) {
			case "/api/conversations":
				return response({ conversations: dtos.conversationSummaries });
			case "/api/plugins/contributions":
				return response({
					composer_controls: dtos.composerControls,
					message_actions:
						scenario === "message-reactions-caller" ? [REACTION_ACTION] : [],
					companions: dtos.pluginCompanions,
					chat_features:
						scenario === "side-chat-sidebar"
							? [SIDE_CHATS_FEATURE]
							: scenario === "task-suggestion-temporary"
								? [GHOST_CHATS_FEATURE]
								: [],
					// The Drafts app's Home button is what tells the shell the app is on.
					sidebar_buttons: (
						TASK_SUGGESTION_WITH_DRAFTS as readonly string[]
					).includes(scenario)
						? [
								{
									id: "home",
									plugin: "@ryu/drafts",
									target: "/drafts",
									title: "Drafts",
								},
							]
						: [],
				});
			case "/api/ext/com.ryu.test-tools/current-run":
				return response({
					items: [{ id: "run-fixture-1", title: "Launch review in progress" }],
				});
			case "/api/plugins/com.ryu.test-tools/host":
				return response({ result: { ok: true } });
			case "/api/agents":
				return response({
					agents: [
						{
							id: "agent-fixture",
							name: "Fixture Agent",
							title: "Fixture agent",
							engine: "codex",
							transport: null,
							installed: true,
							locked: false,
						},
						// The `task-suggestion-agent` thread runs this agent, which is
						// not the default a new chat would pick.
						...(scenario === "task-suggestion-agent"
							? [
									{
										id: "agent-second",
										name: "Second Agent",
										title: "Second agent",
										engine: "acp:fixture",
										transport: null,
										installed: true,
										locked: false,
									},
								]
							: []),
					],
				});
			case "/api/agents/agent-fixture/acp-config":
				return response({ configOptions: null, models: null, modes: null });
			case "/api/agents/agent-fixture":
				return response({
					agent: {
						id: "agent-fixture",
						name: "Fixture Agent",
						title: "Fixture agent",
						engine: "codex",
						built_in: false,
						tools: ["search_web", "read_file"],
					},
				});
			case "/api/acl/principals":
				return response({
					members: [
						{ email: "jiawei@example.test", id: OWNER_ID, name: "Jia Wei Ng" },
					],
					org_id: "org-share-toolbar-fixture",
					teams: [],
				});
			case "/api/git/status":
				if (url.searchParams.get("cwd") !== "/tmp/ryu-chat-controls-project") {
					return fail("Unknown owned git workspace", 400);
				}
				return response({
					is_repo: true,
					branch: "main",
					ahead: 0,
					behind: 0,
					dirty: false,
					changed_files_count: 0,
				});
			case `/api/worktree/${CONVERSATION_ID}/status`:
				return response({
					active: false,
					branch: null,
					path: null,
					has_changes: false,
					changed_files: 0,
				});
			case "/api/background/processes":
				if (url.searchParams.get("running_only") !== "true") {
					return fail("Unknown background process filter", 400);
				}
				return response({ processes: [] });
			case "/api/workspace/list":
				return response({
					entries: [],
					home: "/tmp",
					parent: "/tmp",
					path: url.searchParams.get("path") ?? "/tmp",
				});
			case "/api/engines":
				return response({
					engines: [
						{
							id: "codex",
							name: "Codex",
							description: "Local fixture catalog",
							installed: true,
							installHint: null,
						},
					],
				});
			case "/api/engines/models":
				return response({
					models: {
						codex: [
							{ id: "model-proof-a", name: "Proof model A" },
							{ id: "model-proof-b", name: "Proof model B" },
						],
					},
				});
			case "/api/uploads": {
				const blob = await request.blob();
				uploads.push({
					filename: request.headers.get("x-filename") ?? "upload",
					size: blob.size,
					type: blob.type,
				});
				return response({
					content_type: "image/png",
					file_name: request.headers.get("x-filename") ?? "upload.png",
					id: "uploaded-chat-image",
					size: blob.size,
					space_id: "uploads-fixture",
					url: "/api/uploads/uploaded-chat-image",
				});
			}
			// The review pane's read of one turn's edited files: a unified diff for
			// the single fixture path, answered only for the owned workspace.
			case "/api/git/file-diff": {
				const input = body as { cwd?: unknown; paths?: unknown };
				if (
					input.cwd !== "/tmp/ryu-chat-controls-project" ||
					!Array.isArray(input.paths) ||
					input.paths.length !== 1 ||
					input.paths[0] !== "src/status.txt"
				) {
					return fail("Unknown file-diff DTO", 400);
				}
				return response({
					patch: [
						"diff --git a/src/status.txt b/src/status.txt",
						"--- a/src/status.txt",
						"+++ b/src/status.txt",
						"@@ -1 +1 @@",
						"-pending",
						"+ready",
						"",
					].join("\n"),
					paths: ["src/status.txt"],
				});
			}
			case "/api/git/reverse-edits": {
				reversedEdits.push(body);
				const plan = (body as { plan?: { edits?: Array<{ path?: string }> } })
					.plan;
				return response({
					kind: "applied",
					paths: plan?.edits?.map((change) => change.path) ?? [],
				});
			}
			case "/api/chat/control": {
				const input = body as Record<string, unknown>;
				if (
					Object.keys(input).length !== 3 ||
					input.action !== "answer_now" ||
					input.conversation_id !== CONVERSATION_ID ||
					typeof input.turn_id !== "string"
				) {
					return fail("Unknown native Answer now target DTO", 400);
				}
				const result = liveChats.answerNow(
					node,
					CONVERSATION_ID,
					input.turn_id
				);
				call.responseStatus = result.status;
				call.status = result.status >= 400 ? "refused" : "accepted";
				return response(result.body, result.status);
			}
			case "/api/chat/cancel": {
				const conversationId = (body as { conversation_id?: unknown })
					.conversation_id;
				if (
					typeof conversationId !== "string" ||
					!dtos.conversationSummaries.some(
						(summary) => summary.id === conversationId
					)
				) {
					return fail("Known conversation_id is required", 400);
				}
				return response({ cancelled: liveChats.cancel(node, conversationId) });
			}
			case "/api/chat/stream":
				{
					const conversationId = (body as { conversation_id?: unknown })
						.conversation_id;
					// A suggested task starts a NEW chat, whose id the browser mints, so
					// its scenarios capture the real request for any conversation id.
					const startsNewChats = (
						TASK_SUGGESTION_SCENARIOS as readonly string[]
					).includes(scenario);
					if (
						typeof conversationId !== "string" ||
						!(
							startsNewChats ||
							dtos.conversationSummaries.some(
								(summary) => summary.id === conversationId
							)
						)
					) {
						return fail("Known conversation_id is required", 400);
					}
					const streaming = liveChats.start(
						node,
						call.id,
						conversationId,
						request
					);
					if (streaming) {
						return streaming;
					}
				}
				call.status = "refused";
				call.responseStatus = 503;
				return response(
					{
						error:
							"Owned chat fixture captured the real request; no model provider is running.",
					},
					503
				);
			default:
				call.responseStatus = 404;
				return response({ error: "Fixture plugin bundle unavailable" }, 404);
		}
	}
	return {
		fetch,
		control,
		snapshot,
		reset,
		close: () => {
			liveChats.close();
			for (const stop of [...idleStreams]) {
				stop("fixture-teardown");
			}
			for (const release of held.values()) {
				release(false);
			}
			held.clear();
		},
	};
}

if (import.meta.main) {
	const fixture = createChatPageNativeHttpFixture("http://127.0.0.1:5590");
	const servers = (
		[
			[5591, "a"],
			[5594, "b"],
			[5592, "backend"],
		] as const
	).map(([port, node]) =>
		Bun.serve({
			...CHAT_PAGE_NATIVE_HTTP_SERVER_OPTIONS,
			port,
			fetch: (request, server) => fixture.fetch(request, node, server),
		})
	);
	const stop = () => {
		fixture.close();
		for (const server of servers) {
			server.stop(true);
		}
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	console.log(
		"Owned ChatPage native HTTP fixture ready on CoreA5591/CoreB5594/backend5592; browser origin5590"
	);
}
