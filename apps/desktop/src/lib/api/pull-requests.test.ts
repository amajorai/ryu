import { describe, expect, test } from "bun:test";
import {
	buildGitHubCompareUrl,
	buildPullRequestCheckReport,
	buildPullRequestMergeConflictReport,
	checkBucket,
	failingPullRequestChecks,
	gitPullRequestStatus,
	normalizeGitHubRepository,
	normalizeGitPullRequest,
	pullRequestHasMergeConflicts,
	selectGitHubCompareBaseBranch,
} from "./pull-requests.ts";

const pullRequest = normalizeGitPullRequest({
	baseRefName: "main",
	headRefName: "codex/ci",
	headRefOid: "abc123",
	commentsCount: 3,
	number: 42,
	repository: { nameWithOwner: "openai/codex" },
	statusCheckRollup: [
		{
			bucket: "pass",
			name: "Type-check",
		},
		{
			bucket: "fail",
			conclusion: "failure",
			description: "Lint failed",
			detailsUrl: "https://github.com/check/1",
			name: "Lint",
			workflowName: "CI",
		},
	],
	title: "Fix CI",
	url: "https://github.com/openai/codex/pull/42",
});

describe("Pull Requests app contract", () => {
	test("preserves normalized and legacy default-branch response shapes", () => {
		expect(
			normalizeGitHubRepository({
				defaultBranch: "develop",
				nameWithOwner: "amajorai/ryu",
				url: "https://github.com/amajorai/ryu",
			})?.defaultBranch
		).toBe("develop");
		expect(
			normalizeGitHubRepository({
				defaultBranchRef: { name: "trunk" },
				nameWithOwner: "amajorai/ryu",
				url: "https://github.com/amajorai/ryu",
			})?.defaultBranch
		).toBe("trunk");
	});

	test("builds a safe compare URL and omits same-branch comparisons", () => {
		const repository = {
			defaultBranch: "main",
			nameWithOwner: "amajorai/ryu",
			url: "https://github.com/amajorai/ryu",
		};
		expect(buildGitHubCompareUrl(repository, "feature/ui", "main")).toBe(
			"https://github.com/amajorai/ryu/compare/main...feature%2Fui?expand=1"
		);
		expect(buildGitHubCompareUrl(repository, "main", "main")).toBeNull();
	});

	test("selects the configured compare base before local defaults", () => {
		expect(selectGitHubCompareBaseBranch("release", "master", [])).toBe(
			"release"
		);
		expect(selectGitHubCompareBaseBranch(null, "master", ["main"])).toBe(
			"master"
		);
		expect(selectGitHubCompareBaseBranch(null, null, ["master"])).toBe(
			"master"
		);
		expect(selectGitHubCompareBaseBranch(null, null, [])).toBe("main");
	});

	test("normalizes app metadata and identifies failing checks", () => {
		expect(pullRequest).not.toBeNull();
		if (!pullRequest) {
			throw new Error("Expected the valid pull request fixture");
		}
		expect(pullRequest?.repository).toBe("openai/codex");
		expect(pullRequest?.commentsCount).toBe(3);
		expect(pullRequest?.statusCheckRollup).toHaveLength(2);
		expect(
			checkBucket(
				pullRequest?.statusCheckRollup[1] ?? {
					bucket: null,
					conclusion: null,
					description: null,
					detailsUrl: null,
					name: null,
					state: null,
					status: null,
					workflowName: null,
				}
			)
		).toBe("fail");
		expect(failingPullRequestChecks(pullRequest)).toHaveLength(1);
		const fallback = normalizeGitPullRequest({
			pr_url: "https://github.com/openai/codex/pull/552",
			title: "Fix CI",
		});
		expect(fallback?.number).toBe(552);
	});

	test("maps GitHub pull request states to the shared status set", () => {
		expect(
			gitPullRequestStatus({ isDraft: false, mergedAt: null, state: "OPEN" })
		).toBe("open");
		expect(
			gitPullRequestStatus({ isDraft: true, mergedAt: null, state: "OPEN" })
		).toBe("draft");
		expect(
			gitPullRequestStatus({ isDraft: false, mergedAt: null, state: "CLOSED" })
		).toBe("closed");
		expect(
			gitPullRequestStatus({
				isDraft: false,
				mergedAt: "2026-08-19T10:00:00Z",
				state: "CLOSED",
			})
		).toBe("merged");
	});

	test("detects merge conflicts without treating other merge blocks as conflicts", () => {
		const conflicting = normalizeGitPullRequest({
			mergeStateStatus: "DIRTY",
			mergeable: "CONFLICTING",
			number: 43,
			title: "Resolve branch drift",
			url: "https://github.com/openai/codex/pull/43",
		});
		const blocked = normalizeGitPullRequest({
			mergeStateStatus: "BLOCKED",
			mergeable: "MERGEABLE",
			number: 44,
			title: "Wait for review",
			url: "https://github.com/openai/codex/pull/44",
		});

		expect(conflicting).not.toBeNull();
		if (!(conflicting && blocked)) {
			throw new Error("Expected both valid pull request fixtures");
		}
		expect(pullRequestHasMergeConflicts(conflicting)).toBe(true);
		expect(pullRequestHasMergeConflicts(blocked)).toBe(false);
		expect(buildPullRequestMergeConflictReport(conflicting)).toContain(
			"Merge state: DIRTY"
		);
	});

	test("builds a bounded text report with failing check context", () => {
		if (!pullRequest) {
			throw new Error("Expected the valid pull request fixture");
		}
		const report = buildPullRequestCheckReport(pullRequest);
		expect(report).toContain("#42 Fix CI");
		expect(report).toContain("Lint");
		expect(report).toContain("https://github.com/check/1");
		expect(report).toContain("Comments: 3");
		expect(report.length).toBeLessThanOrEqual(12_000);
	});
});

