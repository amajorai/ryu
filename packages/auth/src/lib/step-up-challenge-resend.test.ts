import { beforeEach, expect, mock, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

/**
 * A resend replaces the pending step-up code. When the replacement email is
 * refused by the shared per-recipient cooldown, nothing was delivered, so the
 * code already in the user's inbox must keep working instead of being silently
 * invalidated. The new code is stored before its email goes out, so a mailed
 * code always has its hash on record and a store that fails mails nothing.
 */

interface ChallengeRow {
	_id: string;
	attempts: number;
	challengeType: "otp" | "magic-link";
	codeHash: string;
	createdAt: Date;
	expiresAt: Date;
	scope: string;
	sessionId: string;
	stagedCodeHash?: string;
	userId: string;
}

interface ChallengeFilter {
	_id?: string;
	attempts?: { $lt: number };
	challengeType?: string;
	codeHash?: string;
	expiresAt?: { $gt: Date };
	scope?: string;
	sessionId?: string;
	stagedCodeHash?: string;
}

interface ChallengeUpdate {
	$inc?: { attempts: number };
	$max?: { attempts: number };
	$set?: Partial<ChallengeRow>;
	$setOnInsert?: Partial<ChallengeRow>;
	$unset?: { stagedCodeHash?: "" };
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
		(filter.stagedCodeHash === undefined ||
			row.stagedCodeHash === filter.stagedCodeHash) &&
		(filter.attempts === undefined || row.attempts < filter.attempts.$lt) &&
		(filter.expiresAt === undefined ||
			row.expiresAt.getTime() > filter.expiresAt.$gt.getTime())
	);
}

function find(filter: ChallengeFilter): ChallengeRow | undefined {
	return [...rows.values()].find((row) => matches(row, filter));
}

function apply(row: ChallengeRow, update: ChallengeUpdate): void {
	Object.assign(row, update.$set ?? {});
	if (update.$inc) {
		row.attempts += update.$inc.attempts;
	}
	if (update.$max) {
		row.attempts = Math.max(row.attempts, update.$max.attempts);
	}
	if (update.$unset?.stagedCodeHash !== undefined) {
		row.stagedCodeHash = undefined;
	}
}

function insert(
	filter: ChallengeFilter,
	update: ChallengeUpdate
): ChallengeRow {
	const inserted: ChallengeRow = {
		_id: randomUUID(),
		attempts: 0,
		challengeType: "otp",
		codeHash: "",
		createdAt: new Date(),
		expiresAt: new Date(),
		scope: filter.scope ?? "",
		sessionId: filter.sessionId ?? "",
		userId: "",
		...update.$setOnInsert,
	};
	apply(inserted, update);
	rows.set(inserted._id, inserted);
	return inserted;
}

/** When set, the next challenge write rejects, as an unreachable database would. */
let storeFailure: Error | null = null;

/** A Mongoose-style query: awaitable directly, or through `.lean()`. */
function query<T>(result: Promise<T>): Promise<T> & { lean: () => Promise<T> } {
	return Object.assign(result, { lean: () => result });
}

function findOneAndUpdate(
	filter: ChallengeFilter,
	update: ChallengeUpdate,
	options: { new?: boolean; upsert?: boolean }
) {
	if (storeFailure) {
		return query(Promise.reject(storeFailure));
	}
	const row = find(filter);
	if (!row) {
		if (options.upsert) {
			const inserted = insert(filter, update);
			return query(Promise.resolve(options.new ? { ...inserted } : null));
		}
		return query(Promise.resolve(null));
	}
	const before = { ...row };
	apply(row, update);
	return query(Promise.resolve(options.new ? { ...row } : before));
}

