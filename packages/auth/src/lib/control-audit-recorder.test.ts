import { describe, expect, it, mock } from "bun:test";
import { runWithRequestState } from "@better-auth/core/context";

const directWrites: object[] = [];
mock.module("@ryu/db/models/control-audit.model", () => ({
	ControlAuditEvent: {
		create: (row: object) => {
			directWrites.push(row);
			return Promise.resolve(row);
		},
	},
}));

const {
	organizationAuditDetails,
	recordOrganizationControlAudit,
	registerControlAuditRecorder,
	rememberMemberRoleBeforeUpdate,
} = await import("./control-audit-recorder.ts");
type ControlAuditRecord = Parameters<typeof recordOrganizationControlAudit>[0];

const ORG = "0000000000000000000000a1";
const row: ControlAuditRecord = {
	action: "member.role.update",
	actorId: "user_admin",
	actorType: "user",
	details: { method: "POST", status: "success" },
	organizationId: ORG,
	target: "member",
	targetId: "member_1",
};

/**
 * The org audit rows for Better Auth's member, invitation and team mutations
 * must go through the API's writer, which also queues the org's SIEM stream.
 *
 * THE SLOT IS MODULE STATE and nothing unregisters it, so the unregistered
 * case is asserted FIRST.
 */
describe("recordOrganizationControlAudit", () => {
	it("still writes the audit row when no writer is registered", async () => {
		await recordOrganizationControlAudit(row);
		expect(directWrites).toEqual([row]);
	});

	it("sends every row to the registered writer instead of the collection", async () => {
		directWrites.length = 0;
		const streamed: ControlAuditRecord[] = [];
		registerControlAuditRecorder((record) => {
			streamed.push(record);
			return Promise.resolve();
		});

		await recordOrganizationControlAudit(row);

		expect(streamed).toEqual([row]);
		expect(directWrites).toEqual([]);
	});

	it("rejects when the writer fails, so the caller's catch decides", async () => {
		registerControlAuditRecorder(() =>
			Promise.reject(new Error("audit store unavailable"))
		);
		await expect(recordOrganizationControlAudit(row)).rejects.toThrow(
			"audit store unavailable"
		);
	});
});

describe("organizationAuditDetails", () => {
	it("records the previous and new role of a member role update", async () => {
		const details = await runWithRequestState(new WeakMap(), async () => {
			await rememberMemberRoleBeforeUpdate("member_1", "member");
			return await organizationAuditDetails({
				memberId: "member_1",
				method: "POST",
				path: "/organization/update-member-role",
				role: "owner",
			});
		});
		expect(details).toEqual({
			method: "POST",
			newRole: "owner",
			previousRole: "member",
			status: "success",
		});
	});

	it("does not attribute another member's previous role", async () => {
		const details = await runWithRequestState(new WeakMap(), async () => {
			await rememberMemberRoleBeforeUpdate("member_2", "admin");
			return await organizationAuditDetails({
				memberId: "member_1",
				method: "POST",
				path: "/organization/update-member-role",
				role: "owner",
			});
		});
		expect(details.previousRole).toBeNull();
	});

	it("does not carry a previous role across requests", async () => {
		await runWithRequestState(new WeakMap(), async () => {
			await rememberMemberRoleBeforeUpdate("member_1", "member");
		});
		const details = await runWithRequestState(new WeakMap(), async () =>
			organizationAuditDetails({
				memberId: "member_1",
				method: "POST",
				path: "/organization/update-member-role",
				role: "owner",
			})
		);
		expect(details.previousRole).toBeNull();
	});

	it("records the granted role of an invitation", async () => {
		expect(
			await organizationAuditDetails({
				memberId: undefined,
				method: "POST",
				path: "/organization/invite-member",
				role: "admin",
			})
		).toEqual({ method: "POST", role: "admin", status: "success" });
	});

	it("keeps other mutations to method and outcome", async () => {
		expect(
			await organizationAuditDetails({
				memberId: "member_1",
				method: "POST",
				path: "/organization/remove-member",
				role: "owner",
			})
		).toEqual({ method: "POST", status: "success" });
	});
});
