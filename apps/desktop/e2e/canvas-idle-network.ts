import type { Page } from "@playwright/test";
import { createChatControlBackground } from "./harness/chat-page-control-background.ts";
import type { UnexpectedChatProofRequest } from "./harness/chat-page-proof-http.ts";
import {
	type ShellBootstrapPath,
	shellBootstrapResponse,
} from "./harness/shell-bootstrap-routes.ts";

/** The Layout bootstrap GETs this proof expects on the fixture node: the plugin
 *  contributions and meetings reads, and the Settings tab's voice, embeddings
 *  and A2A pages. Answered with empty-node DTOs; any other path stays unexpected. */
const CANVAS_BOOTSTRAP_GETS: readonly ShellBootstrapPath[] = [
	"/api/plugins/contributions",
	"/api/meetings",
	"/api/voice/tts-engines",
	"/api/voice/tts-models",
	"/api/embeddings/model",
	"/api/embeddings/reindex/status",
	"/api/a2a/settings",
	"/api/a2a/peers",
	"/api/a2a/principals",
	"/api/a2a/published-agents",
	"/api/a2a/tasks",
];

/** The launchpad composer's send opens a chat whose id is `conv-${Date.now()}`;
 *  the spec fixes the page clock to this instant before sending so that id, and
 *  every per-conversation read the chat makes, has a finite contract. */
export const LAUNCHPAD_SEND_TIME = 1_793_600_000_000;
const LAUNCHPAD_CONVERSATION_ID = `conv-${LAUNCHPAD_SEND_TIME}`;
export const LAUNCHPAD_DRAFT = "Launchpad draft persists into a new chat";

/** The one chat turn the launchpad send starts: exactly the draft, as a user
 *  message on the fixed conversation with the composer's defaults. */
function isLaunchpadTurn(body: string | null) {
	const input: unknown = JSON.parse(body ?? "null");
	if (!input || typeof input !== "object") {
		return false;
	}
	const { messages, ...options } = { ...input } as Record<string, unknown>;
	const [message, ...rest] = Array.isArray(messages) ? messages : [];
	return (
		JSON.stringify(options) ===
			JSON.stringify({
				agent_id: null,
				response_mode: "everyday",
				conversation_id: LAUNCHPAD_CONVERSATION_ID,
				enable_long_term: false,
				worktree_isolation: false,
			}) &&
		rest.length === 0 &&
		typeof message?.id === "string" &&
		JSON.stringify({ ...message, id: "" }) ===
			JSON.stringify({
				parts: [{ type: "text", text: LAUNCHPAD_DRAFT }],
				id: "",
				role: "user",
			})
	);
}

// Geometry proof only: typed idle dependencies, never Core/provider execution.
export async function installCanvasIdleNetwork(
	page: Page,
	unexpected: UnexpectedChatProofRequest[]
) {
	const origin = "http://127.0.0.1:5418";
	const backend = new URL(
		process.env.VITE_APP_BACKEND_URL ?? "http://localhost:3000"
	).origin;
	const background = createChatControlBackground(
		{
			coreUrl: origin,
			backendUrl: backend,
			conversationIds: ["canvas-idle-fixture", LAUNCHPAD_CONVERSATION_ID],
			ownerId: "canvas-idle-owner",
		},
		unexpected
	);
	const extraCalls: Array<{
		method: string;
		url: string;
		authorization: string | null;
		body: string | null;
		responseStatus: number;
	}> = [];
	const snapshot = () => ({
		...background.snapshot(),
		extraCalls,
		streamBoundary:
			"Finite idle event stream ends at EOF; no live peer or stream-cancellation acceptance",
	});
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (!url.pathname.startsWith("/api/")) {
			return route.continue();
		}
		const rawBody = request.postData();
		const authorization = request.headers().authorization ?? null;
		const record = (status: number) =>
			extraCalls.push({
				method: request.method(),
				url: request.url(),
				authorization,
				body: rawBody,
				responseStatus: status,
			});
		if (
			url.origin === backend &&
			request.method() === "GET" &&
			!url.search &&
			rawBody === null &&
			authorization === null
		) {
			if (url.pathname === "/api/auth/get-session") {
				record(200);
				return route.fulfill({ json: null });
			}
			if (url.pathname === "/api/credits/alert/stream") {
				record(401);
				return route.fulfill({
					status: 401,
					json: { error: "Authentication required" },
				});
			}
		}
		if (
			url.origin !== origin ||
			authorization !== "Bearer tabs-fixture" ||
			request.headers()["x-ryu-user-jwt"] !== undefined
		) {
			unexpected.push({
				method: request.method(),
				url: request.url(),
				body: rawBody,
			});
			record(503);
			return route.fulfill({
				status: 503,
				json: { error: "Unregistered canvas authority" },
			});
		}
		if (request.method() === "GET" && rawBody === null) {
			if (
				url.pathname === "/api/conversations" &&
				url.search === "?preview=1"
			) {
				record(200);
				return route.fulfill({ json: { conversations: [] } });
			}
			if (url.pathname === "/api/preferences/auto-updates" && !url.search) {
				record(200);
				return route.fulfill({ json: { key: "auto-updates", value: null } });
			}
			const bootstrap = url.search
				? undefined
				: shellBootstrapResponse(CANVAS_BOOTSTRAP_GETS, url.pathname);
			if (bootstrap) {
				record(200);
				return route.fulfill(bootstrap);
			}
		}
		// The turn is answered as an idle stream that ends at once: the proof covers
		// the canvas taking the new chat tab, not provider execution.
		if (
			request.method() === "POST" &&
			url.pathname === "/api/chat/stream" &&
			!url.search &&
			isLaunchpadTurn(rawBody)
		) {
			record(200);
			return route.fulfill({
				status: 200,
				contentType: "text/event-stream",
				body: ": owned idle EOF\n\n",
			});
		}
		// After that idle turn Core has persisted nothing: the conversation reads
		// answer 404, which ChatHistory treats as "never persisted" (an empty
		// thread), and the follow-up prediction is empty.
		if (
			request.method() === "GET" &&
			rawBody === null &&
			url.pathname === `/api/conversations/${LAUNCHPAD_CONVERSATION_ID}` &&
			["", "?limit=40"].includes(url.search)
		) {
			record(404);
			return route.fulfill({
				status: 404,
				json: { error: "conversation not found" },
			});
		}
		if (
			request.method() === "POST" &&
			url.pathname === "/api/chat/prediction" &&
			!url.search &&
			rawBody === JSON.stringify({ conversation_id: LAUNCHPAD_CONVERSATION_ID })
		) {
			record(200);
			return route.fulfill({ json: { prediction: null } });
		}
		const effective = new Request(request.url(), {
			method: request.method(),
			headers: request.headers(),
			...(rawBody === null ? {} : { body: rawBody }),
		});
		const response = await background.respond(effective);
		if (!response) {
			unexpected.push({
				method: request.method(),
				url: request.url(),
				body: rawBody,
			});
			record(503);
			return route.fulfill({
				status: 503,
				json: { error: "Unregistered canvas dependency" },
			});
		}
		if (response.headers.get("content-type")?.includes("text/event-stream")) {
			await response.body?.cancel();
			return route.fulfill({
				status: response.status,
				contentType: "text/event-stream",
				body: ": owned idle EOF\n\n",
			});
		}
		return route.fulfill({
			status: response.status,
			headers: Object.fromEntries(response.headers),
			body: await response.text(),
		});
	});
	return snapshot;
}
