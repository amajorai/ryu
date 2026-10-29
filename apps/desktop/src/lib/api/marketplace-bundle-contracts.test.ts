import { expect, it } from "bun:test";
import {
	type AppJsonValue,
	appJsonValueSchema,
} from "@ryuhq/core-client/app-request-json.ts";
import type { z } from "zod";
import {
	marketplaceBundleDefinitionSchema,
	marketplaceBundleMemberInputSchema,
} from "./marketplace-bundle-contracts.ts";

it("keeps omitted authoring source and original members while accepting normalized nullable source", () => {
	const member = {
		id: "owner/skill",
		kind: "skill",
		name: "Skill",
		required: true,
	} satisfies z.output<typeof marketplaceBundleMemberInputSchema>;
	const members = [member];
	const definition = {
		kind: "bundle",
		sourceUrl: "https://example.test",
		members,
		future: appJsonValueSchema.parse(
			JSON.parse('{"__proto__":{"enabled":true}}')
		),
	} satisfies z.output<typeof marketplaceBundleDefinitionSchema> & {
		future: AppJsonValue;
	};
	expect(marketplaceBundleDefinitionSchema.parse(definition)).toBe(definition);
	expect(marketplaceBundleDefinitionSchema.parse(definition).members).toBe(
		members
	);
	expect(marketplaceBundleMemberInputSchema.parse(member)).toBe(member);
	expect(
		Object.hasOwn(marketplaceBundleMemberInputSchema.parse(member), "source")
	).toBe(false);
	const normalized = { ...member, source: null };
	expect(marketplaceBundleMemberInputSchema.parse(normalized)).toBe(normalized);
});
it("checks every authoring member field and additive JSON without pretending missing source is required", () => {
	const member = {
		id: "owner/skill",
		kind: "skill",
		name: "Skill",
		required: true,
	} satisfies z.output<typeof marketplaceBundleMemberInputSchema>;
	for (const patch of [
		{ id: 3 },
		{ kind: "bundle" },
		{ name: 4 },
		{ required: "true" },
		{ source: 5 },
	]) {
		expect(
			marketplaceBundleMemberInputSchema.safeParse({ ...member, ...patch })
				.success
		).toBe(false);
	}
	const prototype = JSON.parse('{"__proto__":{"enabled":true}}');
	Object.defineProperty(prototype, "__proto__", {
		value: undefined,
		enumerable: true,
	});
	expect(
		marketplaceBundleMemberInputSchema.safeParse({ ...member, ...prototype })
			.success
	).toBe(false);
});
