import { expect, test } from "bun:test";
import type { RealtimeOptions } from "@ryuhq/core-client/realtime";
import { buildApplicationRealtimeServices } from "./application-realtime-services.ts";

test("room host binds ownership and identity, keeps handles private, and cancels transport on disposal", async () => {
	let options: RealtimeOptions | undefined;
	let closes = 0;
	const published: unknown[] = [];
	const host = buildApplicationRealtimeServices(
		{ url: "https://node.test", token: "node-secret" },
		"@ryu/rooms",
		async () => "user-secret",
		(target, opts) => {
			expect(target.token).toBe("node-secret");
			options = opts;
			return {
				connect: () =>
					opts.handlers?.onJoinAck?.({
						access: "write",
						clientId: "client",
						documentEpoch: 0,
						maySeed: false,
						memberId: "member",
						presence: [],
						roomId: "room",
					}),
				close: () => {
					closes++;
				},
				sendEvent: (name, data) => published.push({ name, data }),
				publishPresence: () => undefined,
			};
		}
	);
	const info = await host.services.realtimeConnect?.({ room_id: "room" });
	if (!info) {
		throw new Error("Missing join information");
	}
	expect(options).toMatchObject({
		appId: "@ryu/rooms",
		roomId: "room",
		jwt: "user-secret",
		kind: "application",
	});
	expect(JSON.stringify(info)).not.toContain("secret");
	await host.services.realtimePublish?.({
		connection_id: info.connection_id,
		event: "changed",
		data: { saved: true },
	});
	expect(published).toEqual([{ name: "changed", data: { saved: true } }]);
	await expect(
		host.services.realtimePublish?.({
			connection_id: "foreign-handle",
			event: "changed",
			data: null,
		})
	).rejects.toThrow("not available");
	const controller = new AbortController();
	const chunks: string[] = [];
	const stream = host.services.realtimeSubscribe?.(
		{ connection_id: info.connection_id },
		(data) => chunks.push(data),
		controller.signal
	);
	options?.handlers?.onNamedEvent?.({ name: "changed", data: { saved: true } });
	await Promise.resolve();
	expect(chunks.map((chunk) => JSON.parse(chunk))).toEqual([
		{ data: { saved: true }, name: "changed", type: "event" },
	]);
	controller.abort();
	await stream;
	expect(closes).toBe(1);
	host.dispose();
	await expect(
		host.services.realtimeConnect?.({ room_id: "room" })
	).rejects.toThrow("document is closed");
});

test("late user identity cannot open a socket after document disposal", async () => {
	let resolveIdentity!: (identity: string) => void;
	let opens = 0;
	const identity = new Promise<string>((resolve) => {
		resolveIdentity = resolve;
	});
	const host = buildApplicationRealtimeServices(
		{ url: "https://node.test", token: null },
		"@ryu/rooms",
		() => identity,
		() => {
			opens++;
			throw new Error("Unexpected connection");
		}
	);
	const pending = host.services.realtimeConnect?.({ room_id: "room" });
	host.dispose();
	resolveIdentity("late-user-secret");
	await expect(pending).rejects.toThrow("document is closed");
	expect(opens).toBe(0);
});

test("join failures release transport and a fresh connection can retry", async () => {
	let attempts = 0;
	let closes = 0;
	const host = buildApplicationRealtimeServices(
		{ url: "https://node.test", token: null },
		"@ryu/rooms",
		async () => null,
		(_, options) => ({
			connect: () => {
				attempts++;
				if (attempts === 1) {
					options.handlers?.onError?.(new Event("error"));
				} else {
					options.handlers?.onJoinAck?.({
						access: "read",
						clientId: "client",
						documentEpoch: 0,
						maySeed: false,
						memberId: "member",
						roomId: "room",
						presence: [],
					});
				}
			},
			close: () => {
				closes++;
			},
			sendEvent: () => undefined,
			publishPresence: () => undefined,
		})
	);
	await expect(
		host.services.realtimeConnect?.({ room_id: "room" })
	).rejects.toThrow("connection failed");
	expect(closes).toBe(1);
	await expect(
		host.services.realtimeConnect?.({ room_id: "room" })
	).resolves.toMatchObject({ access: "read", member_id: "member" });
	host.dispose();
	expect(closes).toBe(2);
});
