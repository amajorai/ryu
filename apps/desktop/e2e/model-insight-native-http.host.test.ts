import { expect, test } from "bun:test";
import { startModelInsightProofHost } from "./model-insight-native-http.host.ts";

const auth = { authorization: "Bearer model-insight-owned-token" };
async function using(run: (base: URL) => Promise<void>) {
	const host = startModelInsightProofHost(0);
	try {
		await run(host.server.url);
	} finally {
		host.stop();
	}
}
const route = (base: URL, variant: string) =>
	new URL(
		`/api/models/insight?provider=openrouter&model=openrouter/${variant}`,
		base
	);
test("native HTTP returns exact paid, zero-cost and missing-price model insights", async () =>
	using(async (base) => {
		for (const [variant, input, output] of [
			["paid", 2.5, 15],
			["free", 0, 0],
			["missing", null, null],
		] as const) {
			const response = await fetch(route(base, variant), { headers: auth });
			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.insight.id).toBe(`openrouter/${variant}`);
			expect(body.insight.costInputPer1m).toBe(input);
			expect(body.insight.costOutputPer1m).toBe(output);
		}
		const state = await (await fetch(new URL("/__proof/state", base))).json();
		expect(state.calls).toHaveLength(3);
		expect(state.unexpected).toEqual([]);
	}));
test("invalid authority and unknown finite endpoint remain refusals in real native ledger", async () =>
	using(async (base) => {
		expect(
			(
				await fetch(route(base, "paid"), {
					headers: { authorization: "Bearer foreign-owner" },
				})
			).status
		).toBe(400);
		expect(
			(await fetch(new URL("/api/unknown", base), { headers: auth })).status
		).toBe(400);
		const state = await (await fetch(new URL("/__proof/state", base))).json();
		expect(state.calls).toEqual([]);
		expect(state.unexpected).toHaveLength(2);
		expect(state.unexpected[0]).toContain("openrouter/paid");
		expect(state.unexpected[1]).toContain("/api/unknown");
	}));
test("genuinely held registry refusal settles503 only after owned native release", async () =>
	using(async (base) => {
		let settled = false;
		const pending = fetch(route(base, "refused"), { headers: auth }).then(
			(r) => {
				settled = true;
				return r;
			}
		);
		let state: any;
		for (let i = 0; i < 100; i++) {
			state = await (await fetch(new URL("/__proof/state", base))).json();
			if (state.heldRefused) {
				break;
			}
			await Bun.sleep(1);
		}
		expect(state.heldRefused).toBe(true);
		expect(settled).toBe(false);
		const release = await fetch(new URL("/__proof/release-refused", base), {
			method: "POST",
			headers: { "x-insight-proof-control": "owned-local-fixture" },
		});
		expect(release.status).toBe(200);
		const response = await pending;
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "Finite upstream registry unavailable",
		});
		expect(
			(await (await fetch(new URL("/__proof/state", base))).json()).unexpected
		).toEqual([]);
	}));

test("shipping SDK attribution headers pass exact owned-origin preflight before authenticated model read", async () =>
	using(async (base) => {
		const requested = [
			"authorization",
			"content-type",
			"x-ryu-client-id",
			"x-ryu-client-label",
			"x-ryu-surface",
		];
		const preflight = await fetch(route(base, "paid"), {
			method: "OPTIONS",
			headers: {
				origin: "http://127.0.0.1:5610",
				"access-control-request-method": "GET",
				"access-control-request-headers": requested.join(","),
			},
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe(
			"http://127.0.0.1:5610"
		);
		const allowed = preflight.headers
			.get("access-control-allow-headers")
			?.split(",")
			.map((h) => h.trim().toLowerCase());
		if (!allowed) {
			throw new Error("Missing actual CORS response headers");
		}
		for (const header of requested) {
			expect(allowed).toContain(header);
		}
		expect(allowed).not.toContain("*");
		const before = await (await fetch(new URL("/__proof/state", base))).json();
		expect(before.calls).toEqual([]);
		expect(before.unexpected).toEqual([]);
		const response = await fetch(route(base, "paid"), {
			headers: {
				...auth,
				origin: "http://127.0.0.1:5610",
				"content-type": "application/json",
				"x-ryu-client-id": "owned-insight-client",
				"x-ryu-client-label": "Desktop",
				"x-ryu-surface": "desktop",
			},
		});
		expect(response.status).toBe(200);
		expect((await response.json()).insight).toMatchObject({
			id: "openrouter/paid",
			costInputPer1m: 2.5,
			costOutputPer1m: 15,
		});
		const after = await (await fetch(new URL("/__proof/state", base))).json();
		expect(after.calls).toHaveLength(1);
		expect(after.calls[0]).toMatchObject({
			method: "GET",
			authorization: auth.authorization,
			userJwt: null,
			status: 200,
		});
		expect(after.unexpected).toEqual([]);
	}));
