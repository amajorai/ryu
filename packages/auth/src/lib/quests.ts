/**
 * Quest catalog — the single source of truth for what quests exist, what cadence
 * they run on, how completion is detected, and what each one pays.
 *
 * SAME DISCIPLINE AS `plans.ts` / `features.ts`: ONE `QUESTS` const, imported
 * everywhere, so the catalog can never drift from the code that renders or pays
 * it. A quest's `key` is stable — it is persisted in `UserQuest` rows and in
 * the `PointsLedger` / grant `refId` idempotency keys. Never rename one in
 * flight; re-keying orphan every row that already recorded it.
 *
 * CADENCE IS WHAT A QUEST RESETS ON. `daily`, `weekly`, and `monthly` reset on
 * their calendar boundary via a `periodKey` ("2026-08-17" / "2026-W33" /
 * "2026-08") — the same "YYYY-MM" discipline the referral campaign instances
 * use, generalized to shorter windows. `one_time` never resets (claim once,
 * forever). `permanent` is a non-resetting REPEATABLE quest: the user can claim
 * it again whenever the target is met again (a "refer one more friend" style
 * treadmill), and the claim's `refId` carries a nonce so each claim is its own
 * idempotent row.
 *
 * VERIFICATION IS HOW COMPLETION IS KNOWN, AND IT IS THE FRAUD SURFACE.
 *  - `auto` — the server derives progress from data it already trusts (referral
 *    rows, a ledger). Nobody can claim one without the underlying signal.
 *  - `submit` — the user submits proof (a link, a handle) that a HUMAN reviews
 *    before the reward is claimable. This is the `UpdatesRedemption` model: the
 *    post must be real, public, and on-mission before it pays. A submit quest
 *    has NO reward until its proof is approved — the reward field below is the
 *    same shape, but the router refuses to pay it while the proof is pending.
 *
 * Nothing here writes. Like `points.ts`, this module is pure and server-side:
 * the API layer owns the DB writes and the idempotency keys.
 */

import { type CreditPoolId, DEFAULT_FREE_CREDIT_POOL } from "./credit-pools.ts";

/** How a quest's window is defined. `periodKey` derives from this. */
export const QUEST_CADENCES = [
	"daily",
	"one_time",
	"weekly",
	"monthly",
	"permanent",
] as const;
export type QuestCadence = (typeof QUEST_CADENCES)[number];

/** How completion is detected — see the header note on the fraud surface. */
export const QUEST_VERIFICATIONS = ["auto", "submit"] as const;
export type QuestVerification = (typeof QUEST_VERIFICATIONS)[number];

/**
 * What a quest pays. Two kinds, deliberately narrow:
 *  - `points` — credits the user's `pointsBalance` (the store currency).
 *  - `credit` — mints a pool-restricted `CreditGrant` into the wallet of an org
 *    the user CHOOSES at claim time (the reward-received dialog). The pool is
 *    the ONLY supply the money is spendable against, exactly like a campaign or
 *    referral grant.
 */
export type QuestReward =
	| { kind: "points"; points: number }
	| { kind: "credit"; creditMicroUsd: number; pool: CreditPoolId };

/** One quest definition. `target` is the count of the unit that completes it. */
export interface QuestDef {
	readonly cadence: QuestCadence;
	readonly description: string;
	readonly icon?: string;
	readonly key: string;
	readonly reward: QuestReward;
	/** How many of the thing it takes (5 referrals, 1 connection, 3 posts). */
	readonly target: number;
	readonly title: string;
	readonly verification: QuestVerification;
}

/** Micro-USD per dollar, so the catalog is written in readable dollars. */
const usd = (dollars: number): number => Math.round(dollars * 1_000_000);

/**
 * The catalog.
 *
 * The daily row is the return habit. The one-time rows are the onboarding ladder
 * (connect, join, link). The weekly rows are the outreach/inbound treadmill —
 * posted on cadence, so a user has a reason to come back every week rather than
 * once. The monthly rows inherit the referral campaign's already-monthly window.
 * The permanent rows are the repeatable "one more" rewards.
 *
 * QUEST REWARDS ARE DIFFERENT ON PURPOSE. The low-friction connection quests pay
 * points (the store currency); the ones that move actual people pay credits. A
 * quest whose reward is credit and whose verification is `submit` is the exact
 * shape the admin must watch, so those pay small.
 */
