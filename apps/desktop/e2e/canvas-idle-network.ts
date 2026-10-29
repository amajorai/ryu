import type { Page } from "@playwright/test";
import { createChatControlBackground } from "./harness/chat-page-control-background.ts";
import type { UnexpectedChatProofRequest } from "./harness/chat-page-proof-http.ts";

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
			conversationIds: ["canvas-idle-fixture"],
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
		if (!url.pathname.startsWith("/api/")) return route.continue();
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
