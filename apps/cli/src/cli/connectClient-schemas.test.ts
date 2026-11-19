import { describe, expect, test } from "bun:test";
import { balanceSchema, refusalSchema } from "./connectClient-schemas.ts";

describe("connect answer schemas", () => {
	test("a balance parses; a changed shape is refused", () => {
		const balance = {
			object: "balance",
			availableMicroUsd: 1,
			billed: true,
			heldMicroUsd: 0,
			headroomMicroUsd: null,
			suspended: false,
			topUpUrl: null,
			unsettledMicroUsd: null,
			unsettledSince: null,
		};
		expect(balanceSchema.safeParse(balance).success).toBe(true);
		expect(balanceSchema.safeParse({ ...balance, billed: "yes" }).success).toBe(
			false
		);
	});

	test("refusals keep extra fields", () => {
		expect(
			refusalSchema.parse({ code: "x", error: "y", top_up_url: "z" })
		).toEqual({ code: "x", error: "y", top_up_url: "z" });
	});
});
