import { afterAll, expect, test } from "bun:test";
import type { z } from "zod";
import {
	type NavigationRequest,
	streamNavigationRequests,
} from "./navigation.ts";
import {
	navigationLegacySchema,
	navigationPublisherSchema,
} from "./navigation-wire-contracts.ts";

const payloads: NavigationRequest[] = [
	{ plugin_id: "native-app", target: "/native", params: null },
	{ plugin_id: "native-app", target: "/native", params: false },
	{ plugin_id: "native-app", target: "/native", params: 42 },
	{ plugin_id: "native-app", target: "/native", params: "opaque" },
	{ plugin_id: "native-app", target: "/native", params: ["opaque", null] },
	{
		plugin_id: "native-app",
		target: "/native",
		params: { future: { nested: ["opaque", 42] } },
	},
	{ target: "/legacy" },
	{ plugin_id: "native-app", target: "/native", kind: "future-native-surface" },
	{
		plugin_id: "native-app",
		target: "/native",
		kind: "browser",
		force_new: true,
		target_user_id: "native-user",
	},
	{ target: "/last" },
];
const requests: {
	authorization: string | null;
	delegation: string | null;
	path: string;
}[] = [];
const server = Bun.serve({
	port: 0,
	fetch(request) {
		requests.push({
			authorization: request.headers.get("Authorization"),
			delegation: request.headers.get("x-ryu-user-jwt"),
			path: new URL(request.url).pathname,
		});
		return new Response(
			payloads
				.map((value) => `event: navigation\ndata: ${JSON.stringify(value)}\n\n`)
				.join(""),
			{ headers: { "Content-Type": "text/event-stream" } }
		);
	},
});
afterAll(() => server.stop(true));
const target = {
	url: `http://127.0.0.1:${server.port}`,
	token: "native-token",
	userJwt: "native-user",
};

const publisherKinds: z.output<typeof navigationPublisherSchema>["kind"][] = [
	undefined,
	"tab",
	"panel",
	"browser",
];
test("complete native navigation retains raw serde JSON params and honest legacy surface fallback", () => {
	for (const params of [
		undefined,
		null,
		false,
		42,
		"opaque",
		["native", null],
		{ future: { nested: ["opaque", 42] } },
	]) {
		for (const kind of publisherKinds) {
			for (const force_new of [undefined, false, true]) {
				const value: z.output<typeof navigationPublisherSchema> = {
					plugin_id: "@ryu/native-app",
					target: "/plugin/native",
					future: { retained: "metadata" },
				};
				if (params !== undefined) {
					value.params = params;
				}
				if (kind !== undefined) {
					value.kind = kind;
				}
				if (force_new !== undefined) {
					value.force_new = force_new;
				}
				expect(navigationPublisherSchema.parse(value)).toBe(value);
				expect(navigationLegacySchema.parse(value)).toBe(value);
			}
		}
	}
	const legacyValues: z.output<typeof navigationLegacySchema>[] = [
		{ target: "/legacy" },
		{
			target: "/future",
			plugin_id: "native-app",
			kind: "future-native-surface",
		},
		{
			target: "/nulls",
			plugin_id: null,
			kind: null,
			force_new: null,
			target_user_id: null,
		},
	];
	for (const value of legacyValues) {
		expect(navigationLegacySchema.parse(value)).toBe(value);
	}
});

for (const throwOnLast of [false, true]) {
	test(`native SSE preserves callback order/auth and abort${throwOnLast ? " with callback refusal" : ""}`, async () => {
		const abort = new AbortController();
		const seen: NavigationRequest[] = [];
		const initial = requests.length;
		const timer = setTimeout(() => abort.abort(), 3000);
		try {
			await streamNavigationRequests(
				target,
				(value) => {
					seen.push(value);
					if (value.target === "/last") {
						abort.abort();
						if (throwOnLast) {
							throw new Error("native callback refusal");
						}
					}
				},
				abort.signal
			);
			expect(seen).toEqual(payloads);
			expect(requests.slice(initial)).toEqual([
				{
					authorization: "Bearer native-token",
					delegation: "native-user",
					path: "/api/events/all",
				},
			]);
		} finally {
			clearTimeout(timer);
			abort.abort();
		}
	});
}
