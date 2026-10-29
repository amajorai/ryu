import { describe, expect, it } from "bun:test";
import {
	ryuOrganizationAccessControl,
	ryuOrganizationRoles,
} from "./organization-access.ts";

describe("Ryu Better Auth organization access", () => {
	it("keeps API-key management separate from Ryu capability scopes", () => {
		expect(ryuOrganizationAccessControl.statements).not.toHaveProperty("chat");
		expect(ryuOrganizationAccessControl.statements).toMatchObject({
			apiKey: ["create", "read", "update", "delete"],
		});
	});

	it("leaves key records to admins and owners, never members or viewers", () => {
		// Org key listing is Ryu's gateway.configure; Better Auth's native
		// list/get must not expose the org key inventory to plain members.
		expect(ryuOrganizationRoles.member.statements.apiKey).toEqual([]);
		expect(ryuOrganizationRoles.admin.statements.apiKey).toEqual([
			"create",
			"read",
			"update",
			"delete",
		]);
		expect(ryuOrganizationRoles.owner.statements.apiKey).toEqual([
			"create",
			"read",
			"update",
			"delete",
		]);
		expect(ryuOrganizationRoles.viewer.statements.apiKey).toEqual([]);
	});

	it("keeps viewers read-only for organization management", () => {
		// Better Auth's member statements grant no organization, member,
		// invitation or team writes, so reusing them for viewer is read-only. Pin
		// that so an upstream change cannot silently widen the viewer role.
		const viewer = ryuOrganizationRoles.viewer.statements;
		for (const resource of [
			"organization",
			"member",
			"invitation",
			"team",
		] as const) {
			expect(viewer[resource] ?? []).toEqual([]);
		}
		expect(viewer.ac).toEqual(["read"]);
	});

	it("keeps the billing role free of org-management and key authority", () => {
		const billing = ryuOrganizationRoles.billing.statements;
		for (const resource of [
			"organization",
			"member",
			"invitation",
			"team",
		] as const) {
			expect(billing[resource] ?? []).toEqual([]);
		}
		expect(billing.apiKey).toEqual([]);
	});
});