export const QUESTS: readonly QuestDef[] = [
	/* ---- daily: the habit loop ---- */
	{
		key: "daily-check-in",
		title: "Daily check-in",
		description: "Check in once a day to keep earning points toward rewards.",
		icon: "calendar-check",
		cadence: "daily",
		target: 1,
		verification: "auto",
		reward: { kind: "points", points: 25 },
	},

	/* ---- one-time: the onboarding ladder ---- */
	{
		key: "connect-x",
		title: "Connect your X account",
		description:
			"Link the X (Twitter) account you post about Ryu from. This is the identity the weekly posting quests check against.",
		icon: "twitter",
		cadence: "one_time",
		target: 1,
		verification: "submit",
		reward: { kind: "points", points: 150 },
	},
	{
		key: "download-desktop-app",
		title: "Download the Ryu desktop app",
		description:
			"Install Ryu Desktop and open it once while signed in to earn 100 points.",
		icon: "download",
		cadence: "one_time",
		target: 1,
		verification: "auto",
		reward: { kind: "points", points: 100 },
	},
	{
		key: "join-discord",
		title: "Join the Ryu Discord",
		description:
			"Join the community server where Ryu users compare notes, share recipes, and get early access.",
		icon: "message-square",
		cadence: "one_time",
		target: 1,
		verification: "submit",
		reward: { kind: "points", points: 100 },
	},
	{
		key: "link-discord",
		title: "Link your Discord account",
		description:
			"Associate your Discord identity with your Ryu account so the team can reach you (and verify the server membership above).",
		icon: "users",
		cadence: "one_time",
		target: 1,
		verification: "submit",
		reward: { kind: "points", points: 100 },
	},

	/* ---- weekly: the outreach / inbound treadmill ---- */
	{
		key: "post-on-x-weekly",
		title: "Post on X this week",
		description:
			"Share what you're building with Ryu — a recipe, a prompt, a win. One public post this week.",
		icon: "send",
		cadence: "weekly",
		target: 1,
		verification: "submit",
		reward: { kind: "points", points: 200 },
	},
	{
		key: "share-weekly",
		title: "Share what you're doing this week",
		description:
			"A second, separate update from the post above — a progress note, a screenshot, a question to the community.",
		icon: "sparkles",
		cadence: "weekly",
		target: 1,
		verification: "submit",
		reward: { kind: "points", points: 100 },
	},
	{
		key: "outreach-weekly",
		title: "Reach out to 3 people",
		description:
			"Send three genuine outbound messages — to a community member, a collaborator, someone who'd benefit from Ryu. Submit one link (a thread, a recap) as proof.",
		icon: "mails",
		cadence: "weekly",
		target: 1,
		verification: "submit",
		reward: { kind: "points", points: 150 },
	},
	{
		key: "inbound-weekly",
		title: "Reply to your mentions",
		description:
			"Answer every reply, mention, and direct message you received this week. Inbound engagement is how outreach compounds.",
		icon: "inbox",
		cadence: "weekly",
		target: 1,
		verification: "submit",
		reward: {
			kind: "credit",
			creditMicroUsd: usd(2),
			pool: DEFAULT_FREE_CREDIT_POOL,
		},
	},

	/* ---- monthly: inherits the referral campaign's month window ---- */
	{
		key: "refer-3-monthly",
		title: "Refer 3 friends this month",
		description:
			"Three people sign up through your link this month. Auto-detected from your referral dashboard — nothing to submit.",
		icon: "users",
		cadence: "monthly",
		target: 3,
		verification: "auto",
		reward: {
			kind: "credit",
			creditMicroUsd: usd(5),
			pool: DEFAULT_FREE_CREDIT_POOL,
		},
	},
	{
		key: "refer-5-monthly",
		title: "Refer 5 friends this month",
		description:
			"Five people sign up through your link this month. Auto-detected from your referral dashboard — nothing to submit.",
		icon: "trophy",
		cadence: "monthly",
		target: 5,
		verification: "auto",
		reward: {
			kind: "credit",
			creditMicroUsd: usd(10),
			pool: DEFAULT_FREE_CREDIT_POOL,
		},
	},

	/* ---- permanent: repeatable, claim-as-you-meet-it ---- */
	{
		key: "refer-extra-permanent",
		title: "Refer one more friend",
		description:
			"Each additional friend who signs up through your link, beyond the monthly ladder. Repeatable — claim it once per new referral.",
		icon: "repeat",
		cadence: "permanent",
		target: 1,
		verification: "auto",
		reward: { kind: "points", points: 200 },
	},
];

