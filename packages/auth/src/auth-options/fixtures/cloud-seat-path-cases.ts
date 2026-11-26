import { afterAll, beforeEach, describe, expect, it } from "bun:test";

/** The organization the cloud cases use and the test's license names. */
export const CLOUD_LICENSED_TEAM = "64b0000000000000000000c1";

/**
 * The hosted cloud's seat path must be exactly what it was before the
 * self-hosted member limit existed. These cases run once with
 * `RYU_DEPLOYMENT_MODE` not set (what the hosted cloud runs with) and once
 * with it set to `cloud`; both times a license that states 50 seats is
 * configured, to show that neither the license nor a missing Polar
 * subscription switches the self-hosted rules on.
 *
 * The caller configures the process env and then calls this, because the env
 * module reads the process env once, when it is first imported.
 */
export async function describeCloudSeatPath(label: string): Promise<void> {
	const {
		addOrganization,
		customerLookup,
		join,
		membersOf,
		person,
		resetSeatPath,
		restoreSeatPath,
		seatPath,
	} = await import("./seat-path.ts");
	const { TEAMS_SEAT_COPY } = await import("../../lib/family-admission.ts");
	const { isSelfHostedDeployment } = await import(
		"../../lib/deployment-mode.ts"
	);
	const { organizationAdmission } = await import("../admission.ts");
	const { activeOrganizationSeatCapacity, activeTeamsSeatCount } = await import(
		"../seat-capacity.ts"
	);

	const TEAM = CLOUD_LICENSED_TEAM;
	const NO_PLAN = { message: TEAMS_SEAT_COPY.noCapacity };

	/** The body of the error a refused join throws. */
	async function refusalBody(run: () => Promise<unknown>): Promise<unknown> {
		let body: unknown = null;
		let refused = false;
		try {
			await run();
		} catch (error) {
			refused = true;
			body = (error as { body?: unknown }).body;
		}
		if (!refused) {
			throw new Error("Expected the join to be refused, but it was admitted");
		}
		return body;
	}

	describe(`hosted cloud seat path (${label})`, () => {
		beforeEach(() => {
			resetSeatPath();
			// One member, far below three: only the missing plan can refuse a join.
			addOrganization(TEAM, "teams", ["owner"]);
		});
		afterAll(() => {
			restoreSeatPath();
		});

		it("is not a self-hosted deployment", () => {
			expect(isSelfHostedDeployment()).toBe(false);
		});

		it("resolves capacity from Polar, with the two fields it always had", async () => {
			const capacity = await activeOrganizationSeatCapacity(TEAM);
			expect(capacity).toStrictEqual({ kind: "teams", seatCapacity: null });
			expect(Object.keys(capacity).sort()).toEqual(["kind", "seatCapacity"]);
			expect(customerLookup).toHaveBeenCalledTimes(1);
			expect(seatPath.installReads).toBe(0);
		});

		it("still refuses an invitation without a plan, with the Teams copy and no code", async () => {
			expect(
				await refusalBody(() =>
					join.invite(TEAM, person("owner"), "new@acme.example")
				)
			).toStrictEqual(NO_PLAN);
			expect(seatPath.reservations).toHaveLength(0);
			expect(seatPath.installReads).toBe(0);
		});

		it("still refuses an acceptance without a plan", async () => {
			expect(
				await refusalBody(() =>
					join.accept(TEAM, "invitation-1", person("new"))
				)
			).toStrictEqual(NO_PLAN);
			expect(membersOf(TEAM)).toEqual(["owner"]);
			expect(seatPath.installReads).toBe(0);
		});

		it("still refuses a direct add without a plan", async () => {
			expect(
				await refusalBody(() => join.directAdd(TEAM, person("new")))
			).toStrictEqual(NO_PLAN);
			expect(membersOf(TEAM)).toEqual(["owner"]);
			expect(seatPath.installReads).toBe(0);
		});

		it("still refuses an SSO join without a plan", async () => {
			const outcome = await join.sso(TEAM, person("new"));
			expect(outcome.kind).toBe("refused");
			if (outcome.kind === "refused") {
				expect((outcome.error as { body?: unknown }).body).toStrictEqual(
					NO_PLAN
				);
			}
			expect(membersOf(TEAM)).toEqual(["owner"]);
			expect(seatPath.installReads).toBe(0);
		});

		it("still reports no paid capacity, so deletion needs no plan cancellation", async () => {
			expect(await activeTeamsSeatCount(TEAM)).toBeNull();
			await organizationAdmission.beforeDeleteOrganization({
				organization: { id: TEAM },
			});
			expect(seatPath.installReads).toBe(0);
		});
	});
}
