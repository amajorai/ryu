import { describe, expect, it } from "bun:test";
import {
	createRnpContextBundle,
	normalizeRnpNodeUrl,
	parseRnpContinuityBundle,
	RNP_CONTINUITY_LIMITS,
	type RnpContinuityBundleV0,
	resolveRnpNode,
	serializeRnpContinuityBundle,
} from "./continuity.ts";

function bundle(): RnpContinuityBundleV0 {
	return {
		protocol: "ryu-node-continuity",
		version: 0,
		bundleId: "handoff-1",
		createdAt: 1_800_000_000_000,
		source: {
			conversationId: "conversation-1",
			updatedAt: 1_799_999_999_000,
			checkpointMessageId: "message-2",
			title: "Release plan",
			agentHint: "ryu",
		},
		selection: {
			transcript: { mode: "recent", maxMessages: 50 },
			omittedEarlierMessages: false,
		},
		messages: [
			{ sourceId: "message-1", role: "user", text: "Ship it", createdAt: 10 },
			{
				sourceId: "message-2",
				role: "assistant",
				text: "Ready.",
				createdAt: 20,
			},
		],
		context: {
			version: 0,
			items: [
				{
					id: "context-1",
					kind: "text",
					label: "Operator note",
					mediaType: "text/plain",
					text: "Keep the deployment paused.",
					source: { kind: "manual" },
				},
			],
		},
	};
}

function firstItem<T>(items: readonly T[]) {
	const item = items[0];
	if (item === undefined) {
		throw new Error("Expected a complete continuity fixture item");
	}
	return item;
}

describe("RNP continuity bundle", () => {
	it("round-trips a bounded v0 bundle", () => {
		const value = bundle();
		expect(
			parseRnpContinuityBundle(serializeRnpContinuityBundle(value))
		).toEqual({
			ok: true,
			value,
		});
	});

	it("rejects unsupported versions and privileged message roles", () => {
		const future = { ...bundle(), version: 1 };
		expect(parseRnpContinuityBundle(future)).toMatchObject({
			ok: false,
			error: { code: "unsupported-version" },
		});

		const valid = bundle();
		const withSystem = {
			...valid,
			messages: valid.messages.map((message, index) =>
				index === 0 ? { ...message, role: "system" } : message
			),
		};
		expect(parseRnpContinuityBundle(withSystem)).toMatchObject({
			ok: false,
			error: { code: "invalid-shape", path: "messages[0].role" },
		});
	});

	it("measures Unicode payload limits in UTF-8 bytes", () => {
		const oversized = bundle();
		oversized.messages[0] = {
			...firstItem(oversized.messages),
			text: "🙂".repeat(RNP_CONTINUITY_LIMITS.maxMessageBytes / 4 + 1),
		};
		expect(parseRnpContinuityBundle(oversized)).toMatchObject({
			ok: false,
			error: { code: "limit-exceeded", path: "messages[0].text" },
		});
	});

	it("rejects duplicate message and context ids", () => {
		const duplicateMessage = bundle();
		duplicateMessage.messages.push({ ...firstItem(duplicateMessage.messages) });
		expect(parseRnpContinuityBundle(duplicateMessage)).toMatchObject({
			ok: false,
			error: { path: "messages[2].sourceId" },
		});

		expect(() =>
			createRnpContextBundle({
				items: [
					firstItem(bundle().context.items),
					firstItem(bundle().context.items),
				],
			})
		).toThrow("Context ids must be unique");

		const reservedMessageId = bundle();
		firstItem(reservedMessageId.messages).sourceId = "rnp-context-reserved";
		expect(parseRnpContinuityBundle(reservedMessageId).ok).toBe(false);
	});
});

describe("RNP node routing", () => {
	it("normalizes safe HTTP node URLs and rejects credential-bearing URLs", () => {
		expect(normalizeRnpNodeUrl("https://node.example.com:7980/")).toBe(
			"https://node.example.com:7980"
		);
		expect(normalizeRnpNodeUrl("http://127.0.0.1:7980/")).toBe(
			"http://127.0.0.1:7980"
		);
		for (const value of [
			"http://192.168.1.50:7980",
			"https://user:pass@node.example.com",
			"https://node.example.com?token=secret",
			"file:///tmp/core.sock",
			"javascript:alert(1)",
		]) {
			expect(normalizeRnpNodeUrl(value)).toBeNull();
		}
	});

	it("resolves only nodes already configured by the user", () => {
		const nodes = [{ name: "studio", url: "https://node.example.com/" }];
		expect(resolveRnpNode("https://node.example.com", nodes)).toEqual({
			kind: "ready",
			node: firstItem(nodes),
		});
		expect(resolveRnpNode("https://unknown.example.com", nodes)).toEqual({
			kind: "blocked",
			reason: "node-not-configured",
		});
	});
});

describe("ordered continuity failure and projection contracts", () => {
	it("reports a duplicate before a later malformed message", () => {
		const value = bundle();
		const first = firstItem(value.messages);
		expect(
			parseRnpContinuityBundle({ ...value, messages: [first, first, {}] })
		).toEqual({
			ok: false,
			error: {
				code: "invalid-shape",
				message: "Message ids must be unique",
				path: "messages[1].sourceId",
			},
		});
	});
	it("checks array count before malformed rows and reports the full context path", () => {
		expect(
			parseRnpContinuityBundle({
				...bundle(),
				messages: Array.from({ length: 201 }, () => ({})),
			})
		).toEqual({
			ok: false,
			error: {
				code: "limit-exceeded",
				message: "Too many messages",
				path: "messages",
			},
		});
		expect(
			parseRnpContinuityBundle({
				...bundle(),
				context: { version: 0, items: [{ kind: "wrong" }] },
			})
		).toEqual({
			ok: false,
			error: {
				code: "invalid-shape",
				message: "Expected a text context item",
				path: "context.items[0]",
			},
		});
	});
	it("retains inherited fields and omits absent optional source properties", () => {
		const value = bundle();
		const source = Object.assign(
			Object.create({ conversationId: value.source.conversationId }),
			{ updatedAt: value.source.updatedAt }
		);
		const parsed = parseRnpContinuityBundle({ ...value, source });
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) {
			throw new Error(parsed.error.message);
		}
		expect(parsed.value.source).toEqual({
			conversationId: value.source.conversationId,
			updatedAt: value.source.updatedAt,
		});
		expect(Object.keys(parsed.value.source)).toEqual([
			"conversationId",
			"updatedAt",
		]);
	});
});
