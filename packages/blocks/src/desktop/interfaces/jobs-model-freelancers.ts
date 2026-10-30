import type {
	InterfaceAgent,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { jobStatus } from "./jobs-model-core.ts";
import { pluralize } from "./jobs-model-time.ts";

// ---------------------------------------------------------------------------
// Freelancers
// ---------------------------------------------------------------------------

/** Settled jobs needed before a job-success score is shown. */
export const JOB_SUCCESS_MIN_SAMPLE = 2;

export interface FreelancerProfile {
	/** Working right now. */
	active: number;
	agent: InterfaceAgent;
	/**
	 * Closed jobs only. As on Upwork, a contract is not complete until the
	 * client closes it, so this matches the Status filter's "Closed" count,
	 * except that a closed job with no messages never started and does not
	 * count.
	 */
	completed: number;
	/** Delivered work waiting on your review ("Review" in the Status filter). */
	inReview: number;
	onHold: number;
	/** Jobs that reached an outcome: in review, closed or on hold. */
	settled: number;
	/**
	 * Delivered jobs (in review or closed) out of every settled job, 0–100;
	 * null until at least JOB_SUCCESS_MIN_SAMPLE jobs have settled, so one job
	 * never reads as a 0% or 100% record.
	 */
	successRate: number | null;
	total: number;
}

export function freelancerProfile(
	snapshot: InterfaceSnapshot,
	agent: InterfaceAgent
): FreelancerProfile {
	let active = 0;
	let completed = 0;
	let inReview = 0;
	let onHold = 0;
	let total = 0;
	for (const thread of snapshot.threads) {
		if (!thread.agentIds.includes(agent.id)) {
			continue;
		}
		total += 1;
		const status = jobStatus(thread);
		if (status === "in-progress") {
			active += 1;
		} else if (status === "closed") {
			// A thread nobody has written in was never started, not closed.
			if (thread.messageCount > 0) {
				completed += 1;
			}
		} else if (status === "review") {
			inReview += 1;
		} else if (status === "on-hold") {
			onHold += 1;
		}
	}
	const delivered = completed + inReview;
	const settled = delivered + onHold;
	return {
		active,
		agent,
		completed,
		inReview,
		onHold,
		settled,
		successRate:
			settled >= JOB_SUCCESS_MIN_SAMPLE
				? Math.round((delivered / settled) * 100)
				: null,
		total,
	};
}

/** Working freelancers first, then the most delivered work, then by name. */
export function freelancerProfiles(
	snapshot: InterfaceSnapshot
): FreelancerProfile[] {
	return snapshot.agents
		.map((agent) => freelancerProfile(snapshot, agent))
		.sort(
			(a, b) =>
				Number(b.agent.status === "working") -
					Number(a.agent.status === "working") ||
				b.completed + b.inReview - (a.completed + a.inReview) ||
				a.agent.name.localeCompare(b.agent.name)
		);
}

/** The Freelancers tab's rail facets. */
export type FreelancerFacet = "all" | "available" | "working";

export const FREELANCER_FACETS: readonly {
	id: FreelancerFacet;
	label: string;
}[] = [
	{ id: "all", label: "All freelancers" },
	{ id: "working", label: "Working now" },
	{ id: "available", label: "Available" },
];

export function matchesFreelancerFacet(
	profile: FreelancerProfile,
	facet: FreelancerFacet
): boolean {
	if (facet === "all") {
		return true;
	}
	const working = profile.agent.status === "working";
	return facet === "working" ? working : !working;
}

export function filterFreelancers(
	profiles: readonly FreelancerProfile[],
	query: string,
	facet: FreelancerFacet = "all"
): FreelancerProfile[] {
	const needle = query.trim().toLowerCase();
	return profiles.filter(
		(profile) =>
			matchesFreelancerFacet(profile, facet) &&
			`${profile.agent.name}\n${profile.agent.description}`
				.toLowerCase()
				.includes(needle)
	);
}

/**
 * One meta line per freelancer, the same shape on every row: "N jobs ·
 * N completed", with the job-success score appended only once the sample is
 * large enough to mean something.
 */
export function freelancerMeta(profile: FreelancerProfile): string {
	if (profile.total === 0) {
		return "No jobs yet";
	}
	const parts = [
		pluralize(profile.total, "job"),
		`${profile.completed} completed`,
	];
	if (profile.successRate !== null) {
		parts.push(`${profile.successRate}% job success`);
	}
	return parts.join(" · ");
}
