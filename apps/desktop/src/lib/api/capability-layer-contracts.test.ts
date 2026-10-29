import { describe, expect, it } from "bun:test";
import {
	capabilityBindingsReplySchema,
	capabilityReadModelSchema,
} from "./capability-layer-contracts.ts";
import {
	CapabilityBindingConflictError,
	describeBindingFailure,
	setCapabilityBinding,
} from "./capability-layers.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";

describe("capability Core response boundaries", () => {
	it("retains complete rows, native future metadata and own prototype keys", () => {
		const provider = {
			id: "future.provider",
			target: "future-target",
			serves_route: null,
			verbs: null,
		};
		const capabilities = [
			{
				capability: "future.capability",
				providers: [provider],
				title: null,
				future: JSON.parse('{"__proto__":{"nested":true}}'),
			},
		];
		const reply = { capabilities, verbs: null, revision: 42 };
		const parsed = capabilityReadModelSchema.parse(reply);
		expect(parsed).toBe(reply);
		expect(parsed.capabilities).toBe(capabilities);
		expect(parsed.capabilities?.[0]?.providers?.[0]).toBe(provider);
		expect(
			capabilityReadModelSchema.safeParse({
				capabilities: [
					{ capability: "x", providers: [{ id: "p", serves_route: "yes" }] },
				],
			}).success
		).toBe(false);
		const bindings = JSON.parse(
			'{"overrides":{"__proto__":"actual-provider","web.search":"p"}}'
		);
		expect(capabilityBindingsReplySchema.parse(bindings)).toBe(bindings);
		expect(
			capabilityBindingsReplySchema.safeParse(
				JSON.parse('{"overrides":{"__proto__":false}}')
			).success
		).toBe(false);
	});
	it("serializes concurrent choices and retains other layer bindings over native HTTP", async () => {
		let overrides =
			capabilityBindingsReplySchema.parse({ overrides: { existing: "keep" } })
				.overrides ?? {};
		const requests: string[] = [];
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				requests.push(request.method);
				if (request.method === "GET") {
					return Response.json({ overrides });
				}
				const body = capabilityBindingsReplySchema.parse(await request.json());
				overrides = body.overrides ?? {};
				return Response.json({ ok: true, overrides });
			},
		});
		try {
			const target = { url: server.url.origin, token: "fixture" };
			const result = await Promise.all([
				setCapabilityBinding(target, "web.search", "search"),
				setCapabilityBinding(target, "document.parse", "parse"),
			]);
			expect(result[0]).toEqual({ existing: "keep", "web.search": "search" });
			expect(result[1]).toEqual({
				existing: "keep",
				"web.search": "search",
				"document.parse": "parse",
			});
			expect(requests).toEqual(["GET", "PUT", "GET", "PUT"]);
		} finally {
			server.stop(true);
		}
	});
	it("preserves Core conflict details and recovers the write queue after a refusal", async () => {
		let refuse = true;
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				if (request.method === "GET") {
					return Response.json({ overrides: { existing: "keep" } });
				}
				gatewayJsonValueSchema.parse(await request.json());
				if (refuse) {
					refuse = false;
					return Response.json(
						{
							error: "App is unbound",
							plugin: "consumer",
							binding_error: "ambiguous",
						},
						{ status: 409 }
					);
				}
				return new Response("");
			},
		});
		try {
			const target = { url: server.url.origin, token: "fixture" };
			const failure = await setCapabilityBinding(
				target,
				"web.search",
				"search"
			).catch((error) => error);
			expect(failure).toBeInstanceOf(CapabilityBindingConflictError);
			expect(describeBindingFailure(failure, "Search")).toBe(
				"App is unbound (consumer) · ambiguous"
			);
			expect(
				await setCapabilityBinding(target, "web.search", "search")
			).toEqual({ existing: "keep", "web.search": "search" });
		} finally {
			server.stop(true);
		}
	});
});