mock.module("@ryu/db/models/step-up.model", () => ({
	StepUpAttempt: { updateOne: () => Promise.resolve({ modifiedCount: 0 }) },
	StepUpGrant: {},
	StepUpChallenge: {
		findOne: (filter: ChallengeFilter) => {
			const row = find(filter);
			return Promise.resolve(row ? { ...row } : null);
		},
		findOneAndUpdate,
		updateOne: (
			filter: ChallengeFilter,
			update: ChallengeUpdate,
			options: { upsert?: boolean } = {}
		) => {
			const row = find(filter);
			if (row) {
				apply(row, update);
			} else if (options.upsert) {
				insert(filter, update);
			}
			const matchedCount = row ? 1 : 0;
			return Promise.resolve({ matchedCount, modifiedCount: matchedCount });
		},
		deleteOne: (filter: ChallengeFilter) => {
			const row = find(filter);
			if (row) {
				rows.delete(row._id);
			}
			return Promise.resolve({ deletedCount: row ? 1 : 0 });
		},
	},
}));

class EmailRateLimitError extends Error {
	readonly code = "RATE_LIMIT_EXCEEDED";
	readonly retryAfter = 42;
}

type SendOutcome = "deliver" | "rate-limit" | "provider-error";
let sendOutcome: SendOutcome = "deliver";
/** Codes the mailbox actually received. */
let delivered: string[] = [];
/** Codes generated for a send, whatever its outcome. */
let attempted: string[] = [];
/** Runs just before a refused send, to model a racing resend. */
let beforeRefusal: (() => void) | null = null;
/** Runs as every send starts, to observe or race the stored challenge. */
let duringSend: ((code: string) => void) | null = null;

mock.module("@ryu/email", () => ({
	EmailRateLimitError,
	StepUpMagicLinkEmail: () => null,
	StepUpOTPEmail: () => null,
	sendEmail: ({ subject }: { subject: string }) => {
		const code = subject.replace("Your confirmation code is ", "");
		attempted.push(code);
		duringSend?.(code);
		if (sendOutcome === "rate-limit") {
			beforeRefusal?.();
			return Promise.reject(
				new EmailRateLimitError("Please wait before requesting another email")
			);
		}
		if (sendOutcome === "provider-error") {
			return Promise.reject(new Error("Failed to send email: timed out"));
		}
		delivered.push(code);
		return Promise.resolve({ success: true });
	},
}));

const { issueStepUpChallenge, verifyStepUpChallenge } = await import(
	"./step-up.ts"
);

const hash = (code: string) => createHash("sha256").update(code).digest("hex");
const user = { email: "owner@example.com", id: "user-1", name: "Owner" };

function issue(sessionId: string) {
	return issueStepUpChallenge({ scope: "org.members", sessionId, user });
}

function verify(sessionId: string, code: string) {
	return verifyStepUpChallenge({ code, scope: "org.members", sessionId });
}

beforeEach(() => {
	rows.clear();
	sendOutcome = "deliver";
	delivered = [];
	attempted = [];
	beforeRefusal = null;
	duringSend = null;
	storeFailure = null;
});

/** The session's single challenge row; a resend must never stack a second. */
function onlyRow(): ChallengeRow | undefined {
	if (rows.size !== 1) {
		throw new Error(`expected one challenge row, found ${rows.size}`);
	}
	return [...rows.values()][0];
}

test("each code is on record before its email is sent, and a resend promotes it once sent", async () => {
	const sessionId = "ordering-session";
	const atSend: Pick<ChallengeRow, "codeHash" | "stagedCodeHash">[] = [];
	duringSend = () => {
		const row = onlyRow();
		atSend.push({
			codeHash: row?.codeHash ?? "",
			stagedCodeHash: row?.stagedCodeHash,
		});
	};
	await issue(sessionId);
	await issue(sessionId);
	const [firstCode, secondCode] = delivered;

	// A first code is stored pending; a resend is staged beside the pending code,
	// which is still the one a verify compares against while the email is out.
	expect(atSend).toEqual([
		{ codeHash: hash(firstCode ?? ""), stagedCodeHash: hash(firstCode ?? "") },
		{ codeHash: hash(firstCode ?? ""), stagedCodeHash: hash(secondCode ?? "") },
	]);
	const row = onlyRow();
	expect(row?.codeHash).toBe(hash(secondCode ?? ""));
	expect(row?.stagedCodeHash).toBeUndefined();
	expect(await verify(sessionId, firstCode ?? "")).toEqual({
		ok: false,
		reason: "invalid",
	});
	expect(await verify(sessionId, secondCode ?? "")).toEqual({ ok: true });
});

