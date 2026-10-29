/** Canonical wire contract for public Ryu challenges, hackathons, and events. */

export const CHALLENGE_KINDS = ["challenge", "hackathon", "event"] as const;
export type ChallengeKind = (typeof CHALLENGE_KINDS)[number];

export const CHALLENGE_FORMATS = ["online", "in_person", "hybrid"] as const;
export type ChallengeFormat = (typeof CHALLENGE_FORMATS)[number];

export const CHALLENGE_PUBLICATION_STATES = [
	"draft",
	"published",
	"archived",
] as const;
export type ChallengePublicationState =
	(typeof CHALLENGE_PUBLICATION_STATES)[number];

export const CHALLENGE_STATUSES = [
	"draft",
	"upcoming",
	"live",
	"closed",
	"archived",
] as const;
export type ChallengeStatus = (typeof CHALLENGE_STATUSES)[number];

export const CHALLENGE_ENTRY_STATUSES = [
	"registered",
	"submitted",
	"shortlisted",
	"awarded",
	"declined",
] as const;
export type ChallengeEntryStatus = (typeof CHALLENGE_ENTRY_STATUSES)[number];

/**
 * How a prize is delivered. `points` and `credits` are disbursed automatically
 * when an admin awards the place; `merch`, `physical`, and `custom` are
 * fulfilled by hand and stay pending until an admin marks them shipped/done.
 * Rows written before prize kinds existed have no kind and read as `points`.
 */
export const CHALLENGE_PRIZE_KINDS = [
	"points",
	"credits",
	"merch",
	"physical",
	"custom",
] as const;
export type ChallengePrizeKind = (typeof CHALLENGE_PRIZE_KINDS)[number];

/** Prize kinds a winner must provide shipping details for. */
export const CHALLENGE_SHIPPED_PRIZE_KINDS = [
	"merch",
	"physical",
] as const satisfies readonly ChallengePrizeKind[];

/**
 * Who may submit a project. `ryu_agent` requires the submission request to be
 * made with a Ryu agent credential rather than a browser sign-in session.
 */
export const CHALLENGE_SUBMISSION_CHANNELS = ["any", "ryu_agent"] as const;
export type ChallengeSubmissionChannel =
	(typeof CHALLENGE_SUBMISSION_CHANNELS)[number];

export interface ChallengePrizeTier {
	/** Micro-USD of pool-restricted Ryu Credits; set only for `credits`. */
	amountMicroUsd: number | null;
	/**
	 * What the winner receives. Merch/physical/custom prizes carry the admin's
	 * text; public `credits` tiers carry a user-facing value such as
	 * "$50 in Ryu Frontier credits".
	 */
	description: string | null;
	kind: ChallengePrizeKind;
	label: string;
	place: number;
	/** Ryu Points; `0` for every kind other than `points`. */
	points: number;
	/**
	 * Credit pool id the grant is restricted to. Set only for `credits` tiers in
	 * admin responses; always null in public and agent-facing responses, which
	 * must never expose a pool id.
	 */
	pool: string | null;
}

/** Admin input for one prize tier. A missing kind means `points`. */
export interface ChallengePrizeTierInput {
	amountMicroUsd?: number | null;
	description?: string | null;
	kind?: ChallengePrizeKind;
	label: string;
	place: number;
	points?: number;
	pool?: string | null;
}

export interface ChallengeWinner {
	allowPublicDisplay: boolean;
	awardPlace: number;
	awardPoints: number;
	displayName: string;
	id: string;
	prizeLabel: string;
	projectName: string;
}

/** Public summary and detail shape. All dates use RFC 3339 UTC strings. */
export interface Challenge {
	awardedPoints: number;
	brief: string;
	category: string;
	endsAt: string;
	featured: boolean;
	format: ChallengeFormat;
	hostName: string;
	hostUrl: string | null;
	id: string;
	judgingCriteria: string[];
	kind: ChallengeKind;
	location: string | null;
	participantCount: number;
	prizeSummary: string | null;
	prizeTiers: ChallengePrizeTier[];
	publicationState: ChallengePublicationState;
	rules: string[];
	slug: string;
	startsAt: string;
	status: ChallengeStatus;
	submissionChannel: ChallengeSubmissionChannel;
	submissionCount: number;
	summary: string;
	timezone: string;
	title: string;
	totalPoints: number;
	winners: ChallengeWinner[];
}

/** Submission and registration shape returned to its owner or a platform admin. */
export interface ChallengeEntry {
	allowPublicDisplay: boolean;
	awardPlace: number | null;
	awardPoints: number | null;
	awardStatus: "reserved" | "awarded" | null;
	challengeId: string;
	displayName: string;
	email?: string;
	fulfillmentNote: string | null;
	fulfillmentStatus: "pending" | "fulfilled" | null;
	id: string;
	pitch: string | null;
	/** Credit grant amount for an awarded `credits` prize. */
	prizeAmountMicroUsd: number | null;
	prizeKind: ChallengePrizeKind | null;
	prizeLabel: string | null;
	projectName: string | null;
	projectUrl: string | null;
	registeredAt: string;
	reviewNote: string | null;
	/**
	 * Shipping details for merch/physical prizes. Visible only to the entry owner
	 * and platform admins, and cleared once the prize is marked fulfilled.
	 */
	shippingAddress: string | null;
	shippingSize: string | null;
	status: ChallengeEntryStatus;
	submittedAt: string | null;
	teamName: string | null;
}

/** A winner's shipping details for a merch or physical prize. */
export interface ChallengeShippingInput {
	address: string;
	size?: string | null;
}

/** Full fields an admin saves for a challenge or event. */
export interface ChallengeDraftInput {
	brief: string;
	category: string;
	endsAt: string;
	featured: boolean;
	format: ChallengeFormat;
	hostName: string;
	hostUrl: string | null;
	judgingCriteria: string[];
	kind: ChallengeKind;
	location: string | null;
	prizeSummary: string | null;
	prizeTiers: ChallengePrizeTierInput[];
	publicationState: ChallengePublicationState;
	rules: string[];
	startsAt: string;
	submissionChannel?: ChallengeSubmissionChannel;
	summary: string;
	timezone: string;
	title: string;
}

/** A participant can register first, then submit or update a project. */
export interface ChallengeSubmissionInput {
	allowPublicDisplay: boolean;
	pitch: string;
	projectName: string;
	projectUrl: string;
	teamName?: string;
}

export interface ChallengeUserEntry {
	challenge: Challenge;
	entry: ChallengeEntry;
}
