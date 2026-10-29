import { expect, mock, test } from "bun:test";

interface AttemptRow {
	count: number;
	expiresAt: Date;
	verifiedAt?: Date;
}

interface GrantRow {
	expiresAt: Date;
	scope: string;
	sessionId: string;
}

const attempts = new Map<string, AttemptRow>();
const recordedGrants: GrantRow[] = [];

function attemptKey(sessionId: string, scope: string): string {
	return `${sessionId}:${scope}`;
}

function matchesFreshProof(
	row: AttemptRow | undefined,
	filter: { expiresAt: { $gt: Date } }
): boolean {
	return Boolean(
		row?.verifiedAt && row.expiresAt.getTime() > filter.expiresAt.$gt.getTime()
	);
}

mock.module("@ryu/db/models/step-up.model", () => ({
	StepUpAttempt: {
		findOne: (filter: {
			expiresAt: { $gt: Date };
			scope: string;
			sessionId: string;
		}) => {
			const row = attempts.get(attemptKey(filter.sessionId, filter.scope));
			return {
				select: () => ({
					lean: async () =>
						matchesFreshProof(row, filter) ? { _id: "fresh-proof" } : null,
				}),
			};
		},
		findOneAndDelete: (filter: {
			expiresAt: { $gt: Date };
			scope: string;
			sessionId: string;
		}) => {
			const key = attemptKey(filter.sessionId, filter.scope);
			const row = attempts.get(key);
			const fresh = matchesFreshProof(row, filter);
			if (fresh) {
				attempts.delete(key);
			}
			return {
				select: () => ({
					lean: async () => (fresh ? { _id: "fresh-proof" } : null),
				}),
			};
		},
		findOneAndUpdate: async (
			filter: { scope: string; sessionId: string },
			update: { $set?: Partial<AttemptRow> }
		) => {
			const key = attemptKey(filter.sessionId, filter.scope);
			const row = {
				count: 0,
				expiresAt: new Date(0),
				...attempts.get(key),
				...update.$set,
			};
			attempts.set(key, row);
			return row;
		},
	},
	StepUpChallenge: {},
	StepUpGrant: {
		create: async (grant: GrantRow) => {
			recordedGrants.push(grant);
		},
		findOne: (filter: {
			expiresAt: { $gt: Date };
			scope: string;
			sessionId: string;
		}) => {
			const grant = recordedGrants.find(
				(row) =>
					row.scope === filter.scope &&
					row.sessionId === filter.sessionId &&
					row.expiresAt.getTime() > filter.expiresAt.$gt.getTime()
			);
			return {
				select: () => ({
					lean: async () => (grant ? { _id: "reusable-grant" } : null),
				}),
			};
		},
	},
}));

mock.module("@ryu/email", () => ({
	StepUpMagicLinkEmail: () => null,
	StepUpOTPEmail: () => null,
	sendEmail: async () => undefined,
}));

const { authorizeStepUp, hasStepUp, recordStepUp } = await import(
	"./step-up.ts"
);

test("account-security proof authorizes one mutation, then must be renewed", async () => {
	const sessionId = "security-session";
	await recordStepUp({
		method: "password",
		scope: "account.security",
		sessionId,
		userId: "user-1",
	});

	expect(await hasStepUp(sessionId, "account.security")).toBe(true);
	expect(await authorizeStepUp(sessionId, "account.security")).toBe(true);
	expect(await hasStepUp(sessionId, "account.security")).toBe(false);
	expect(await authorizeStepUp(sessionId, "account.security")).toBe(false);
	expect(recordedGrants).toHaveLength(1);
});

test("other step-up scopes keep their configured reusable window", async () => {
	const sessionId = "member-session";
	await recordStepUp({
		method: "totp",
		scope: "org.members",
		sessionId,
		userId: "user-2",
	});

	expect(await authorizeStepUp(sessionId, "org.members")).toBe(true);
	expect(await authorizeStepUp(sessionId, "org.members")).toBe(true);
});
