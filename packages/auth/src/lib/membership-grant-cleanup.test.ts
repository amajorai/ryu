import { beforeEach, describe, expect, it, mock } from "bun:test";

let deletes: Record<string, unknown>[] = [];
let bindingDeletes: Record<string, unknown>[] = [];
let audits: Record<string, unknown>[] = [];
let deleteFails = false;
let bindingDeleteFails = false;

mock.module("@ryu/db/models/control-plane.model", () => ({
	RoleAssignment: {
		deleteMany: (filter: Record<string, unknown>) => {
			if (deleteFails) {
				return Promise.reject(new Error("write conflict"));
			}
			deletes.push(filter);
			return Promise.resolve({ deletedCount: 1 });
		},
	},
}));
mock.module("@ryu/db/models/vault.model", () => ({
	VaultPolicyBinding: {
		deleteMany: (filter: Record<string, unknown>) => {
			if (bindingDeleteFails) {
				return Promise.reject(new Error("write conflict"));
			}
			bindingDeletes.push(filter);
			return Promise.resolve({ deletedCount: 1 });
		},
	},
}));
mock.module("@ryu/db/models/control-audit.model", () => ({
	ControlAuditEvent: {
		create: (row: Record<string, unknown>) => {
			audits.push(row);
			return Promise.resolve(row);
		},
	},
}));

const { clearPriorMembershipGrants } = await import(
	"./membership-grant-cleanup.ts"
);

const ORG = "0000000000000000000000a1";
const USER = "0000000000000000000000b1";

beforeEach(() => {
	deletes = [];
	bindingDeletes = [];
	audits = [];
	deleteFails = false;
	bindingDeleteFails = false;
});

describe("clearPriorMembershipGrants", () => {
	it("deletes only grants written before the new membership began", async () => {
		const createdAt = new Date("2026-10-01T00:00:00Z");
		await clearPriorMembershipGrants({
			createdAt,
			organizationId: ORG,
			userId: USER,
		});
		expect(deletes).toEqual([
			{ createdAt: { $lt: createdAt }, organizationId: ORG, userId: USER },
		]);
		expect(bindingDeletes).toEqual([
			{
				createdAt: { $lt: createdAt },
				organizationId: ORG,
				subject: `user:${USER}`,
			},
		]);
		expect(audits).toEqual([]);
	});

	it("leaves vault bindings alone for a legacy member row without createdAt", async () => {
		await clearPriorMembershipGrants({ organizationId: ORG, userId: USER });
		expect(bindingDeletes).toEqual([]);
	});

	it("records a vault-binding failure audit row when that cleanup fails", async () => {
		bindingDeleteFails = true;
		await clearPriorMembershipGrants({
			createdAt: new Date(),
			organizationId: ORG,
			userId: USER,
		});
		expect(deletes).toHaveLength(1);
		expect(audits).toEqual([
			{
				action: "member.grants.revoke",
				actorId: null,
				actorType: "system",
				details: {
					grant: "vault_bindings",
					phase: "add",
					status: "failure",
					userId: USER,
				},
				organizationId: ORG,
				target: "member",
				targetId: USER,
			},
		]);
	});

	it("never throws and records a failure audit row when cleanup fails", async () => {
		deleteFails = true;
		await clearPriorMembershipGrants({
			createdAt: new Date(),
			organizationId: ORG,
			userId: USER,
		});
		expect(audits).toEqual([
			{
				action: "member.grants.revoke",
				actorId: null,
				actorType: "system",
				details: { phase: "add", status: "failure", userId: USER },
				organizationId: ORG,
				target: "member",
				targetId: USER,
			},
		]);
	});
});
