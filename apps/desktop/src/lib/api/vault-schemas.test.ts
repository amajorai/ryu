import { expect, test } from "bun:test";
import {
	destroyReplySchema,
	listVaultEnvironmentsResponseSchema,
	revealReplySchema,
} from "./vault-schemas.ts";

test("reveal and destroy replies tolerate an empty body but not a wrong type", () => {
	expect(revealReplySchema.parse(undefined)).toBeUndefined();
	expect(revealReplySchema.parse({ value: "v" })).toEqual({ value: "v" });
	expect(() => revealReplySchema.parse({ value: 3 })).toThrow();
	expect(destroyReplySchema.parse({ destroyed: 2, ok: true })).toEqual({
		destroyed: 2,
		ok: true,
	});
	expect(() => destroyReplySchema.parse({ destroyed: -1 })).toThrow();
	expect(() => destroyReplySchema.parse({ destroyed: 1.5 })).toThrow();
});

test("environment listings keep unknown fields and require each slug", () => {
	const reply = listVaultEnvironmentsResponseSchema.parse({
		active: "prod",
		environments: [
			{
				name: "Production",
				position: 0,
				protected: true,
				requiredApprovals: 1,
				slug: "prod",
			},
		],
		extra: true,
	});
	expect(reply.environments?.[0]?.slug).toBe("prod");
	expect(() =>
		listVaultEnvironmentsResponseSchema.parse({
			environments: [{ name: "x" }],
		})
	).toThrow();
});
