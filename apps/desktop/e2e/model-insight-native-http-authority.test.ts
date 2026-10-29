import { expect, test } from "bun:test";
import { createModelInsightAuthorityFixture } from "./model-insight-native-http-authority.ts";

const origin = "http://127.0.0.1:5610";
async function using(run: (base: URL) => Promise<void>) {
	const fixture = createModelInsightAuthorityFixture();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: fixture.fetch,
	});
	try {
		await run(server.url);
	} finally {
		fixture.close();
		server.stop(true);
	}
}
const headers = (token = "insight-node-a", jwt = "insight-user-a") => ({
	origin,
	authorization: `Bearer ${token}`,
	"x-ryu-user-jwt": jwt,
	"x-ryu-client-id": "owned-client",
	"x-ryu-client-label": "Desktop",
	"x-ryu-surface": "desktop",
});
const state = async (base: URL) =>
	await (await fetch(new URL("/__authority/state", base))).json();
const read = (
	base: URL,
	path = "/a",
	token = "insight-node-a",
	jwt = "insight-user-a"
) =>
	fetch(
		new URL(
			`${path}/api/models/insight?model=openrouter%2Fshared&provider=openrouter`,
			base
		),
		{ headers: headers(token, jwt) }
	);
const control = (base: URL, body: unknown) =>
	fetch(new URL("/__authority/control", base), {
		method: "POST",
		headers: { "x-insight-proof-control": "owned-local-fixture" },
		body: JSON.stringify(body),
	});
test("finite authority sources return exact pricing and delegated capability for URL/token/JWT", () =>
	using(async (base) => {
		const a = await (await read(base)).json();
		expect(a.insight).toMatchObject({
			name: "Insight A",
			costInputPer1m: 1,
			aaKeyPresent: false,
			source: "openrouter",
		});
		for (const [path, token, jwt] of [
			["/b", "insight-node-a", "insight-user-a"],
			["/a", "insight-node-b", "insight-user-a"],
			["/a", "insight-node-a", "insight-user-b"],
		]) {
			const response = await read(base, path, token, jwt);
			expect(response.status).toBe(200);
			expect((await response.json()).insight).toMatchObject({
				name: "Insight B",
				costInputPer1m: 9,
				costOutputPer1m: 18,
				aaKeyPresent: true,
				source: "models.dev",
				modalitiesInput: ["text", "image"],
			});
		}
		const current = await state(base);
		expect(current.calls).toHaveLength(4);
		expect(current.unexpected).toEqual([]);
		expect(current.calls.map((c: { source: string }) => c.source)).toEqual([
			"A",
			"B",
			"B",
			"B",
		]);
	}));
test("held old source releases genuine HTTP body independently of current B read", () =>
	using(async (base) => {
		expect(
			(await control(base, { action: "hold_next", source: "A" })).status
		).toBe(200);
		let settled = false;
		const pending = read(base).then((r) => {
			settled = true;
			return r;
		});
		let current;
		for (let i = 0; i < 100; i++) {
			current = await state(base);
			if (current.held.length) {
				break;
			}
			await Bun.sleep(1);
		}
		expect(current.held).toEqual([1]);
		expect(settled).toBe(false);
		expect(
			(
				await (
					await read(base, "/a", "insight-node-a", "insight-user-b")
				).json()
			).insight.name
		).toBe("Insight B");
		expect(settled).toBe(false);
		expect((await control(base, { action: "release", id: 1 })).status).toBe(
			200
		);
		expect((await (await pending).json()).insight.name).toBe("Insight A");
		expect(
			(await state(base)).calls.map((c: { status: string }) => c.status)
		).toEqual(["accepted", "accepted"]);
	}));
test("unknown origin, credentials, methods, query and controls never create successful source reads", () =>
	using(async (base) => {
		const url = new URL(
			"/a/api/models/insight?model=openrouter%2Fshared&provider=openrouter",
			base
		);
		for (const init of [
			{ headers: { ...headers(), origin: "http://unowned.invalid" } },
			{ headers: headers("foreign") },
			{ method: "POST", headers: headers() },
		]) {
			expect((await fetch(url, init)).status).toBe(400);
		}
		expect(
			(
				await fetch(
					new URL(
						"/a/api/models/insight?model=other&provider=openrouter",
						base
					),
					{ headers: headers() }
				)
			).status
		).toBe(400);
		expect((await control(base, { action: "release", id: 99 })).status).toBe(
			409
		);
		expect((await state(base)).calls).toEqual([]);
		expect((await state(base)).unexpected).toHaveLength(4);
	}));
test("exact SDK attribution CORS preflight admits only owned origin and no wildcard", () =>
	using(async (base) => {
		const url = new URL(
			"/a/api/models/insight?model=openrouter%2Fshared&provider=openrouter",
			base
		);
		const response = await fetch(url, {
			method: "OPTIONS",
			headers: {
				origin,
				"access-control-request-method": "GET",
				"access-control-request-headers":
					"authorization,x-ryu-user-jwt,x-ryu-client-id,x-ryu-client-label,x-ryu-surface",
			},
		});
		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-origin")).toBe(origin);
		const allowed = response.headers.get("access-control-allow-headers");
		for (const name of [
			"authorization",
			"x-ryu-user-jwt",
			"x-ryu-client-id",
			"x-ryu-client-label",
			"x-ryu-surface",
		]) {
			expect(allowed).toContain(name);
		}
		expect(allowed).not.toContain("*");
		expect((await state(base)).calls).toEqual([]);
	}));