describe("Pull request wire fallbacks", () => {
	test("keeps legacy aliases, count fallbacks, and check metadata", () => {
		const result = normalizeGitPullRequest({
			pr_url: " https://github.com/owner/project/pulls/73 ",
			title: " Legacy response ",
			number: -1,
			commentsCount: -1,
			comments_count: 0,
			comments: [null, {}],
			base: " main ",
			branch: " feature ",
			head_sha: " abc ",
			is_draft: true,
			repository: { name: " owner/project " },
			status_check_rollup: [
				false,
				null,
				[],
				{
					link: " https://ci.example/check ",
					workflow: " CI ",
					bucket: "fail",
				},
			],
		});
		expect(result?.number).toBe(73);
		expect(result?.commentsCount).toBe(0);
		expect(result?.isDraft).toBe(true);
		expect(result?.repository).toBe("owner/project");
		expect(result?.headRefOid).toBe("abc");
		expect(result?.statusCheckRollup).toHaveLength(2);
		expect(result?.statusCheckRollup[0]?.name).toBeNull();
		expect(result?.statusCheckRollup[1]?.detailsUrl).toBe(
			"https://ci.example/check"
		);
		expect(result?.statusCheckRollup[1]?.workflowName).toBe("CI");
	});

	test("keeps empty preferred rollups and rejects missing identity fields", () => {
		const input = {
			number: 1,
			title: "valid",
			url: "https://github.com/a/b/pull/1",
			statusCheckRollup: [],
			status_check_rollup: [{ bucket: "fail" }],
		};
		expect(normalizeGitPullRequest(input)?.statusCheckRollup).toEqual([]);
		expect(normalizeGitPullRequest({ ...input, title: " " })).toBeNull();
		expect(
			normalizeGitPullRequest({
				...input,
				number: Number.MAX_SAFE_INTEGER + 1,
				url: "https://github.com/a/b",
			})
		).toBeNull();
		for (const value of [null, false, "invalid", []]) {
			expect(normalizeGitPullRequest(value)).toBeNull();
			expect(normalizeGitHubRepository(value)).toBeNull();
		}
	});

	test("keeps legacy default branch and per-field invalid-value fallbacks", () => {
		expect(
			normalizeGitHubRepository({
				nameWithOwner: " a/b ",
				url: " https://github.com/a/b ",
				defaultBranch: false,
				defaultBranchRef: { name: " trunk " },
			})
		).toEqual({
			defaultBranch: "trunk",
			nameWithOwner: "a/b",
			url: "https://github.com/a/b",
		});
		expect(
			normalizeGitHubRepository({
				nameWithOwner: "a/b",
				url: "https://github.com/a/b",
				defaultBranchRef: " main ",
			})?.defaultBranch
		).toBe("main");
	});
});
