import { expect, test } from "bun:test";
import { createTransportDiagnostics } from "./chat-page-native-http-transport.ts";
test("native request ingress and kernel peer remain independently visible while the exact write acknowledgment is held", async () => {
	const transport = createTransportDiagnostics();
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request, server) {
			transport.record(request, "a", server);
			await held;
			return new Response("accepted");
		},
	});
	try {
		const write = fetch(new URL("/api/model-selection", server.url), {
			method: "PUT",
			headers: {
				Authorization: "Bearer owned-native-diagnostic",
				"x-ryu-user-jwt": "owned-jwt",
			},
			body: JSON.stringify({ modelId: "proof-b" }),
		});
		for (let i = 0; i < 100 && !transport.snapshot().length; i++)
			await Bun.sleep(1);
		const rows = transport.snapshot();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.method).toBe("PUT");
		expect(rows[0]!.headers.authorization).toBe(
			"Bearer owned-native-diagnostic",
		);
		expect(rows[0]!.headers["x-ryu-user-jwt"]).toBe("owned-jwt");
		expect(rows[0]!.signalAborted).toBe(false);
		if (process.platform === "linux")
			expect(rows[0]!.kernelTcp).toEqual({ supported: true, states: ["01"] });
		else expect(rows[0]!.kernelTcp.supported).toBe(false);
		release();
		expect(await (await write).text()).toBe("accepted");
	} finally {
		release();
		server.stop(true);
	}
});
