import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { User } from "@ryu/db/models/auth.model";
import {
	creditPendingReferral,
	creditReferrerAtSignup,
} from "./referral-credit.ts";

/**
 * The waitlist ranks referrers by `referralCount`. A throwaway, never
 * verified sign-up must not move its referrer up the queue, and a verified one
 * must count exactly once however many verification hooks fire.
 */

interface UserRow {
	emailVerified: boolean;
	referralCode: string;
	referralCount: number;
	referralCreditPending?: boolean;
	referredBy?: string;
}

interface UserFilter {
	_id?: string;
	emailVerified?: boolean;
	referralCode?: string;
	referralCreditPending?: boolean;
}

const users = new Map<string, UserRow>();
const spies: { mockRestore: () => void }[] = [];

function find(filter: UserFilter): UserRow | undefined {
	return [...users.entries()].find(
		([id, row]) =>
			(filter._id === undefined || id === filter._id) &&
			(filter.emailVerified === undefined ||
				row.emailVerified === filter.emailVerified) &&
			(filter.referralCode === undefined ||
				row.referralCode === filter.referralCode) &&
			(filter.referralCreditPending === undefined ||
				row.referralCreditPending === filter.referralCreditPending)
	)?.[1];
}

function count(referralCode: string): number {
	return find({ referralCode })?.referralCount ?? 0;
}

beforeEach(() => {
	users.clear();
	users.set("referrer", {
		emailVerified: true,
		referralCode: "REFCODE",
		referralCount: 0,
	});
	spies.push(
		spyOn(User, "updateOne").mockImplementation(((
			filter: UserFilter,
			update: {
				$inc?: { referralCount: number };
				$set?: Partial<UserRow>;
			}
		) => {
			const row = find(filter);
			if (row) {
				Object.assign(row, update.$set ?? {});
				row.referralCount += update.$inc?.referralCount ?? 0;
			}
			return Promise.resolve({ modifiedCount: row ? 1 : 0 });
		}) as never),
		spyOn(User, "findOneAndUpdate").mockImplementation(((
			filter: UserFilter,
			update: { $unset?: { referralCreditPending?: 1 } }
		) => {
			const row = find(filter);
			const before = row ? { ...row } : null;
			if (row && update.$unset?.referralCreditPending) {
				row.referralCreditPending = undefined;
			}
			// Mongoose returns the pre-update document by default.
			return { lean: () => Promise.resolve(before) };
		}) as never)
	);
});

afterEach(() => {
	for (const spy of spies.splice(0)) {
		spy.mockRestore();
	}
});

function addReferee(
	id: string,
	row: Partial<UserRow> & { emailVerified: boolean }
): void {
	users.set(id, {
		referralCode: `${id.toUpperCase()}CODE`,
		referralCount: 0,
		referredBy: "REFCODE",
		...row,
	});
}

describe("referral credit", () => {
	it("does not credit an unverified referee at sign-up", async () => {
		addReferee("throwaway", { emailVerified: false });
		await creditReferrerAtSignup({
			emailVerified: false,
			id: "throwaway",
			referredBy: "REFCODE",
		});

		expect(count("REFCODE")).toBe(0);
		expect(users.get("throwaway")?.referralCreditPending).toBe(true);
		// Never verified: no hook fires, and a stray call still cannot credit.
		await creditPendingReferral("throwaway");
		expect(count("REFCODE")).toBe(0);
	});

	it("credits exactly once when the referee verifies", async () => {
		addReferee("referee", { emailVerified: false });
		await creditReferrerAtSignup({
			emailVerified: false,
			id: "referee",
			referredBy: "REFCODE",
		});
		const referee = users.get("referee");
		if (referee) {
			referee.emailVerified = true;
		}

		// `afterEmailVerification` and `user.update.after` can both fire.
		await creditPendingReferral("referee");
		await creditPendingReferral("referee");

		expect(count("REFCODE")).toBe(1);
		expect(users.get("referee")?.referralCreditPending).toBeUndefined();
	});

	it("credits a referee who signed up already verified, with no marker", async () => {
		addReferee("social", { emailVerified: true });
		await creditReferrerAtSignup({
			emailVerified: true,
			id: "social",
			referredBy: "REFCODE",
		});
		await creditPendingReferral("social");

		expect(count("REFCODE")).toBe(1);
		expect(users.get("social")?.referralCreditPending).toBeUndefined();
	});

	it("never re-credits a referee counted before the marker existed", async () => {
		// Counted at sign-up under the old rule; verifies (or changes email) later.
		addReferee("legacy", { emailVerified: true });
		await creditPendingReferral("legacy");

		expect(count("REFCODE")).toBe(0);
	});

	it("ignores a missing or unknown referral code", async () => {
		addReferee("nobody", { emailVerified: true, referredBy: undefined });
		await creditReferrerAtSignup({ emailVerified: true, id: "nobody" });
		await creditReferrerAtSignup({
			emailVerified: true,
			id: "nobody",
			referredBy: "",
		});
		await creditReferrerAtSignup({
			emailVerified: true,
			id: "nobody",
			referredBy: "UNKNOWN",
		});

		expect(count("REFCODE")).toBe(0);
		expect(users.get("nobody")?.referralCreditPending).toBeUndefined();
	});
});
