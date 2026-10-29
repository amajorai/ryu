import { beforeEach, expect, mock, test } from "bun:test";

interface AttemptRow {
	count: number;
	expiresAt: Date;
	scope: string;
	sessionId: string;
	verifiedAt?: Date;
}

interface AttemptFilter {
	count?: { $lt: number };
	expiresAt?: { $lte: Date };
	scope: string;
	sessionId: string;
}

interface AttemptUpdate {
	$inc: { count: number };
	$max: { expiresAt: Date };
	$unset: { verifiedAt: "" };
}

const rows = new Map<string, AttemptRow>();
let upserts = 0;

const key = (filter: { scope: string; sessionId: string }) =>
	`${filter.sessionId}:${filter.scope}`;

/** Yield so concurrent callers interleave the way they would against Mongo. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function duplicateKey(): Error {
	return Object.assign(new Error("E11000 duplicate key"), { code: 11_000 });
}

function apply(row: AttemptRow, update: AttemptUpdate): AttemptRow {
	row.count += update.$inc.count;
	if (update.$max.expiresAt > row.expiresAt) {
		row.expiresAt = update.$max.expiresAt;
	}
	row.verifiedAt = undefined;
	return { ...row };
}

/**
 * The unique {sessionId, scope} index, with a gap between the upsert's miss and
 * its insert so two first attempts can race the way they do in Mongo.
 */
async function findOneAndUpdate(
	filter: AttemptFilter,
	update: AttemptUpdate,
	options: { upsert?: boolean }
): Promise<AttemptRow | null> {
	await tick();
	const row = rows.get(key(filter));
	if (row && (!filter.count || row.count < filter.count.$lt)) {
		return apply(row, update);
	}
	if (!options.upsert) {
		return null;
	}
	upserts += 1;
	await tick();
	if (rows.has(key(filter))) {
		throw duplicateKey();
	}
	const inserted: AttemptRow = {
		count: update.$inc.count,
		expiresAt: update.$max.expiresAt,
		scope: filter.scope,
		sessionId: filter.sessionId,
	};
	rows.set(key(filter), inserted);
	return { ...inserted };
}

mock.module("@ryu/db/models/step-up.model", () => ({
	StepUpAttempt: {
		deleteOne: async (filter: AttemptFilter) => {
			await tick();
			const row = rows.get(key(filter));
			const lapsed =
				row &&
				(!filter.expiresAt ||
					row.expiresAt.getTime() <= filter.expiresAt.$lte.getTime());
			if (lapsed) {
				rows.delete(key(filter));
			}
			return { deletedCount: lapsed ? 1 : 0 };
		},
		findOneAndUpdate: (
			filter: AttemptFilter,
			update: AttemptUpdate,
			options: { upsert?: boolean }
		) => ({ lean: () => findOneAndUpdate(filter, update, options) }),
	},
	StepUpChallenge: {},
	StepUpGrant: {},
}));

mock.module("@ryu/email", () => ({
	StepUpMagicLinkEmail: () => null,
	StepUpOTPEmail: () => null,
	sendEmail: async () => undefined,
}));

const { clearStepUpFailures, reserveStepUpAttempt } = await import(
	"./step-up.ts"
);

beforeEach(() => {
	rows.clear();
	upserts = 0;
});

test("a concurrent burst reserves at most five attempts per session and scope", async () => {
	const results = await Promise.all(
		Array.from({ length: 30 }, () =>
			reserveStepUpAttempt("burst-session", "org.delete")
		)
	);
	const reserved = results.filter((result) => result.ok);
	expect(reserved).toHaveLength(5);
	// Exactly one reservation is told it took the last attempt.
	expect(reserved.filter((result) => result.spent)).toHaveLength(1);
	expect(results.filter((result) => !result.ok)).toHaveLength(25);
	expect(rows.get("burst-session:org.delete")?.count).toBe(5);
	// Racing first inserts collided on the unique key and still counted.
	expect(upserts).toBeGreaterThan(1);
});

test("budgets are per scope, and a success clears the count", async () => {
	for (let index = 0; index < 5; index += 1) {
		await reserveStepUpAttempt("scoped-session", "billing");
	}
	expect(await reserveStepUpAttempt("scoped-session", "billing")).toEqual({
		ok: false,
		spent: true,
	});
	expect(await reserveStepUpAttempt("scoped-session", "org.delete")).toEqual({
		ok: true,
		spent: false,
	});
	await clearStepUpFailures("scoped-session", "billing");
	expect(await reserveStepUpAttempt("scoped-session", "billing")).toEqual({
		ok: true,
		spent: false,
	});
});

test("a lapsed window grants a fresh budget", async () => {
	rows.set("lapsed-session:billing", {
		count: 5,
		expiresAt: new Date(Date.now() - 1),
		scope: "billing",
		sessionId: "lapsed-session",
	});
	expect(await reserveStepUpAttempt("lapsed-session", "billing")).toEqual({
		ok: true,
		spent: false,
	});
	expect(rows.get("lapsed-session:billing")?.count).toBe(1);
});

test("an attempt invalidates an unspent account-security proof", async () => {
	rows.set("proof-session:account.security", {
		count: 0,
		expiresAt: new Date(Date.now() + 60_000),
		scope: "account.security",
		sessionId: "proof-session",
		verifiedAt: new Date(),
	});
	await reserveStepUpAttempt("proof-session", "account.security");
	expect(
		rows.get("proof-session:account.security")?.verifiedAt
	).toBeUndefined();
});
