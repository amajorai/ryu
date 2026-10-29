import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	type ApiTarget,
	type RyuFetch,
	setSurfaceProvider,
	setUserJwtProvider,
} from "@ryuhq/core-client/client";
import { fetchContributedContent } from "../core/contributions.ts";

interface Call {
	authorization: string | null;
	method: string;
	signal: AbortSignal | null | undefined;
	surface: string | null;
	url: string;
	userJwt: string | null;
}

const payload = {
	views: [
		{
			id: "surface:projects",
			plugin: "com.example.projects",
			title: "Projects",
			view: "list-detail",
			spec: { view: "list-detail", items: [] },
		},
	],
	slash_commands: [],
};
const realFetch = globalThis.fetch;
function createFetchSpy() {
	return spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			() => {
				throw new Error(
					"Unexpected global transport: contributions must use the target fetch implementation"
				);
			},
			{ preconnect: realFetch.preconnect }
		)
	);
}
let globalFetch: ReturnType<typeof createFetchSpy>;

beforeEach(() => {
	setSurfaceProvider(() => "cli");
	setUserJwtProvider(() => null);
	globalFetch = createFetchSpy();
});

afterEach(() => {
	globalFetch.mockRestore();
	globalThis.fetch = realFetch;
	setSurfaceProvider(() => null);
	setUserJwtProvider(() => null);
});

function transport(
	calls: Call[],
	responses: Response[] = [Response.json(payload)]
): RyuFetch {
	return (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const parsed = new URL(url);
		const method = init?.method ?? "GET";
		if (
			parsed.pathname !== "/api/plugins/contributions" ||
			method !== "GET" ||
			init?.body !== undefined
		) {
			throw new Error(`Unexpected contributions transport ${method} ${url}`);
		}
		const headers = new Headers(init?.headers);
		calls.push({
			url,
			method,
			authorization: headers.get("authorization"),
			userJwt: headers.get("x-ryu-user-jwt"),
			surface: headers.get("X-Ryu-Surface"),
			signal: init?.signal,
		});
		if (init?.signal?.aborted) {
			return Promise.reject(
				new DOMException("Contributions read cancelled", "AbortError")
			);
		}
		const response = responses.shift();
		if (!response) {
			throw new Error("Unplanned extra contributions request");
		}
		return Promise.resolve(response);
	};
}

test("managed member contributions use delegated admission and explicit user identity on the target transport", async () => {
	const calls: Call[] = [];
	setUserJwtProvider(() => "account-jwt-is-not-node-delegation");
	const target: ApiTarget = {
		url: "https://member-node.example.test/",
		token: null,
		userJwt: "member-node-delegation",
		fetch: transport(calls),
	};
	const content = await fetchContributedContent(target);
	expect(content.views.map((view) => [view.id, view.plugin])).toEqual([
		["surface:projects", "com.example.projects"],
	]);
	expect(content.commands).toEqual([]);
	expect(calls).toEqual([
		{
			url: "https://member-node.example.test/api/plugins/contributions",
			method: "GET",
			authorization: "Bearer member-node-delegation",
			userJwt: "member-node-delegation",
			surface: "cli",
			signal: undefined,
		},
	]);
	expect(globalFetch).not.toHaveBeenCalled();
});

test("node bearer retains admission priority while delegated identity reaches Core", async () => {
	const calls: Call[] = [];
	await fetchContributedContent({
		url: "https://node.example.test",
		token: "node-bearer",
		userJwt: "member-delegation",
		fetch: transport(calls),
	});
	expect(calls).toHaveLength(1);
	expect(calls[0]?.authorization).toBe("Bearer node-bearer");
	expect(calls[0]?.userJwt).toBe("member-delegation");
	expect(calls[0]?.url).toBe(
		"https://node.example.test/api/plugins/contributions"
	);
	expect(globalFetch).not.toHaveBeenCalled();
});

test("a denied contributions read throws and an explicit retry uses the current delegation", async () => {
	const calls: Call[] = [];
	const fetch = transport(calls, [
		Response.json({ error: "member access denied" }, { status: 403 }),
		Response.json(payload),
	]);
	const target: ApiTarget = {
		url: "https://node.example.test",
		token: null,
		userJwt: "old-delegation",
		fetch,
	};
	await expect(fetchContributedContent(target)).rejects.toThrow(
		"/api/plugins/contributions failed: 403"
	);
	expect(calls).toHaveLength(1);
	const recovered = await fetchContributedContent({
		...target,
		userJwt: "new-delegation",
	});
	expect(recovered.views).toHaveLength(1);
	expect(calls.map((call) => [call.authorization, call.userJwt])).toEqual([
		["Bearer old-delegation", "old-delegation"],
		["Bearer new-delegation", "new-delegation"],
	]);
	expect(globalFetch).not.toHaveBeenCalled();
});

test("target changes keep transport and credentials scoped to their own node", async () => {
	const callsA: Call[] = [];
	const callsB: Call[] = [];
	await fetchContributedContent({
		url: "https://a.example.test",
		token: "a-bearer",
		userJwt: "a-identity",
		fetch: transport(callsA),
	});
	await fetchContributedContent({
		url: "https://b.example.test",
		token: null,
		userJwt: "b-delegation",
		fetch: transport(callsB),
	});
	expect(
		callsA.map((call) => [call.url, call.authorization, call.userJwt])
	).toEqual([
		[
			"https://a.example.test/api/plugins/contributions",
			"Bearer a-bearer",
			"a-identity",
		],
	]);
	expect(
		callsB.map((call) => [call.url, call.authorization, call.userJwt])
	).toEqual([
		[
			"https://b.example.test/api/plugins/contributions",
			"Bearer b-delegation",
			"b-delegation",
		],
	]);
	expect(globalFetch).not.toHaveBeenCalled();
});

test("contributions cancellation reaches the selected transport and does not become empty success", async () => {
	const calls: Call[] = [];
	const controller = new AbortController();
	controller.abort();
	await expect(
		fetchContributedContent(
			{
				url: "https://node.example.test",
				token: null,
				userJwt: "delegation",
				fetch: transport(calls),
			},
			controller.signal
		)
	).rejects.toMatchObject({
		name: "AbortError",
		message: "Contributions read cancelled",
	});
	expect(calls).toHaveLength(1);
	expect(calls[0]?.signal).toBe(controller.signal);
	expect(calls[0]?.authorization).toBe("Bearer delegation");
	expect(globalFetch).not.toHaveBeenCalled();
});

test("ordinary node targets retain the global fetch fallback with their node bearer", async () => {
	const calls: Call[] = [];
	globalFetch.mockImplementation(
		Object.assign(transport(calls), {
			preconnect: realFetch.preconnect,
		})
	);
	const content = await fetchContributedContent({
		url: "https://local.example.test",
		token: "local-node-bearer",
	});
	expect(content.views).toHaveLength(1);
	expect(calls).toHaveLength(1);
	expect(calls[0]?.authorization).toBe("Bearer local-node-bearer");
	expect(calls[0]?.userJwt).toBeNull();
	expect(globalFetch).toHaveBeenCalledTimes(1);
});
