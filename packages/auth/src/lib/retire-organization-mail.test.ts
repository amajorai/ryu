import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	EmailAddressReservation,
	EmailAlias,
	EmailWebhook,
	Inbox,
} from "@ryu/db/models/email.model";
import {
	ORGANIZATION_DELETED_REASON,
	retireOrganizationMail,
} from "./retire-organization-mail.ts";

const now = new Date("2026-10-18T12:00:00.000Z");
const calls: { model: string; filter: unknown; update: unknown }[] = [];
const counts: Record<string, number> = {
	Inbox: 2,
	EmailAlias: 3,
	EmailAddressReservation: 5,
	EmailWebhook: 1,
};

const models = {
	Inbox,
	EmailAlias,
	EmailAddressReservation,
	EmailWebhook,
} as const;
const spies: { mockRestore(): void }[] = [];
for (const [name, model] of Object.entries(models)) {
	spies.push(
		spyOn(model, "updateMany").mockImplementation((async (
			filter: unknown,
			update: unknown
		) => {
			calls.push({ model: name, filter, update });
			return { acknowledged: true, modifiedCount: counts[name] ?? 0 };
		}) as never)
	);
	// Retirement must never delete anything: every name stays reserved.
	for (const method of [
		"deleteOne",
		"deleteMany",
		"findOneAndDelete",
		"findByIdAndDelete",
	] as const) {
		spies.push(
			spyOn(model, method).mockImplementation((() => {
				throw new Error(`${name}.${method} must not be called`);
			}) as never)
		);
	}
}

beforeEach(() => {
	calls.length = 0;
});
afterAll(() => {
	for (const spy of spies) {
		spy.mockRestore();
	}
});

describe("retireOrganizationMail", () => {
	test("disables inboxes, revokes live aliases, orphans reservations, disables webhooks", async () => {
		expect(await retireOrganizationMail("org-1", now)).toEqual({
			inboxes: 2,
			aliases: 3,
			reservations: 5,
			webhooks: 1,
		});
		expect(calls).toEqual([
			{
				model: "Inbox",
				filter: { organizationId: "org-1", enabled: true },
				update: { $set: { enabled: false, updatedAt: now } },
			},
			{
				model: "EmailAlias",
				filter: {
					organizationId: "org-1",
					status: { $in: ["active", "pending"] },
				},
				update: {
					$set: {
						status: "revoked",
						revokedAt: now,
						revokedBy: null,
						revokeReason: "organization_deleted",
						reinstatableUntil: null,
						pendingExpiresAt: null,
						liveAgentKey: null,
						aliasSlot: null,
						updatedAt: now,
					},
				},
			},
			{
				model: "EmailAddressReservation",
				filter: { ownerKey: "org:org-1", state: "live" },
				update: {
					$set: {
						state: "orphaned",
						orphanedAt: now,
						orphanReason: "organization_deleted",
					},
				},
			},
			{
				model: "EmailWebhook",
				filter: { organizationId: "org-1", enabled: true },
				update: { $set: { enabled: false, updatedAt: now } },
			},
		]);
		expect(ORGANIZATION_DELETED_REASON).toBe("organization_deleted");
	});

	test("never touches a revoked alias, so its history stays as it was", async () => {
		await retireOrganizationMail("org-1", now);
		const aliasCall = calls.find((call) => call.model === "EmailAlias");
		expect(JSON.stringify(aliasCall?.filter)).not.toContain("revoked");
	});

	test("refuses an empty organization id rather than matching personal mail", async () => {
		await expect(retireOrganizationMail("", now)).rejects.toThrow(
			"requires an organization id"
		);
		expect(calls).toEqual([]);
	});
});
