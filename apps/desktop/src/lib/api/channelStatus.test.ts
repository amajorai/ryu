import { expect, test } from "bun:test";
import { TOKEN_KEY } from "@/lib/auth-client.ts";
import {
	type ChannelLiveState,
	channelStatusSchema,
	subscribeChannelStatus,
} from "./channelStatus.ts";

test("checks the complete control-plane status projection and retains future metadata", () => {
	for (const state of ["online", "connecting", "error", "offline", "unknown"]) {
		const row = {
			id: "channel",
			state,
			detail: null,
			lastHeartbeatAt: null,
			future: JSON.parse('{"__proto__":{"overflow":1e400}}'),
		};
		expect(Object.is(channelStatusSchema.parse(row), row)).toBe(true);
	}
	for (const row of [
		{ id: "channel", state: "invented", detail: null, lastHeartbeatAt: null },
		{ id: "channel", state: "online" },
		{ id: 1, state: "online", detail: null, lastHeartbeatAt: null },
	]) {
		expect(channelStatusSchema.safeParse(row).success).toBe(false);
	}
});
test("uses one authenticated snapshot/stream, ignores malformed frames and emits only changed states", async () => {
	const nativeFetch = globalThis.fetch;
	const storageDescriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		"localStorage"
	);
	const storage: Storage = {
		length: 1,
		clear() {},
		getItem: (key) => (key === TOKEN_KEY ? "session" : null),
		key: () => TOKEN_KEY,
		removeItem() {},
		setItem() {},
	};
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: storage,
	});
	const calls: { path: string; authorization: string | null }[] = [];
	const snapshots: Map<string, ChannelLiveState>[] = [];
	const secondSnapshots: Map<string, ChannelLiveState>[] = [];
	const encoder = new TextEncoder();
	const wire =
		'event: ping\ndata: {}\n\nevent: status\ndata: {"id":"channel","state":"invented","detail":null,"lastHeartbeatAt":null}\n\nevent: status\ndata: {"id":"channel",\ndata: "state":"connecting","detail":"Réçu","lastHeartbeatAt":null}\n\nevent: status\ndata: {"id":"channel","state":"connecting","detail":null,"lastHeartbeatAt":null}\n\nevent: status\ndata: {"id":"channel","state":"offline","detail":null,"lastHeartbeatAt":null}\n\n';
	const bytes = encoder.encode(wire);
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/api/auth/get-session") {
				return Response.json(null);
			}
			calls.push({ path, authorization: request.headers.get("authorization") });
			if (path.endsWith("/stream")) {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							for (let offset = 0; offset < bytes.length; offset += 5) {
								controller.enqueue(bytes.slice(offset, offset + 5));
							}
							controller.close();
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } }
				);
			}
			return Response.json({
				statuses: [
					{
						id: "channel",
						state: "online",
						detail: null,
						lastHeartbeatAt: null,
					},
				],
			});
		},
	});
	const route = (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
		const request = new Request(input, options);
		return nativeFetch(
			new URL(new URL(request.url).pathname, server.url),
			request
		);
	};
	globalThis.fetch = Object.assign(route, {
		preconnect: nativeFetch.preconnect,
	});
	const subscriptions = new Set<() => void>();
	try {
		await new Promise<void>((resolve) => {
			subscriptions.add(
				subscribeChannelStatus((snapshot) => {
					snapshots.push(snapshot);
					if (snapshot.get("channel") === "offline") {
						resolve();
					}
				})
			);
			subscriptions.add(
				subscribeChannelStatus((snapshot) => {
					secondSnapshots.push(snapshot);
				})
			);
		});
		for (const unsubscribe of subscriptions) {
			unsubscribe();
		}
		expect(snapshots.map((snapshot) => [...snapshot])).toEqual([
			[],
			[["channel", "online"]],
			[["channel", "connecting"]],
			[["channel", "offline"]],
		]);
		expect(calls).toEqual([
			{ path: "/api/channels/status", authorization: "Bearer session" },
			{ path: "/api/channels/status/stream", authorization: "Bearer session" },
		]);
		expect(secondSnapshots.map((snapshot) => [...snapshot])).toEqual(
			snapshots.map((snapshot) => [...snapshot])
		);
		expect(Object.is(snapshots[0], snapshots[1])).toBe(false);
	} finally {
		for (const unsubscribe of subscriptions) {
			unsubscribe();
		}
		globalThis.fetch = nativeFetch;
		if (storageDescriptor) {
			Object.defineProperty(globalThis, "localStorage", storageDescriptor);
		} else {
			Reflect.deleteProperty(globalThis, "localStorage");
		}
		await server.stop(true);
	}
});
