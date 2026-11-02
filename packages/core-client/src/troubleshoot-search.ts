// The similar-issue search against the public tracker. The one outbound call
// the troubleshooter makes sends search keywords only, never the report.
// Pure and browser-safe (`fetch` injected); re-exported from `./troubleshoot.ts`.

import { z } from "zod";
import {
	ISSUE_REPOSITORY,
	problemChecks,
	type SimilarIssue,
	type TroubleshootReport,
} from "./troubleshoot-model.ts";
import { redactDiagnosticText } from "./troubleshoot-redaction.ts";

const MAX_SIMILAR_ISSUES = 5;
const MAX_DESCRIPTION_KEYWORDS = 6;
const GITHUB_API = "https://api.github.com";

const STOP_WORDS = new Set(
	"a about after again all also an and any are as at be because been before being but by can cannot could did does doing dont for from get gets getting had has have how i im in into is it its just keeps me my no not of on or out please really ryu so some still that the their them then there this to tried trying up use using was we were what when where which while why will with without work works working would you".split(
		" "
	)
);

/** The few distinctive words of a free-text description, in order. */
export function descriptionKeywords(
	text: string,
	max = MAX_DESCRIPTION_KEYWORDS
): string[] {
	const seen = new Set<string>();
	const words: string[] = [];
	for (const raw of text.toLowerCase().split(/[^a-z0-9._-]+/)) {
		const word = raw.replace(/^[._-]+|[._-]+$/g, "");
		if (word.length < 3 || STOP_WORDS.has(word) || seen.has(word)) {
			continue;
		}
		seen.add(word);
		words.push(word);
		if (words.length >= max) {
			break;
		}
	}
	return words;
}

/**
 * At most two search phrases: the user's own words (most specific), then the
 * headline problem check. GitHub ANDs terms, so one long query would match
 * nothing; two short ones find the likely duplicates.
 */
export function similarIssueQueries(report: TroubleshootReport): string[] {
	const queries: string[] = [];
	const keywords = descriptionKeywords(
		redactDiagnosticText(report.description)
	).filter((word) => !word.startsWith("[redacted"));
	if (keywords.length > 0) {
		queries.push(keywords.join(" "));
	}
	const headline = problemChecks(report.checks).find(
		(check) => check.searchTerms
	);
	if (headline?.searchTerms && !queries.includes(headline.searchTerms)) {
		queries.push(headline.searchTerms);
	}
	return queries;
}

const githubIssueSearchSchema = z.object({
	items: z
		.array(
			z.object({
				html_url: z.string(),
				number: z.number(),
				pull_request: z.unknown().optional(),
				state: z.string(),
				title: z.string(),
				updated_at: z.string(),
			})
		)
		.catch(() => []),
});

export interface SimilarIssueSearchResult {
	/** Set when the search could not run (offline, rate limited, …). */
	error: string | null;
	issues: SimilarIssue[];
}

/**
 * Search the public tracker for issues matching `queries` (see
 * {@link similarIssueQueries}). Never throws: an unreachable or rate-limited
 * GitHub becomes `error`, so the troubleshooter still produces its report.
 */
export async function searchSimilarIssues(
	queries: readonly string[],
	options: {
		fetch: typeof fetch;
		limit?: number;
		repository?: string;
		signal?: AbortSignal;
	}
): Promise<SimilarIssueSearchResult> {
	const limit = options.limit ?? MAX_SIMILAR_ISSUES;
	const repository = options.repository ?? ISSUE_REPOSITORY;
	const byNumber = new Map<number, SimilarIssue>();
	let error: string | null = null;
	for (const query of queries) {
		if (byNumber.size >= limit) {
			break;
		}
		const q = `repo:${repository} is:issue ${query}`;
		const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&per_page=${limit}`;
		try {
			const response = await options.fetch(url, {
				headers: {
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
				signal: options.signal,
			});
			if (!response.ok) {
				error =
					response.status === 403 || response.status === 429
						? "GitHub search rate limit reached; try again in a minute."
						: `GitHub search failed (HTTP ${response.status}).`;
				continue;
			}
			const parsed = githubIssueSearchSchema.safeParse(await response.json());
			if (!parsed.success) {
				error = "GitHub search returned an unexpected response.";
				continue;
			}
			for (const item of parsed.data.items) {
				if (item.pull_request !== undefined || byNumber.has(item.number)) {
					continue;
				}
				byNumber.set(item.number, {
					number: item.number,
					state: item.state === "closed" ? "closed" : "open",
					title: item.title,
					updatedAt: item.updated_at,
					url: item.html_url,
				});
			}
		} catch (cause) {
			error = `GitHub search unavailable: ${cause instanceof Error ? cause.message : String(cause)}`;
		}
	}
	const issues = [...byNumber.values()].slice(0, limit);
	// A partial failure that still found matches is not worth surfacing.
	return { error: issues.length > 0 ? null : error, issues };
}
