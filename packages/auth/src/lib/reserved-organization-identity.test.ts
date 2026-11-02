import { describe, expect, test } from "bun:test";
import { resolveOrganizationIdentityUpdate } from "@ryu/db/organization-identity";
import { createEndpoint, createRouter } from "better-call";

// `beforeUpdateOrganization` resolves every rename through
// `resolveOrganizationIdentityUpdate`. A rename into a protected brand throws from
// inside that Better Auth hook; this pins that better-call turns the refusal into
// an HTTP 422 with its code, not an opaque 500.
describe("reserved organization identity through Better Auth's router", () => {
	const rename = createEndpoint(
		"/organization/update",
		{ method: "POST" },
		async (ctx) => {
			const body = ctx.body as { name?: string };
			const resolved = resolveOrganizationIdentityUpdate(
				{ logo: null, name: "Acme", slug: "acme" },
				{ name: body.name }
			);
			return { changed: resolved.changed };
		}
	);
	const router = createRouter({ rename });

	async function post(name: string): Promise<Response> {
		return await router.handler(
			new Request("http://localhost/organization/update", {
				body: JSON.stringify({ name }),
				headers: { "content-type": "application/json" },
				method: "POST",
			})
		);
	}

	test("a rename to a lookalike vendor name is a 422 reserved_identity", async () => {
		const response = await post("Anthr\u043epic");
		expect(response.status).toBe(422);
		const body = (await response.json()) as { code?: string };
		expect(body.code).toBe("reserved_identity");
	});

	test("an ordinary rename still succeeds", async () => {
		const response = await post("Acme Labs");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ changed: true });
	});
});