/** Index by key for O(1) lookups; the catalog never has duplicate keys. */
const QUEST_BY_KEY = new Map(QUESTS.map((quest) => [quest.key, quest]));

/** Look up a quest by key (undefined for an unknown key). */
export const questByKey = (key: string): QuestDef | undefined =>
	QUEST_BY_KEY.get(key);

/* -------------------------------------------------------------------------- *
 * Period keys — the window a quest row belongs to.
 *
 * `null` for one-time/permanent (never resets); "YYYY-MM-DD" for daily,
 * "YYYY-MM" for monthly (the same shape the referral campaign instances use,
 * derived in UTC here), and "YYYY-Www" for weekly (ISO-8601 week, so week 1 is
 * the first week with a Thursday — the same definition calendar apps use). The
 * value is persisted in `UserQuest.periodKey` and is what "reset" means: a new
 * period is a new row.
 * -------------------------------------------------------------------------- */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD" for the UTC day `date` falls in. */
export function dayPeriodKey(date: Date): string {
	return [
		date.getUTCFullYear(),
		String(date.getUTCMonth() + 1).padStart(2, "0"),
		String(date.getUTCDate()).padStart(2, "0"),
	].join("-");
}

/** "YYYY-MM" for the month `date` falls in, UTC. */
export function monthPeriodKey(date: Date): string {
	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * "YYYY-Www" for the ISO week `date` falls in, UTC. ISO week 1 is the week
 * containing the first Thursday; years are the week-year, which can differ from
 * the calendar year at the turn of the year (Dec 31 can be week 1 of next year).
 */
export function weekPeriodKey(date: Date): string {
	const day = (date.getUTCDay() + 6) % 7; // Monday = 0 … Sunday = 6
	// Move to the Thursday of this ISO week: Thursday = day index 3.
	const thursday = new Date(date.getTime() + (3 - day) * 24 * 60 * 60 * 1000);
	const year = thursday.getUTCFullYear();
	const yearStart = new Date(Date.UTC(year, 0, 1));
	// Week 1 starts at the first Monday on or before the year's first Thursday,
	// which is `yearStart` shifted back to the preceding Monday.
	const yearStartWeekday = (yearStart.getUTCDay() + 6) % 7;
	const weekOneStart = new Date(
		yearStart.getTime() - yearStartWeekday * 24 * 60 * 60 * 1000
	);
	const week =
		Math.floor((thursday.getTime() - weekOneStart.getTime()) / WEEK_MS) + 1;
	return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * The period key a quest of `cadence` belongs to for `date`, or null for
 * one-time/permanent quests.
 */
export function periodKeyFor(date: Date, cadence: QuestCadence): string | null {
	if (cadence === "daily") {
		return dayPeriodKey(date);
	}
	if (cadence === "weekly") {
		return weekPeriodKey(date);
	}
	if (cadence === "monthly") {
		return monthPeriodKey(date);
	}
	return null;
}

/**
 * The points a quest pays, or null when it pays credit. Callers that must not
 * print "0 points" ask this first, mirroring `hasGrantAmount`.
 */
export function questPointsReward(quest: QuestDef): number | null {
	return quest.reward.kind === "points" ? quest.reward.points : null;
}

/** Whether a quest pays a pool-restricted credit grant. */
export function questCreditReward(
	quest: QuestDef
): { creditMicroUsd: number; pool: CreditPoolId } | null {
	return quest.reward.kind === "credit" ? quest.reward : null;
}
