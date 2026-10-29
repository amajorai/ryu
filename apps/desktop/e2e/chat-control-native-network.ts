import type { Page } from "@playwright/test";
import {
	canonicalPath,
	createBackgroundContracts,
} from "./chat-page-native-http-background.ts";

interface Call {
	method: string;
	url: string;
	authorization: string | null;
	body: string | null;
	responseStatus: number;
}
const ledgers = new WeakMap<Page, { calls: Call[]; unexpected: Call[] }>();
export function chatControlNativeNetworkLedger(page: Page) {
	return ledgers.get(page) ?? { calls: [], unexpected: [] };
}
// Better Auth captures fetch at module construction, before the old harness installs
// its fetch fixture. Route the actual browser network for these finite auth reads.
export async function installChatControlNativeNetwork(page: Page) {
	const state = { calls: [] as Call[], unexpected: [] as Call[] };
	ledgers.set(page, state);
	const backend = new URL(
		process.env.VITE_APP_BACKEND_URL ?? "http://localhost:3000"
	).origin;
	const contracts = createBackgroundContracts(
		"conversation-toolbar-share-fixture",
		"share-owner"
	).backend;
	const authReads = new Set([
		"/api/auth/get-session",
		"/api/auth/organization/get-full-organization",
		"/api/auth/organization/list",
		"/api/auth/organization/list-user-teams",
	]);
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (!url.pathname.startsWith("/api/")) return route.continue();
		const call: Call = {
			method: request.method(),
			url: request.url(),
			authorization: request.headers().authorization ?? null,
			body: request.postData(),
			responseStatus: 503,
		};
		state.calls.push(call);
		const contract = contracts.get(`${request.method()} ${canonicalPath(url)}`);
		if (
			url.origin !== backend ||
			request.method() !== "GET" ||
			call.body !== null ||
			call.authorization !== "Bearer share-toolbar-fixture-token" ||
			!authReads.has(url.pathname) ||
			!contract ||
			contract.stream
		) {
			state.unexpected.push(call);
			return route.fulfill({
				status: 503,
				json: { error: "Unregistered actual-network chat fixture request" },
			});
		}
		call.responseStatus = contract.status ?? 200;
		return route.fulfill({
			status: call.responseStatus,
			json: contract.body,
			headers: contract.headers,
		});
	});
}
