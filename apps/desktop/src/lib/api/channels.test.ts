import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { TOKEN_KEY } from "@/lib/auth-client.ts";
import {
	type ChannelConfig,
	channelConfigSchema,
	channelPlatformOptionsSchema,
	createChannel,
	deleteChannel,
	listChannels,
	updateChannel,
} from "./channels.ts";

const storageDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	"localStorage"
);
const values = new Map<string, string>();
const storage: Storage = {
	get length() {
		return values.size;
	},
	clear: () => values.clear(),
	getItem: (key) => values.get(key) ?? null,
	key: (index) => [...values.keys()][index] ?? null,
	removeItem: (key) => {
		values.delete(key);
	},
	setItem: (key, value) => {
		values.set(key, value);
	},
};
let reply = "{}";
let status = 200;
const calls: {
	path: string;
	authorization: string | null;
	method: string;
	body: string;
}[] = [];
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === "/api/auth/get-session") {
			return Response.json(null);
		}
		calls.push({
			path,
			authorization: request.headers.get("authorization"),
			method: request.method,
			body: await request.text(),
		});
		return new Response(reply, {
			status,
			headers: { "Content-Type": "application/json" },
		});
	},
});
const nativeFetch = globalThis.fetch;
const route = (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
	const request = new Request(input, options);
	return nativeFetch(
		new URL(new URL(request.url).pathname, server.url),
		request
	);
};
beforeEach(() => {
	values.clear();
	calls.length = 0;
	reply = "{}";
	status = 200;
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: storage,
	});
	globalThis.fetch = Object.assign(route, {
		preconnect: nativeFetch.preconnect,
	});
});
afterEach(() => {
	globalThis.fetch = nativeFetch;
	if (storageDescriptor) {
		Object.defineProperty(globalThis, "localStorage", storageDescriptor);
	} else {
		Reflect.deleteProperty(globalThis, "localStorage");
	}
});
afterAll(() => server.stop(true));

const channel = {
	id: "channel",
	channelType: "telegram",
	createdAt: "now",
	createdBy: "user",
	updatedAt: "later",
	credentialSource: "customer",
	name: "Bot",
	enabled: true,
	agentId: null,
	teamId: null,
	organizationId: null,
	provisionedServerId: null,
	managedBotId: null,
	managedBotUsername: null,
	managedProvisioningState: null,
	model: null,
	systemPrompt: null,
	groupReplyMode: "mentions",
	secrets: { bot_token: "***" },
	platformOptions: {},
	dmAllowlist: [],
	dmPolicy: "pairing",
	groupAllowlist: [],
	groupPolicy: "allowlist",
	groupUserAllowlist: [],
	lifecycleReactions: true,
	proactiveOpening: false,
	proactiveTarget: null,
	profileDescription: null,
	profileName: null,
	profileShortBio: null,
	publishCommands: true,
	richText: true,
	sendReadReceipts: true,
	streaming: false,
	threadReplies: false,
	typingIndicator: true,
	voiceReply: "never",
	reactionLearning: {
		allowGroup: false,
		enabled: false,
		negativeEmoji: [],
		positiveEmoji: [],
	},
} satisfies ChannelConfig;
test("admits complete masked channel rows and preserves native future fields and platform-option identity", () => {
	const options = JSON.parse(
		'{"__proto__":{"future":1e400},"custom":[true,null]}'
	);
	const row = {
		...channel,
		platformOptions: options,
		future: { retained: true },
	};
	expect(Object.is(channelConfigSchema.parse(row), row)).toBe(true);
	expect(
		Object.is(channelConfigSchema.parse(row).platformOptions, options)
	).toBe(true);
	const requestOptions = {
		omitted: undefined,
		nonfinite: Number.POSITIVE_INFINITY,
		future: options,
	};
	expect(
		Object.is(
			channelPlatformOptionsSchema.parse(requestOptions),
			requestOptions
		)
	).toBe(true);
	expect(
		JSON.stringify(channelPlatformOptionsSchema.parse(requestOptions))
	).toBe(JSON.stringify(requestOptions));
	for (const key of [
		"id",
		"channelType",
		"createdAt",
		"createdBy",
		"name",
		"enabled",
		"credentialSource",
		"secrets",
		"agentId",
	]) {
		expect(
			channelConfigSchema.safeParse({ ...channel, [key]: undefined }).success
		).toBe(false);
	}
	const legacy = { ...channel };
	Reflect.deleteProperty(legacy, "dmPolicy");
	Reflect.deleteProperty(legacy, "dmAllowlist");
	expect(Object.is(channelConfigSchema.parse(legacy), legacy)).toBe(true);
	expect(
		channelConfigSchema.safeParse({ ...channel, dmPolicy: "invented" }).success
	).toBe(false);
	expect(
		channelConfigSchema.safeParse({ ...channel, channelType: "invented" })
			.success
	).toBe(false);
	expect(
		channelPlatformOptionsSchema.safeParse({ bad: () => true }).success
	).toBe(false);
});
test("retains session headers, write-only-secret request bodies and omitted/null list fallbacks", async () => {
	values.set(TOKEN_KEY, "session");
	expect(await listChannels()).toEqual([]);
	reply = '{"channels":null}';
	expect(await listChannels()).toEqual([]);
	reply = JSON.stringify({ channels: [channel] });
	expect(await listChannels()).toEqual([channel]);
	reply = JSON.stringify(channel);
	const input = {
		channelType: "telegram",
		name: "Bot",
		secrets: { bot_token: "new-token" },
		platformOptions: { omitted: undefined, future: true },
	} satisfies Parameters<typeof createChannel>[0];
	expect(await createChannel(input)).toEqual(channel);
	expect(await updateChannel("channel", { name: "Renamed" })).toEqual(channel);
	expect(calls.every((call) => call.authorization === "Bearer session")).toBe(
		true
	);
	expect(
		calls.slice(3).map((call) => ({
			method: call.method,
			path: call.path,
			body: call.body,
		}))
	).toEqual([
		{
			method: "POST",
			path: "/api/channels",
			body: '{"channelType":"telegram","name":"Bot","secrets":{"bot_token":"new-token"},"platformOptions":{"future":true}}',
		},
		{
			method: "PATCH",
			path: "/api/channels/channel",
			body: '{"name":"Renamed"}',
		},
	]);
	reply = "{}";
	await deleteChannel("channel");
	expect(calls.at(-1)?.path).toBe("/api/channels/channel");
	for (const empty of ["[]", '"legacy"', "4", "true"]) {
		reply = empty;
		expect(await listChannels()).toEqual([]);
	}

	reply = '{"channels":[{"id":"partial"}]}';
	await expect(listChannels()).rejects.toThrow();
});
test("preserves existing authorization and tolerant server-error fallbacks", async () => {
	status = 401;
	reply = '{"message":"other"}';
	await expect(listChannels()).rejects.toThrow("Sign in to manage channels.");
	status = 503;
	for (const body of [
		'{"message":"offline"}',
		'{"error":"offline"}',
		'{"message":null,"error":"offline"}',
	]) {
		reply = body;
		await expect(listChannels()).rejects.toThrow("offline");
	}
	reply = '{"message":7}';
	await expect(listChannels()).rejects.toThrow("7");
	for (const body of [
		"null",
		'"text"',
		"[]",
		"{}",
		"not-json",
		'{"message":false}',
	]) {
		reply = body;
		await expect(listChannels()).rejects.toThrow("Request failed: 503");
	}
});
