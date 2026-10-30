import type {
	ConversationModelChange,
	ConversationModelSelectionState,
} from "../../src/lib/api/conversation-model-selection-schema.ts";
import type { ProjectRecord } from "../../src/lib/api/hierarchy.ts";
// Idle Layout dependencies only. Existing ChatPage feature handlers retain ownership.
// This is browser fetch-fixture coverage, not native transport or background-feature acceptance.
import {
	type BackgroundContract,
	CoreContracts,
	canonicalPath,
	createBackgroundContracts,
} from "../chat-page-native-http-background.ts";
import type { UnexpectedChatProofRequest } from "./chat-page-proof-http.ts";

interface Scope {
	backendUrl: string;
	conversationIds: readonly string[];
	coreUrl: string;
	ownerId: string;
}
export function createChatControlBackground(
	scope: Scope,
	unexpected: UnexpectedChatProofRequest[]
) {
	const core: Map<string, BackgroundContract> = new CoreContracts();
	const backend = new Map<string, BackgroundContract>();
	for (const id of scope.conversationIds) {
		const contracts = createBackgroundContracts(id, scope.ownerId);
		for (const [path, dto] of contracts.core) {
			core.set(path, dto);
		}
		for (const [path, dto] of contracts.backend) {
			backend.set(path, dto);
		}
	}
	const preferenceKeys = new Set([
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
	]);
	const preferences = new Map<string, string>();
	const projects = new Map<string, ProjectRecord>();
	const modelSelections = new Map<string, ConversationModelSelectionState>();
	const calls: Array<{
		method: string;
		url: string;
		authorization: string | null;
		userJwt: string | null;
		body: string | null;
		responseStatus: number;
	}> = [];
	const streams = new Map<
		number,
		{ path: string; closed: boolean; cause: string | null }
	>();
	let nextStream = 0;
	return {
		snapshot: () => ({
			calls: structuredClone(calls),
			streams: [...streams.values()].map((entry) => ({ ...entry })),
			preferences: Object.fromEntries(preferences),
			projects: [...projects.values()].map((project) =>
				structuredClone(project)
			),
			modelSelections: Object.fromEntries(modelSelections),
		}),
		async respond(request: Request): Promise<Response | null> {
			const url = new URL(request.url);
			const isCore = url.origin === new URL(scope.coreUrl).origin;
			const isBackend = url.origin === new URL(scope.backendUrl).origin;
			// Browser probes of Island are denied by its loopback Origin guard.
			// Model the canonical negative response, never an accepted visibility action.
			if (url.href === "http://127.0.0.1:7989/control") {
				const body =
					request.body === null ? null : await request.clone().text();
				if (
					request.method !== "GET" ||
					body !== null ||
					request.headers.has("authorization") ||
					request.headers.has("x-ryu-user-jwt")
				) {
					unexpected.push({ method: request.method, url: request.url, body });
					return Response.json(
						{ error: "Unexpected Island control probe" },
						{ status: 503 }
					);
				}
				calls.push({
					method: request.method,
					url: request.url,
					authorization: null,
					userJwt: null,
					body: null,
					responseStatus: 403,
				});
				return Response.json(
					{ ok: false, error: "forbidden" },
					{ status: 403 }
				);
			}
			if (!(isCore || isBackend)) {
				return null;
			}
			const path = canonicalPath(url);
			const body = request.body === null ? null : await request.clone().text();
			const record = (response: Response) => {
				calls.push({
					method: request.method,
					url: request.url,
					authorization: request.headers.get("authorization"),
					userJwt: request.headers.get("x-ryu-user-jwt"),
					body,
					responseStatus: response.status,
				});
				return response;
			};
			const refuse = (message: string) => {
				unexpected.push({ method: request.method, url: request.url, body });
				return record(Response.json({ error: message }, { status: 503 }));
			};
			const parseJson = () => {
				if (body === null) {
					return null;
				}
				try {
					return JSON.parse(body) as unknown;
				} catch {
					return null;
				}
			};
			const preference =
				isCore && !url.search && url.pathname.startsWith("/api/preferences/")
					? url.pathname.slice("/api/preferences/".length)
					: null;
			if (preference && preferenceKeys.has(preference)) {
				if (request.method === "GET") {
					return record(
						Response.json({
							key: preference,
							value:
								preferences.get(preference) ??
								(preference === "support-access-local-enabled"
									? "false"
									: null),
						})
					);
				}
				if (
					request.method === "PUT" &&
					["managed-inference-entitled", "entitlement-active"].includes(
						preference
					)
				) {
					const input: unknown = parseJson();
					if (
						!input ||
						typeof input !== "object" ||
						Object.keys(input).length !== 1 ||
						!("value" in input) ||
						typeof input.value !== "string" ||
						!["true", "false"].includes(input.value)
					) {
						return refuse("Invalid entitlement preference DTO");
					}
					preferences.set(preference, input.value);
					return record(Response.json({ key: preference, value: input.value }));
				}
				return refuse("Unsupported preference method");
			}
			if (isCore && path === "/api/projects/projects") {
				if (request.method === "GET" && body === null) {
					return record(Response.json({ projects: [...projects.values()] }));
				}
				const input = parseJson();
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
				if (
					request.method !== "POST" ||
					!input ||
					typeof input !== "object" ||
					Array.isArray(input) ||
					Object.keys(input).length !== Object.keys(expected).length ||
					Object.entries(expected).some(([key, value]) => {
						const actual = Reflect.get(input, key);
						if (typeof value !== "object" || value === null) {
							return actual !== value;
						}
						return (
							!actual ||
							typeof actual !== "object" ||
							Array.isArray(actual) ||
							Object.keys(actual).length !== Object.keys(value).length ||
							Object.entries(value).some(
								([field, expectedValue]) =>
									Reflect.get(actual, field) !== expectedValue
							)
						);
					})
				) {
					return refuse("Unknown owned project creation DTO");
				}
				const now = Date.now();
				const project = {
					...expected,
					id: `project_fixture_${projects.size + 1}`,
					client: "",
					owner: "",
					dueDate: "",
					coordinatorConversationId: null,
					createdAt: now,
					updatedAt: now,
					members: [],
					tasks: [],
					status: "planned",
				};
				projects.set(project.id, project);
				return record(Response.json(project, { status: 201 }));
			}
			// After creating the project, the desktop asks the Projects app for its
			// coordinator thread and moves folder-scoped memory onto the project.
			// As in the native fixture, no Projects app runs here (its documented
			// 503), and there is no folder memory to move.
			const mainThread =
				/^\/api\/projects\/projects\/([^/]+)\/main-thread$/.exec(path);
			if (isCore && mainThread && request.method === "POST") {
				if (!projects.has(decodeURIComponent(mainThread[1]))) {
					return refuse("Unknown owned project");
				}
				return record(
					Response.json(
						{
							error:
								"Core is unavailable; open this project from a connected Ryu node",
						},
						{ status: 503 }
					)
				);
			}
			if (
				isCore &&
				path === "/api/hierarchy/memory/rekey-project" &&
				request.method === "POST"
			) {
				const input = parseJson();
				if (
					!input ||
					typeof input !== "object" ||
					Object.keys(input).length !== 2 ||
					Reflect.get(input, "from_scope_id") !==
						"/tmp/ryu-chat-controls-project" ||
					!projects.has(String(Reflect.get(input, "to_project_id")))
				) {
					return refuse("Unknown owned project-memory migration DTO");
				}
				return record(Response.json({ moved: 0 }));
			}
			for (const id of scope.conversationIds) {
				if (!isCore || path !== `/api/conversations/${id}/model-selection`) {
					continue;
				}
				const state: ConversationModelSelectionState = modelSelections.get(
					id
				) ?? { current: null, changes: [], handoffs: [] };
				if (request.method === "GET" && body === null) {
					return record(Response.json(state));
				}
				const input = parseJson();
				if (
					request.method !== "PUT" ||
					!input ||
					typeof input !== "object" ||
					Array.isArray(input) ||
					Object.keys(input).length !== 6 ||
					!("changeId" in input) ||
					typeof input.changeId !== "string" ||
					!input.changeId ||
					!("kind" in input) ||
					input.kind !== "initial" ||
					["providerId", "providerLabel", "modelId", "modelLabel"].some(
						(key) => Reflect.get(input, key) !== null
					)
				) {
					return refuse("Unknown owned initial model-selection DTO");
				}
				if (state.current) {
					return record(
						Response.json({ change: state.current, changed: false })
					);
				}
				const change: ConversationModelChange = {
					id: input.changeId,
					kind: "initial",
					providerId: null,
					providerLabel: null,
					modelId: null,
					modelLabel: null,
					sequence: 1,
					createdAt: Date.now(),
					changedBy: scope.ownerId,
				};
				state.current = change;
				state.changes.push(change);
				modelSelections.set(id, state);
				return record(Response.json({ change, changed: true }));
			}
			if (isCore && request.method === "GET" && body === null) {
				if (path === "/api/git/status?cwd=%2Ftmp%2Fryu-chat-controls-project") {
					return record(
						Response.json({
							is_repo: true,
							branch: "main",
							ahead: 0,
							behind: 0,
							dirty: false,
							changed_files_count: 0,
						})
					);
				}
				if (path === "/api/models/context-window?model=gpt-5.1-codex-max") {
					return record(Response.json({ contextLength: null }));
				}
				if (
					path ===
					"/api/routing/advice?agent_id=agent-fixture&at_conversation_start=false&model=gpt-5.1-codex-max"
				) {
					return record(
						Response.json({
							original: {
								agent_id: "agent-fixture",
								model: "gpt-5.1-codex-max",
							},
							effective: {
								agent_id: "agent-fixture",
								model: "gpt-5.1-codex-max",
							},
							severity: "continue",
						})
					);
				}
			}
			if (isCore && request.method === "PUT" && path === "/api/presence") {
				const input: unknown = parseJson();
				if (
					!input ||
					typeof input !== "object" ||
					Object.keys(input).length !== 2 ||
					!("clientId" in input) ||
					typeof input.clientId !== "string" ||
					!input.clientId ||
					!("status" in input) ||
					typeof input.status !== "string" ||
					!["online", "away", "do-not-disturb", "gaming", "streaming"].includes(
						input.status
					)
				) {
					return refuse("Invalid presence heartbeat DTO");
				}
				return record(
					Response.json({
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
					})
				);
			}
			if (isCore && request.method === "GET" && !url.search) {
				if (path === "/api/engines") {
					return record(
						Response.json({
							engines: [
								{
									id: "codex",
									name: "Codex",
									description: "Local fixture catalog",
									installed: true,
									install_hint: null,
								},
							],
						})
					);
				}
				if (path === "/api/engines/models") {
					return record(
						Response.json({
							models: {
								codex: [
									{ id: "model-proof-a", name: "Proof model A" },
									{ id: "model-proof-b", name: "Proof model B" },
								],
							},
						})
					);
				}
				if (path === "/api/agents") {
					return record(
						Response.json({
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
							],
						})
					);
				}
				if (path === "/api/agents/agent-fixture/acp-config") {
					return record(
						Response.json({ configOptions: null, models: null, modes: null })
					);
				}
				for (const id of scope.conversationIds) {
					if (path === `/api/conversations/${id}/model-selection`) {
						return record(Response.json({ current: null, changes: [] }));
					}
					// Core's `get_agent_ui_state_handler`: no fixture transcript
					// renders a `ui.render` widget, so no conversation has state.
					if (path === `/api/conversations/${id}/ui-state`) {
						return record(Response.json({ states: {} }));
					}
					if (path === `/api/worktree/${id}/status`) {
						return record(
							Response.json({
								active: false,
								branch: null,
								path: null,
								has_changes: false,
								changed_files: 0,
							})
						);
					}
				}
			}
			if (
				isCore &&
				request.method === "GET" &&
				path === "/api/background/processes?running_only=true"
			) {
				return record(Response.json({ processes: [] }));
			}
			const contract = (isCore ? core : backend).get(
				`${request.method} ${path}`
			);
			if (!contract) {
				return null;
			}
			if (request.method === "POST") {
				const input: unknown = parseJson();
				if (path === "/api/chat/suggestions") {
					if (
						!input ||
						typeof input !== "object" ||
						Object.keys(input).length !== 1 ||
						!("conversation_id" in input) ||
						!scope.conversationIds.includes(String(input.conversation_id))
					) {
						return refuse("Unknown suggestions conversation DTO");
					}
				} else if (path === "/api/ws/ticket") {
					if (
						!input ||
						typeof input !== "object" ||
						Object.keys(input).length !== 3 ||
						!("kind" in input) ||
						input.kind !== "conversation" ||
						!("route" in input) ||
						input.route !== "realtime" ||
						!("roomId" in input) ||
						![...scope.conversationIds, "system:plugins"].includes(
							String(input.roomId)
						)
					) {
						return refuse("Unknown realtime room binding");
					}
				} else if (!contract.allowNoBody || body !== null) {
					return refuse("Unsupported background write DTO");
				}
			}
			if (!contract.stream) {
				return record(
					Response.json(contract.body, {
						status: contract.status ?? 200,
						headers: contract.headers,
					})
				);
			}
			const entry = { path, closed: false, cause: null as string | null };
			streams.set(++nextStream, entry);
			let close = (_cause: string) => {};
			const abort = () => close("request-abort");
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					close = (cause) => {
						if (entry.closed) {
							return;
						}
						entry.closed = true;
						entry.cause = cause;
						request.signal.removeEventListener("abort", abort);
						controller.close();
					};
					controller.enqueue(
						new TextEncoder().encode(
							typeof contract.body === "string"
								? contract.body
								: ": owned idle stream\n\n"
						)
					);
					request.signal.addEventListener("abort", abort, { once: true });
					if (request.signal.aborted) {
						abort();
					}
				},
				cancel() {
					entry.closed = true;
					entry.cause = "consumer-cancel";
					request.signal.removeEventListener("abort", abort);
				},
			});
			return record(
				new Response(stream, {
					headers: {
						"content-type": "text/event-stream",
						"cache-control": "no-store",
					},
				})
			);
		},
	};
}
