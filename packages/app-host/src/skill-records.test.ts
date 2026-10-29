import { describe, expect, test } from "bun:test";
import type { RouteClaim } from "./rpc.ts";
import { type Capability, dispatchRpc, type HostServices } from "./rpc.ts";
import {
	skillSourceRecordSchema,
	skillVersionRecordSchema,
	skillVersionRecordsSchema,
	skillWriteRecordSchema,
} from "./skill-records.ts";

const source = {
	allowedTools: ["Read"],
	alwaysOn: false,
	body: "# Instructions",
	description: null,
	id: "skill",
	name: "Skill",
	source: "---\nname: Skill\n---\n# Instructions",
	future: { nested: [null, true] },
	optionalMetadata: undefined,
};
const written = {
	id: "skill",
	source: source.source,
	future: { revision: "v2" },
};
const version = {
	createdAt: 123,
	id: "version",
	label: null,
	name: "Initial",
	future: { revision: 2 },
};

describe("canonical normalized skill records", () => {
	test("retains complete records, additive metadata, nested references and version rows", () => {
		expect(skillSourceRecordSchema.parse(source)).toBe(source);
		expect(skillSourceRecordSchema.parse(source).allowedTools).toBe(
			source.allowedTools
		);
		expect(skillWriteRecordSchema.parse(written)).toBe(written);
		expect(skillVersionRecordSchema.parse(version)).toBe(version);
		const versions = [version];
		expect(skillVersionRecordsSchema.parse(versions)).toBe(versions);
		expect(skillVersionRecordsSchema.parse(versions)[0]).toBe(version);
	});
	test("rejects malformed normalized fields and non-JSON additive metadata", () => {
		expect(
			skillSourceRecordSchema.safeParse({ ...source, allowedTools: [1] })
				.success
		).toBe(false);
		expect(
			skillSourceRecordSchema.safeParse({ ...source, alwaysOn: "false" })
				.success
		).toBe(false);
		expect(
			skillSourceRecordSchema.safeParse({ ...source, description: 3 }).success
		).toBe(false);
		expect(
			skillWriteRecordSchema.safeParse({ ...written, source: 3 }).success
		).toBe(false);
		expect(
			skillVersionRecordSchema.safeParse({
				...version,
				createdAt: Number.POSITIVE_INFINITY,
			}).success
		).toBe(false);
		expect(
			skillVersionRecordSchema.safeParse({ ...version, label: 3 }).success
		).toBe(false);
		expect(
			skillSourceRecordSchema.safeParse({
				...source,
				future: { callback: () => null },
			}).success
		).toBe(false);
	});
	test("retains and validates original own prototype-named metadata", () => {
		const valid = Object.defineProperty({ ...source }, "__proto__", {
			value: { revision: 2 },
			enumerable: true,
		});
		expect(skillSourceRecordSchema.parse(valid)).toBe(valid);
		const invalid = Object.defineProperty({ ...source }, "__proto__", {
			value: () => null,
			enumerable: true,
		});
		expect(skillSourceRecordSchema.safeParse(invalid).success).toBe(false);
	});
	test("all privileged source/write/version readbacks use the complete owner codecs", async () => {
		const capabilities: Set<Capability> = new Set(["skills.crud"]);
		const versions = [version];
		const services: HostServices = {
			listAgents: async () => [],
			registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
			skillsGetSource: async () => source,
			skillsCreate: async () => written,
			skillsUpdate: async () => written,
			skillsListVersions: async () => versions,
		};
		expect(
			await dispatchRpc(
				"skills.getSource",
				[{ id: "skill" }],
				capabilities,
				services
			)
		).toBe(source);
		expect(
			await dispatchRpc(
				"skills.create",
				[{ name: "Skill", body: "Body" }],
				capabilities,
				services
			)
		).toBe(written);
		expect(
			await dispatchRpc(
				"skills.update",
				[{ id: "skill", name: "Skill", body: "Body" }],
				capabilities,
				services
			)
		).toBe(written);
		expect(
			await dispatchRpc(
				"skills.listVersions",
				[{ id: "skill" }],
				capabilities,
				services
			)
		).toBe(versions);
		await expect(
			dispatchRpc(
				"skills.create",
				[{ name: "Skill", body: "Body" }],
				capabilities,
				{
					...services,
					skillsCreate: async () => ({
						...written,
						future: { callback: () => null },
					}),
				}
			)
		).rejects.toThrow();
	});
});
