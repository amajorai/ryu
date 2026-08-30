import { expect, test } from "bun:test";
import { createNotifyClient } from "./notification-client.ts";

test("the example client sends a separate bearer and idempotency key", async () => {
	let seenUrl = "";
	let seenInit: RequestInit | undefined;
	const client = createNotifyClient({
		apiKey: "notify-secret",
		baseUrl: "https://notify.example/",
		fetchImpl: async (input, init) => {
			seenUrl = String(input);
			seenInit = init;
			return Response.json({
				event: {
					id: "evt_1",
					title: "Box ready",
				},
			});
		},
	});

	const event = await client.publish(
		{ source: "box", title: "Box ready", type: "box.ready" },
		"box:1:ready"
	);
	expect(seenUrl).toBe("https://notify.example/v1/events");
	expect(new Headers(seenInit?.headers).get("authorization")).toBe(
		"Bearer notify-secret"
	);
	expect(new Headers(seenInit?.headers).get("idempotency-key")).toBe(
		"box:1:ready"
	);
	expect(event.id).toBe("evt_1");
});
