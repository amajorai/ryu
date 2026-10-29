import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";

// Two verifications of one mailbox challenge are forced to read the same
// stored snapshot before either of them consumes it, which is the interleaving
// that let both succeed when the consume ignored whether it deleted a row.
// The in-memory store applies each filter the way Mongo does, including the
// `_id`/`codeHash`/`expiresAt` conditions of the consuming delete.

interface ChallengeRow {
	_id: string;
	attempts: number;
	challengeType: "magic-link" | "otp";
	codeHash: string;
	expiresAt: Date;
	scope: string;
	sessionId: string;
}

interface ChallengeFilter {
	_id?: string;
	attempts?: { $lt: number };
	challengeType?: string;
	codeHash?: string;
	expiresAt?: { $gt?: Date; $lte?: Date };
	scope?: string;
	sessionId?: string;
}

let stored: ChallengeRow | null = null;
let deletes = 0;

function matches(row: ChallengeRow, filter: ChallengeFilter): boolean {
	return (
		(filter._id === undefined || row._id === filter._id) &&
		(filter.challengeType === undefined ||
			row.challengeType === filter.challengeType) &&
		(filter.codeHash === undefined || row.codeHash === filter.codeHash) &&
		(filter.scope === undefined || row.scope === filter.scope) &&
		(filter.sessionId === undefined || row.sessionId === filter.sessionId) &&
		(filter.attempts === undefined || row.attempts < filter.attempts.$lt) &&
		(filter.expiresAt?.$gt === undefined ||
			row.expiresAt.getTime() > filter.expiresAt.$gt.getTime()) &&
		(filter.expiresAt?.$lte === undefined ||
			row.expiresAt.getTime() <= filter.expiresAt.$lte.getTime())
	);
}

/**
 * Hold every challenge read until two have been taken, so both verifiers act
 * on the same snapshot. Released after a short bound so a single caller (the
 * loser's explanatory re-read) never hangs.
 */
let waiting: (() => void)[] = [];
async function afterBothRead<Result>(result: Result): Promise<Result> {
	await new Promise<void>((resolve) => {
		waiting.push(resolve);
		if (waiting.length >= 2) {
			for (const release of waiting) {
				release();
			}
			waiting = [];
			return;
		}
		setTimeout(() => {
			waiting = waiting.filter((entry) => entry !== resolve);
			resolve();
		}, 200);
	});
	return result;
}

mock.module("@ryu/db/models/step-up.model", () => ({
	StepUpAttempt: {},
	StepUpGrant: {},
	StepUpChallenge: {
		findOne: (filter: ChallengeFilter) =>
			afterBothRead(stored && matches(stored, filter) ? { ...stored } : null),
		findOneAndUpdate: (
			filter: ChallengeFilter,
			update: { $inc: { attempts: number } }
		) => {
			if (!(stored && matches(stored, filter))) {
				return afterBothRead(null);
			}
			stored.attempts += update.$inc.attempts;
			return afterBothRead({ ...stored });
		},
		deleteOne: async (filter: ChallengeFilter) => {
			await Promise.resolve();
			if (!(stored && matches(stored, filter))) {
				return { deletedCount: 0 };
			}
			stored = null;
			deletes += 1;
			return { deletedCount: 1 };
		},
	},
}));

mock.module("@ryu/email", () => ({
	StepUpMagicLinkEmail: () => null,
	StepUpOTPEmail: () => null,
	sendEmail: async () => undefined,
}));

const { verifyStepUpChallenge, verifyStepUpMagicLink } = await import(
	"./step-up.ts"
);

const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");

function seed(challengeType: ChallengeRow["challengeType"], secret: string) {
	deletes = 0;
	waiting = [];
	stored = {
		_id: `challenge-${challengeType}`,
		attempts: 0,
		challengeType,
		codeHash: digest(secret),
		expiresAt: new Date(Date.now() + 60_000),
		scope: "account.security",
		sessionId: "session",
	};
}

test("two OTP verifications of one stored snapshot yield exactly one success", async () => {
	seed("otp", "123456");
	const verify = () =>
		verifyStepUpChallenge({
			code: "123456",
			scope: "account.security",
			sessionId: "session",
		});
	const results = await Promise.all([verify(), verify()]);
	expect(results.filter((result) => result.ok)).toHaveLength(1);
	expect(results.filter((result) => !result.ok)).toEqual([
		{ ok: false, reason: "no-challenge" },
	]);
	expect(deletes).toBe(1);
	expect(stored).toBeNull();
});

test("two magic-link verifications of one stored snapshot yield exactly one success", async () => {
	seed("magic-link", "mailbox-token");
	const verify = () =>
		verifyStepUpMagicLink({
			scope: "account.security",
			sessionId: "session",
			token: "mailbox-token",
		});
	const results = await Promise.all([verify(), verify()]);
	expect(results.filter((result) => result.ok)).toHaveLength(1);
	expect(results.filter((result) => !result.ok)).toEqual([
		{ ok: false, reason: "no-challenge" },
	]);
	expect(deletes).toBe(1);
	expect(stored).toBeNull();
});

test("a verifier holding a snapshot that a resend replaced cannot consume the new code", async () => {
	seed("magic-link", "first-token");
	const stale = verifyStepUpMagicLink({
		scope: "account.security",
		sessionId: "session",
		token: "first-token",
	});
	// The resend reuses the row (same `_id`) with a new digest while the first
	// verifier is between its read and its consume.
	const replaced = {
		...(stored as ChallengeRow),
		codeHash: digest("second-token"),
	};
	stored = replaced;
	await afterBothRead(null);
	expect(await stale).toEqual({ ok: false, reason: "no-challenge" });
	expect(stored).toBe(replaced);
	expect(deletes).toBe(0);
});
