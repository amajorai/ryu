import { afterEach, describe, expect, it } from "bun:test";
import {
	subscribePreferenceChanges,
	TRUSTED_WORKSPACES_PREF_KEY,
	trustWorkspaces,
	untrustWorkspace,
} from "./preferences.ts";

const target = { token: null, url: "http://ryu.test", userJwt: null };
const originalFetch = globalThis.fetch;

interface CapturedRequest {
	body: unknown;
	method: string;
	url: string;
}

function captureFetch(
	requests: CapturedRequest[],
	response: () => Response
): void {
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({
				body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
				method: init?.method ?? "GET",
				url: String(input),
			});
			return response();
		},
		{ preconnect: originalFetch.preconnect }
	);
}

function foldersResponse(folders: string[]): Response {
	return new Response(JSON.stringify({ folders }), {
		headers: { "content-type": "application/json" },
		status: 200,
	});
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("workspace trust edits", () => {
	it("adds folders through Core's atomic route without reading the list first", async () => {
		const requests: CapturedRequest[] = [];
		const notifications: [string, string][] = [];
		const unsubscribe = subscribePreferenceChanges((key, value) => {
			notifications.push([key, value]);
		});
		captureFetch(requests, () => foldersResponse(["/old", "/repo"]));
		try {
			expect(await trustWorkspaces(target, ["/repo"])).toBe(true);
		} finally {
			unsubscribe();
		}
		expect(requests).toEqual([
			{
				body: { folders: ["/repo"] },
				method: "POST",
				url: "http://ryu.test/api/workspace-trust/trust",
			},
		]);
		expect(notifications).toEqual([
			[TRUSTED_WORKSPACES_PREF_KEY, JSON.stringify(["/old", "/repo"])],
		]);
	});

	it("removes one folder through Core's atomic route", async () => {
		const requests: CapturedRequest[] = [];
		captureFetch(requests, () => foldersResponse([]));
		expect(await untrustWorkspace(target, "/repo")).toBe(true);
		expect(requests).toEqual([
			{
				body: { folder: "/repo" },
				method: "POST",
				url: "http://ryu.test/api/workspace-trust/untrust",
			},
		]);
	});

	it("surfaces a failed edit instead of reporting success", async () => {
		const requests: CapturedRequest[] = [];
		captureFetch(
			requests,
			() => new Response('{"error":"forbidden"}', { status: 403 })
		);
		await expect(untrustWorkspace(target, "/repo")).rejects.toThrow();
	});
});
