import { beforeEach, describe, expect, it, mock } from "bun:test";

interface Write {
	filter: Record<string, unknown>;
	model: string;
	options: Record<string, unknown>;
	update: { $set: Record<string, unknown> };
}

let writes: Write[] = [];
let enrollmentIds: string[] = [];
const distinctSessions: unknown[] = [];

function recorder(model: string) {
	return {
		distinct: () => {
			const query = {
				session: (session: unknown) => {
					distinctSessions.push(session);
					return query;
				},
				// biome-ignore lint/suspicious/noThenProperty: mirrors a Mongoose query
				then: (resolve: (value: string[]) => unknown) =>
					Promise.resolve(enrollmentIds).then(resolve),
			};
			return query;
		},
		updateMany: (
			filter: Record<string, unknown>,
			update: { $set: Record<string, unknown> },
			options: Record<string, unknown>
		) => {
			writes.push({ filter, model, options, update });
			return Promise.resolve({ acknowledged: true, modifiedCount: 1 });
		},
	};
}

mock.module("@ryu/db/models/control-plane.model", () => ({
	GatewayCredential: recorder("GatewayCredential"),
}));
mock.module("@ryu/db/models/fleet.model", () => ({
	FleetEnrollmentToken: recorder("FleetEnrollmentToken"),
	ManagedNode: recorder("ManagedNode"),
}));

const { revokeDepartedMemberNodeCredentials } = await import(
	"./departed-member-node-credentials.ts"
);

const ORG = "0000000000000000000000a1";
const USER = "0000000000000000000000b1";

beforeEach(() => {
	writes = [];
	enrollmentIds = [];
	distinctSessions.length = 0;
});

describe("revokeDepartedMemberNodeCredentials", () => {
	it("revokes journals first, then the member's personal nodes and keys", async () => {
		const now = new Date("2026-10-23T00:00:00Z");
		await revokeDepartedMemberNodeCredentials({
			now,
			organizationId: ORG,
			userId: USER,
		});
		expect(writes.map((write) => write.model).slice(0, 3)).toEqual([
			"FleetEnrollmentToken",
			"ManagedNode",
			"GatewayCredential",
		]);
		expect(writes[0]?.filter).toEqual({
			organizationId: ORG,
			ownerUserId: USER,
			state: { $ne: "revoked" },
		});
		expect(writes[0]?.update.$set).toMatchObject({
			recoveryResponseSealed: null,
			revokedAt: now,
			state: "revoked",
		});
		for (const write of writes.slice(1, 3)) {
			// Scoped to this org and owner: org and team nodes, and the same
			// person's nodes in other organizations, are untouched.
			expect(write.filter).toEqual({
				organizationId: ORG,
				ownerUserId: USER,
				revokedAt: null,
			});
			expect(write.update.$set).toEqual({ revokedAt: now, updatedAt: now });
		}
	});

	it("passes the caller's transaction session to every write", async () => {
		const session = { id: "session_1" };
		enrollmentIds = ["enr_1"];
		await revokeDepartedMemberNodeCredentials({
			organizationId: ORG,
			// SAFETY: the recorder only compares identity; no driver call is made.
			session: session as never,
			userId: USER,
		});
		expect(writes).toHaveLength(6);
		for (const write of writes) {
			expect(write.options.session).toBe(session);
		}
		expect(distinctSessions).toEqual([session]);
	});

	it("also revokes org-wide and team nodes the member enrolled", async () => {
		const now = new Date("2026-10-23T00:00:00Z");
		enrollmentIds = ["enr_1", "enr_2"];
		await revokeDepartedMemberNodeCredentials({
			now,
			organizationId: ORG,
			userId: USER,
		});
		expect(writes.slice(3).map((write) => write.model)).toEqual([
			"FleetEnrollmentToken",
			"ManagedNode",
			"GatewayCredential",
		]);
		const enroller = {
			createdBy: USER,
			organizationId: ORG,
			ownerUserId: null,
		};
		expect(writes[3]?.filter).toEqual({
			...enroller,
			state: { $ne: "revoked" },
		});
		expect(writes[4]?.filter).toEqual({
			enrollmentId: { $in: ["enr_1", "enr_2"] },
			organizationId: ORG,
			revokedAt: null,
		});
		// Cloud-provisioned servers and service-account keys outlive their
		// creator, and another member's personal node has an owner: none match.
		expect(writes[5]?.filter).toEqual({
			...enroller,
			provisionedServerId: null,
			revokedAt: null,
			serviceAccountId: null,
		});
		expect(writes[5]?.update.$set).toEqual({ revokedAt: now, updatedAt: now });
	});

	it("skips the node projection when the member enrolled no journals", async () => {
		await revokeDepartedMemberNodeCredentials({
			organizationId: ORG,
			userId: USER,
		});
		expect(writes.map((write) => write.model)).toEqual([
			"FleetEnrollmentToken",
			"ManagedNode",
			"GatewayCredential",
			"FleetEnrollmentToken",
			"GatewayCredential",
		]);
	});

	it("never issues an unscoped write for a blank id", async () => {
		await revokeDepartedMemberNodeCredentials({
			organizationId: ORG,
			userId: "  ",
		});
		await revokeDepartedMemberNodeCredentials({
			organizationId: "",
			userId: USER,
		});
		expect(writes).toEqual([]);
	});
});
