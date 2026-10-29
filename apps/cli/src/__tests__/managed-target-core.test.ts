import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	type ApiTarget,
	type RyuFetch,
	setSurfaceProvider,
	setUserJwtProvider,
} from "@ryuhq/core-client/client";
import {
	deleteConversation,
	forkConversation,
	renameConversation,
	resumeConversation,
	setConversationPinned,
} from "../core/conversations.ts";
import { featureListLoader, fetchFeatureList } from "../core/featureList.ts";

interface RecordedCall {
	authorization: string | null;
	body: unknown;
	method: string;
	signal: AbortSignal | null | undefined;
	surface: string | null;
	url: string;
	userJwt: string | null;
}

const realFetch = globalThis.fetch;
function forbidGlobalTransport() {
	return spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			() => {
				throw new Error(
					"Unexpected global fetch: managed target transport required"
				);
			},
			{ preconnect: realFetch.preconnect }
		)
	);
}

let globalFetch: ReturnType<typeof forbidGlobalTransport>;
beforeEach(() => {
	setSurfaceProvider(() => "cli");
	setUserJwtProvider(() => "unrelated-account-identity");
	globalFetch = forbidGlobalTransport();
});
afterEach(() => {
	globalFetch.mockRestore();
	setSurfaceProvider(() => null);
	setUserJwtProvider(() => null);
});

function transport(
	calls: RecordedCall[],
	path: string,
	method: string,
	responses: Response[]
): RyuFetch {
	return (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const parsed = new URL(url);
		if (
			parsed.pathname + parsed.search !== path ||
			(init?.method ?? "GET") !== method
		) {
			throw new Error(
				`Unplanned managed target request: ${init?.method ?? "GET"} ${url}`
			);
		}
		const headers = new Headers(init?.headers);
		calls.push({
			authorization: headers.get("authorization"),
			body:
				init?.body === undefined ? undefined : JSON.parse(String(init.body)),
			method,
			signal: init?.signal,
			surface: headers.get("X-Ryu-Surface"),
			url,
			userJwt: headers.get("x-ryu-user-jwt"),
		});
		if (init?.signal?.aborted) {
			return Promise.reject(
				new DOMException("Managed target read cancelled", "AbortError")
			);
		}
		const response = responses.shift();
		if (!response) {
			throw new Error("Unplanned extra managed target request");
		}
		return Promise.resolve(response);
	};
}

const listConfig = {
	path: "/api/models/catalog?limit=30",
	containerKeys: ["models"],
	idKeys: ["id"],
	titleKeys: ["name"],
	subtitleKeys: ["provider"],
	badgeKeys: ["installed"],
};
const models = {
	models: [
		{ id: "model-1", name: "Local model", provider: "local", installed: true },
	],
};

test("feature list loader reads delegated member results through the selected target transport", async () => {
	const calls: RecordedCall[] = [];
	const controller = new AbortController();
	const rows = await featureListLoader(listConfig)(
		{
			url: "https://member.example.test/",
			token: null,
			userJwt: "member-delegation",
			fetch: transport(calls, listConfig.path, "GET", [Response.json(models)]),
		},
		controller.signal
	);
	expect(rows).toEqual([
		{ id: "model-1", title: "Local model", subtitle: "local", badge: "true" },
	]);
	expect(calls).toEqual([
		{
			url: `https://member.example.test${listConfig.path}`,
			method: "GET",
			body: undefined,
			signal: controller.signal,
			authorization: "Bearer member-delegation",
			userJwt: "member-delegation",
			surface: "cli",
		},
	]);
	expect(globalFetch).not.toHaveBeenCalled();
});

test("feature list refusal remains an error and explicit retry uses renewed delegation", async () => {
	const calls: RecordedCall[] = [];
	const target: ApiTarget = {
		url: "https://member.example.test",
		token: null,
		userJwt: "expired-delegation",
		fetch: transport(calls, listConfig.path, "GET", [
			new Response(null, { status: 403 }),
			Response.json(models),
		]),
	};
	await expect(fetchFeatureList(target, listConfig)).rejects.toThrow(
		`${listConfig.path} failed: 403`
	);
	expect(calls).toHaveLength(1);
	expect(
		await fetchFeatureList(
			{ ...target, userJwt: "renewed-delegation" },
			listConfig
		)
	).toHaveLength(1);
	expect(calls.map((call) => [call.authorization, call.userJwt])).toEqual([
		["Bearer expired-delegation", "expired-delegation"],
		["Bearer renewed-delegation", "renewed-delegation"],
	]);
	expect(globalFetch).not.toHaveBeenCalled();
});

test("feature list abort reaches target transport and never returns an empty successful list", async () => {
	const calls: RecordedCall[] = [];
	const controller = new AbortController();
	controller.abort();
	await expect(
		fetchFeatureList(
			{
				url: "https://member.example.test",
				token: null,
				userJwt: "delegation",
				fetch: transport(calls, listConfig.path, "GET", []),
			},
			listConfig,
			controller.signal
		)
	).rejects.toMatchObject({ name: "AbortError" });
	expect(calls).toHaveLength(1);
	expect(calls[0]?.signal).toBe(controller.signal);
	expect(calls[0]?.authorization).toBe("Bearer delegation");
	expect(globalFetch).not.toHaveBeenCalled();
});

