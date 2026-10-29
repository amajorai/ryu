// packages/services/src/tools/messaging.test.ts
//
// messaging_send_sms forwards the CLI's `--message-type` / `--ttl` options
// (messageType, ttlSeconds) and refuses values the server would reject.

import { describe, expect, test } from "bun:test";
import { Ryu } from "../ryu.ts";
import { getRyuTool, runRyuTool } from "./index.ts";

const sendSms = getRyuTool("messaging_send_sms");

function ryuRecording() {
	const bodies: unknown[] = [];
	const ryu = new Ryu({
		env: {},
		apiKey: "ryu_test",
		organizationId: "org_1",
		baseUrl: "https://api.example.com",
		maxRetries: 0,
		fetch: async (input, init) => {
			const request = new Request(input, init);
			bodies.push(request.body === null ? null : await request.json());
			return new Response(JSON.stringify({ error: "stop here" }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		},
	});
	return { bodies, ryu };
}

const BASE = {
	from: "num_1",
	to: "+6591234567",
	body: "Shipped",
	idempotencyKey: "send-1",
};

describe("messaging_send_sms", () => {
	test("forwards messageType and ttlSeconds to the send", async () => {
		if (sendSms === undefined) {
			throw new Error("messaging_send_sms is not in RYU_TOOLS");
		}
		const { bodies, ryu } = ryuRecording();
		await runRyuTool(ryu, sendSms, {
			...BASE,
			messageType: "PROMOTIONAL",
			ttlSeconds: 600,
		});
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toMatchObject({
			messageType: "PROMOTIONAL",
			ttlSeconds: 600,
		});
	});

	test("leaves both out when not given", async () => {
		if (sendSms === undefined) {
			throw new Error("messaging_send_sms is not in RYU_TOOLS");
		}
		const { bodies, ryu } = ryuRecording();
		await runRyuTool(ryu, sendSms, BASE);
		expect(bodies[0]).not.toHaveProperty("messageType");
		expect(bodies[0]).not.toHaveProperty("ttlSeconds");
	});

	test("refuses a message type or TTL the server would reject", () => {
		const schema = sendSms?.inputSchema;
		expect(
			schema?.safeParse({ ...BASE, messageType: "MARKETING" }).success
		).toBe(false);
		for (const ttlSeconds of [4, 259_201, 1.5]) {
			expect(schema?.safeParse({ ...BASE, ttlSeconds }).success).toBe(false);
		}
		for (const ttlSeconds of [5, 259_200]) {
			expect(schema?.safeParse({ ...BASE, ttlSeconds }).success).toBe(true);
		}
	});
});

describe("messaging_list_numbers", () => {
	function ryuRecordingUrls() {
		const urls: URL[] = [];
		const ryu = new Ryu({
			env: {},
			apiKey: "ryu_test",
			organizationId: "org_1",
			baseUrl: "https://api.example.com",
			maxRetries: 0,
			fetch: (input, init) => {
				urls.push(new URL(new Request(input, init).url));
				return Promise.resolve(
					new Response(JSON.stringify({ numbers: [] }), {
						status: 200,
						headers: { "content-type": "application/json" },
					})
				);
			},
		});
		return { urls, ryu };
	}

	const listNumbers = getRyuTool("messaging_list_numbers");

	test("includeReleased (and the deprecated all) ask for every status", async () => {
		if (listNumbers === undefined) {
			throw new Error("messaging_list_numbers is not in RYU_TOOLS");
		}
		const { urls, ryu } = ryuRecordingUrls();
		await runRyuTool(ryu, listNumbers, {});
		await runRyuTool(ryu, listNumbers, { includeReleased: true });
		await runRyuTool(ryu, listNumbers, { all: true });
		await runRyuTool(ryu, listNumbers, { includeReleased: false });
		expect(urls.map((url) => url.searchParams.get("status"))).toEqual([
			null,
			"all",
			"all",
			null,
		]);
	});

	test("describes all as a deprecated alias, not a paging flag", () => {
		const schema = listNumbers?.inputSchema.shape as
			| Record<string, { description?: string }>
			| undefined;
		expect(schema?.includeReleased?.description).toContain("released");
		expect(schema?.all?.description).toContain(
			"Deprecated alias of includeReleased"
		);
	});
});