test("a store that fails sends no email and leaves the pending code working", async () => {
	const sessionId = "store-failure-session";
	storeFailure = new Error("connection refused");
	await expect(issue(sessionId)).rejects.toThrow("connection refused");
	expect(attempted).toEqual([]);
	expect(rows.size).toBe(0);

	storeFailure = null;
	await issue(sessionId);
	const [firstCode] = delivered;
	storeFailure = new Error("connection refused");
	await expect(issue(sessionId)).rejects.toThrow("connection refused");
	expect(attempted).toHaveLength(1);
	expect(delivered).toHaveLength(1);

	storeFailure = null;
	expect(onlyRow()?.codeHash).toBe(hash(firstCode ?? ""));
	expect(await verify(sessionId, firstCode ?? "")).toEqual({ ok: true });
});

test("a delivered resend whose staging was overtaken still becomes the pending code", async () => {
	const sessionId = "overtaken-session";
	await issue(sessionId);
	duringSend = () => {
		// A concurrent resend staged its own code over this one mid-send.
		const row = onlyRow();
		if (row) {
			row.stagedCodeHash = hash("424242");
		}
	};
	await issue(sessionId);
	const [, secondCode] = delivered;

	const row = onlyRow();
	expect(row?.codeHash).toBe(hash(secondCode ?? ""));
	// The other request's marker is left for it to promote or discard.
	expect(row?.stagedCodeHash).toBe(hash("424242"));
	expect(await verify(sessionId, secondCode ?? "")).toEqual({ ok: true });
});

test("a rate-limited resend keeps the code already in the inbox", async () => {
	const sessionId = "resend-session";
	await issue(sessionId);
	const [firstCode] = delivered;
	expect(firstCode).toBeDefined();
	// One wrong guess already spent against the delivered code.
	expect((await verify(sessionId, "not-it")).ok).toBe(false);

	sendOutcome = "rate-limit";
	await expect(issue(sessionId)).rejects.toBeInstanceOf(EmailRateLimitError);

	const row = onlyRow();
	expect(row?.codeHash).toBe(hash(firstCode ?? ""));
	expect(row?.stagedCodeHash).toBeUndefined();
	// The refused resend does not hand back a fresh guess budget.
	expect(row?.attempts).toBe(1);
	expect(await verify(sessionId, firstCode ?? "")).toEqual({ ok: true });
});

test("a rate-limited first issue leaves no challenge behind", async () => {
	const sessionId = "first-session";
	sendOutcome = "rate-limit";
	await expect(issue(sessionId)).rejects.toBeInstanceOf(EmailRateLimitError);

	expect(rows.size).toBe(0);
	expect(await verify(sessionId, attempted[0] ?? "")).toEqual({
		ok: false,
		reason: "no-challenge",
	});
});

test("a provider failure stores nothing and keeps the code already delivered", async () => {
	const sessionId = "timeout-session";
	await issue(sessionId);
	const [firstCode] = delivered;

	sendOutcome = "provider-error";
	await expect(issue(sessionId)).rejects.toThrow("timed out");

	// The resend's code was only staged, and a failed send discards it: no hash
	// is left for a code nobody received, and the pending challenge (with its
	// spent guesses) is exactly as it was.
	const row = onlyRow();
	expect(row?.codeHash).toBe(hash(firstCode ?? ""));
	expect(row?.stagedCodeHash).toBeUndefined();
	expect(await verify(sessionId, attempted[1] ?? "")).toEqual({
		ok: false,
		reason: "invalid",
	});
	expect(await verify(sessionId, firstCode ?? "")).toEqual({ ok: true });
});

test("a refused send never overwrites a newer resend that landed first", async () => {
	const sessionId = "race-session";
	await issue(sessionId);

	const newer = "999999";
	sendOutcome = "rate-limit";
	beforeRefusal = () => {
		// Another request replaced the code and delivered it while this one was
		// waiting on its refused send.
		for (const row of rows.values()) {
			row.codeHash = hash(newer);
		}
	};
	await expect(issue(sessionId)).rejects.toBeInstanceOf(EmailRateLimitError);

	expect(await verify(sessionId, newer)).toEqual({ ok: true });
});