const conversationId = "conversation/a b";
const conversationPath = "/api/conversations/conversation%2Fa%20b";
type ConversationOperation =
	| typeof deleteConversation
	| typeof forkConversation
	| typeof renameConversation
	| typeof resumeConversation
	| typeof setConversationPinned;

interface ConversationCase {
	body: unknown;
	error: string;
	expected: Awaited<ReturnType<ConversationOperation>>;
	invoke: (target: ApiTarget) => ReturnType<ConversationOperation>;
	method: string;
	name: string;
	path: string;
	response: unknown;
}
const conversationCases: ConversationCase[] = [
	{
		name: "resume",
		method: "GET",
		path: conversationPath,
		body: undefined,
		error: "Resume conversation failed: 403",
		response: {
			id: conversationId,
			title: "Saved title",
			messages: [{ id: "message-1", role: "user", content: "Saved turn" }],
		},
		expected: {
			id: conversationId,
			title: "Saved title",
			messages: [
				{
					id: "message-1",
					role: "user",
					content: "Saved turn",
					parts: undefined,
				},
			],
		},
		invoke: (target) => resumeConversation(target, conversationId),
	},
	{
		name: "rename",
		method: "POST",
		path: `${conversationPath}/title`,
		body: { title: "New title" },
		error: "Rename conversation failed: 403",
		response: { title: "New title" },
		expected: "New title",
		invoke: (target) =>
			renameConversation(target, conversationId, "  New title  "),
	},
	{
		name: "delete",
		method: "DELETE",
		path: conversationPath,
		body: undefined,
		error: "Delete conversation failed: 403",
		response: { removed: true },
		expected: true,
		invoke: (target) => deleteConversation(target, conversationId),
	},
	{
		name: "unpin",
		method: "POST",
		path: `${conversationPath}/pinned`,
		body: { value: false },
		error: "Unpin conversation failed: 403",
		response: { ok: true },
		expected: undefined,
		invoke: (target) => setConversationPinned(target, conversationId, false),
	},
	{
		name: "fork",
		method: "POST",
		path: `${conversationPath}/fork`,
		body: { message_id: "message/7" },
		error: "Fork conversation failed: 403",
		response: { conversation: { id: "fork-result" } },
		expected: "fork-result",
		invoke: (target) => forkConversation(target, conversationId, "message/7"),
	},
];

for (const operation of conversationCases) {
	test(`conversation ${operation.name} keeps delegated auth, exact payload, and explicit denial retry`, async () => {
		const calls: RecordedCall[] = [];
		const target: ApiTarget = {
			url: "https://member.example.test/",
			token: null,
			userJwt: "expired-delegation",
			fetch: transport(calls, operation.path, operation.method, [
				new Response(null, { status: 403 }),
				Response.json(operation.response),
			]),
		};
		await expect(operation.invoke(target)).rejects.toThrow(operation.error);
		expect(calls).toHaveLength(1);
		expect(
			await operation.invoke({ ...target, userJwt: "renewed-delegation" })
		).toEqual(operation.expected);
		expect(calls).toEqual(
			["expired-delegation", "renewed-delegation"].map((userJwt) => ({
				url: `https://member.example.test${operation.path}`,
				method: operation.method,
				body: operation.body,
				signal: undefined,
				surface: "cli",
				authorization: `Bearer ${userJwt}`,
				userJwt,
			}))
		);
		expect(globalFetch).not.toHaveBeenCalled();
	});
}

test("conversation targets retain node bearer priority and never reuse another node transport", async () => {
	const callsA: RecordedCall[] = [];
	const callsB: RecordedCall[] = [];
	await deleteConversation(
		{
			url: "https://a.example.test",
			token: "a-node-bearer",
			userJwt: "a-member",
			fetch: transport(callsA, conversationPath, "DELETE", [
				Response.json({ removed: true }),
			]),
		},
		conversationId
	);
	await deleteConversation(
		{
			url: "https://b.example.test",
			token: "b-node-bearer",
			userJwt: "b-member",
			fetch: transport(callsB, conversationPath, "DELETE", [
				Response.json({ removed: false }),
			]),
		},
		conversationId
	);
	expect(
		callsA.map((call) => [call.url, call.authorization, call.userJwt])
	).toEqual([
		[
			`https://a.example.test${conversationPath}`,
			"Bearer a-node-bearer",
			"a-member",
		],
	]);
	expect(
		callsB.map((call) => [call.url, call.authorization, call.userJwt])
	).toEqual([
		[
			`https://b.example.test${conversationPath}`,
			"Bearer b-node-bearer",
			"b-member",
		],
	]);
	expect(globalFetch).not.toHaveBeenCalled();
});
