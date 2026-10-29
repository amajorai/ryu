import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";

interface ChallengeRow {
	_id: string;
	attempts: number;
	challengeType: "otp" | "magic-link";
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
	expiresAt?: { $gt: Date };
	scope?: string;
	sessionId?: string;
}

const rows = new Map<string, ChallengeRow>();

function matches(row: ChallengeRow, filter: ChallengeFilter): boolean {
	return (
		(filter._id === undefined || row._id === filter._id) &&
		(filter.challengeType === undefined ||
			row.challengeType === filter.challengeType) &&
		(filter.codeHash === undefined || row.codeHash === filter.codeHash) &&
		(filter.scope === undefined || row.scope === filter.scope) &&
		(filter.sessionId === undefined || row.sessionId === filter.sessionId) &&
		(filter.attempts === undefined || row.attempts < filter.attempts.$lt) &&
		(filter.expiresAt === undefined ||
			row.expiresAt.getTime() > filter.expiresAt.$gt.getTime())
	);
}

function find(filter: ChallengeFilter): ChallengeRow | undefined {
	return [...rows.values()].find((row) => matches(row, filter));
}

/** Yield so concurrent callers interleave the way they would against Mongo. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

mock.module("@ryu/db/models/step-up.model", () => ({
	StepUpAttempt: {},
	StepUpGrant: {},
	StepUpChallenge: {
		findOne: async (filter: ChallengeFilter) => {
			await tick();
			const row = find(filter);
			return row ? { ...row } : null;
		},
		findOneAndUpdate: async (
			filter: ChallengeFilter,
			update: { $inc: { attempts: number } }
		) => {
			await tick();
			const row = find(filter);
			if (!row) {
				return null;
			}
			row.attempts += update.$inc.attempts;
			return { ...row };
		},
		deleteOne: async (filter: ChallengeFilter) => {
			await tick();
			const row = find(filter);
			if (!row) {
				return { deletedCount: 0 };
			}
			rows.delete(row._id);
			return { deletedCount: 1 };
		},
	},
}));

mock.module("@ryu/email", () => ({
	StepUpMagicLinkEmail: () => null,
	StepUpOTPEmail: () => null,
	sendEmail: async () => undefined,
}));

const { verifyStepUpChallenge } = await import("./step-up.ts");

const hash = (code: string) => createHash("sha256").update(code).digest("hex");

function seed(sessionId: string, code: string): void {
	rows.set(sessionId, {
		_id: sessionId,
		attempts: 0,
		challengeType: "otp",
		codeHash: hash(code),
		expiresAt: new Date(Date.now() + 60_000),
		scope: "org.members",
		sessionId,
	});
}

test("a burst of concurrent wrong guesses cannot exceed the attempt cap", async () => {
	const sessionId = "burst-session";
	seed(sessionId, "123456");
	const guesses = Array.from({ length: 40 }, (_, index) =>
		verifyStepUpChallenge({
			code: String(index).padStart(6, "0"),
			scope: "org.members",
			sessionId,
		})
	);
	const results = await Promise.all(guesses);
	const compared = results.filter(
		(result) => !result.ok && result.reason === "invalid"
	);
	// Four plain misses, then the fifth miss reports the cap; the rest are refused
	// without ever being compared.
	expect(compared.length).toBeLessThanOrEqual(4);
	// The burned challenge is gone: even the right code no longer opens it.
	const late = await verifyStepUpChallenge({
		code: "123456",
		scope: "org.members",
		sessionId,
	});
	expect(late.ok).toBe(false);
	expect(rows.has(sessionId)).toBe(false);
});

test("a correct code is consumed exactly once under concurrent submission", async () => {
	const sessionId = "replay-session";
	seed(sessionId, "654321");
	const results = await Promise.all(
		Array.from({ length: 3 }, () =>
			verifyStepUpChallenge({
				code: "654321",
				scope: "org.members",
				sessionId,
			})
		)
	);
	expect(results.filter((result) => result.ok)).toHaveLength(1);
});

test("an expired challenge is refused and removed", async () => {
	const sessionId = "expired-session";
	seed(sessionId, "111111");
	const row = rows.get(sessionId);
	if (row) {
		row.expiresAt = new Date(Date.now() - 1);
	}
	expect(
		await verifyStepUpChallenge({
			code: "111111",
			scope: "org.members",
			sessionId,
		})
	).toEqual({ ok: false, reason: "expired" });
	expect(rows.has(sessionId)).toBe(false);
});
