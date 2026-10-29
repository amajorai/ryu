import { z } from "zod";
import type {
	GitHubRepository,
	GitPullRequest,
	PullRequestCheck,
	PullRequestFeedback,
} from "./pull-requests.ts";

const textSchema = z
	.string()
	.transform((value) => value.trim() || null)
	.catch(null);
const numberSchema = z
	.number()
	.int()
	.positive()
	.max(Number.MAX_SAFE_INTEGER)
	.nullable()
	.catch(null);
const countSchema = z
	.number()
	.int()
	.nonnegative()
	.max(Number.MAX_SAFE_INTEGER)
	.nullable()
	.catch(null);
const repositoryNameSchema = z
	.union([
		z.string().transform((value) => value.trim() || null),
		z
			.object({ nameWithOwner: textSchema, name: textSchema })
			.transform((value) => value.nameWithOwner ?? value.name),
	])
	.catch(null);
const checkFieldsSchema = z.object({
	bucket: textSchema,
	conclusion: textSchema,
	description: textSchema,
	detailsUrl: textSchema,
	link: textSchema,
	name: textSchema,
	state: textSchema,
	status: textSchema,
	workflowName: textSchema,
	workflow: textSchema,
});
const checkSchema = z
	.union([
		checkFieldsSchema,
		z.array(z.json()).transform(() => checkFieldsSchema.parse({})),
	])
	.transform(
		(value): PullRequestCheck => ({
			bucket: value.bucket,
			conclusion: value.conclusion,
			description: value.description,
			detailsUrl: value.detailsUrl ?? value.link,
			name: value.name,
			state: value.state,
			status: value.status,
			workflowName: value.workflowName ?? value.workflow,
		})
	)
	.nullable()
	.catch(null);
const checksSchema = z.array(checkSchema).nullable().catch(null);
const commentsSchema = z.array(z.json()).nullable().catch(null);
const branchSchema = z
	.union([
		z.string().transform((value) => value.trim() || null),
		z.object({ name: textSchema }).transform((value) => value.name),
	])
	.catch(null);

export const gitHubRepositoryWireSchema = z
	.object({
		defaultBranch: textSchema,
		defaultBranchRef: branchSchema,
		nameWithOwner: textSchema,
		url: textSchema,
	})
	.transform((value): GitHubRepository | null =>
		value.nameWithOwner && value.url
			? {
					defaultBranch: value.defaultBranch ?? value.defaultBranchRef,
					nameWithOwner: value.nameWithOwner,
					url: value.url,
				}
			: null
	)
	.catch(null);

export const gitPullRequestWireSchema = z
	.object({
		baseRefName: textSchema,
		base: textSchema,
		branch: textSchema,
		commentsCount: countSchema,
		comments_count: countSchema,
		comments: commentsSchema,
		headRefName: textSchema,
		headRefOid: textSchema,
		head_sha: textSchema,
		isDraft: z.boolean().catch(false),
		is_draft: z.boolean().catch(false),
		mergeable: textSchema,
		mergedAt: textSchema,
		merged_at: textSchema,
		mergeStateStatus: textSchema,
		merge_state_status: textSchema,
		number: numberSchema,
		repository: repositoryNameSchema,
		state: textSchema,
		statusCheckRollup: checksSchema,
		status_check_rollup: checksSchema,
		title: textSchema,
		updatedAt: textSchema,
		updated_at: textSchema,
		url: textSchema,
		pr_url: textSchema,
	})
	.transform((value): GitPullRequest | null => {
		const url = value.url ?? value.pr_url;
		const urlNumber = url?.match(/\/pulls?\/(\d+)(?:\/|$)/)?.[1];
		const number =
			value.number ?? numberSchema.parse(urlNumber ? Number(urlNumber) : null);
		if (number === null || !url || !value.title) {
			return null;
		}
		return {
			baseRefName: value.baseRefName ?? value.base,
			branch: value.branch ?? value.headRefName,
			commentsCount:
				value.commentsCount ??
				value.comments_count ??
				value.comments?.length ??
				null,
			headRefName: value.headRefName ?? value.branch,
			headRefOid: value.headRefOid ?? value.head_sha,
			isDraft: value.isDraft || value.is_draft,
			mergeStateStatus: value.mergeStateStatus ?? value.merge_state_status,
			mergeable: value.mergeable,
			mergedAt: value.mergedAt ?? value.merged_at,
			number,
			repository: value.repository,
			state: value.state,
			statusCheckRollup: (
				value.statusCheckRollup ??
				value.status_check_rollup ??
				[]
			).flatMap((check) => (check ? [check] : [])),
			title: value.title,
			updatedAt: value.updatedAt ?? value.updated_at,
			url,
		};
	})
	.catch(null);

export const pullRequestResponseSchema = z
	.object({ pull: gitPullRequestWireSchema })
	.catch({ pull: null });
export const gitHubRepositoryResponseSchema = z
	.object({ repository: gitHubRepositoryWireSchema })
	.catch({ repository: null });

const FEEDBACK_KINDS = ["comment", "review", "review_comment"] as const;
const feedbackEntrySchema = z
	.object({
		author: textSchema,
		authorAssociation: textSchema,
		authorType: textSchema,
		body: z.string().catch(""),
		createdAt: textSchema,
		id: textSchema,
		isMinimized: z.boolean().catch(false),
		kind: z.enum(FEEDBACK_KINDS).nullable().catch(null),
		line: numberSchema,
		path: textSchema,
		state: textSchema,
		url: textSchema,
		viewerDidAuthor: z.boolean().catch(false),
	})
	.nullable()
	.catch(null);

/** GitHub App accounts: GraphQL reports them as `Bot` and drops the `[bot]`
 * suffix REST logins carry, so both signals are checked. */
function isBotAuthor(type: string | null, login: string | null): boolean {
	return (
		type?.toLowerCase() === "bot" ||
		Boolean(login?.toLowerCase().endsWith("[bot]"))
	);
}

/** Feedback from the app's `/pulls/:owner/:repo/:number/feedback` route.
 * Entries without a stable id or with an empty body (bare approvals) carry
 * nothing to address and are dropped. */
export const pullRequestFeedbackSchema = z
	.object({ feedback: z.array(feedbackEntrySchema).catch([]) })
	.transform((value): PullRequestFeedback[] =>
		value.feedback.flatMap((entry): PullRequestFeedback[] => {
			const body = entry?.body.trim();
			if (!(entry?.id && entry.kind && body)) {
				return [];
			}
			return [
				{
					author: entry.author,
					authorAssociation: entry.authorAssociation?.toUpperCase() ?? null,
					authorIsBot: isBotAuthor(entry.authorType, entry.author),
					body,
					createdAt: entry.createdAt,
					id: entry.id,
					isMinimized: entry.isMinimized,
					kind: entry.kind,
					line: entry.line,
					path: entry.path,
					state: entry.state,
					url: entry.url,
					viewerDidAuthor: entry.viewerDidAuthor,
				},
			];
		})
	)
	.catch([]);
