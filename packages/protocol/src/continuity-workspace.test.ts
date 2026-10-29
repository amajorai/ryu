import { describe, expect, it } from "bun:test";
import transcriptFixture from "../fixtures/continuity-v0.json" with {
	type: "json",
};
import workspaceFixture from "../fixtures/continuity-workspace-v0.json" with {
	type: "json",
};
import {
	isCredentialFreeRemoteUrl,
	isSafeRepoRelativePath,
	parseRnpCapabilities,
	parseRnpContinuityBundle,
	parseRnpWorkspaceInspection,
	parseRnpWorkspaceManifest,
	parseRnpWorkspaceResumeResult,
	RNP_WORKSPACE_LIMITS,
	type RnpWorkspaceManifestV0,
} from "./continuity.ts";

function manifest(): RnpWorkspaceManifestV0 {
	return structuredClone(workspaceFixture) as RnpWorkspaceManifestV0;
}

function withDiffFiles(
	files: NonNullable<RnpWorkspaceManifestV0["diff"]>["files"]
): RnpWorkspaceManifestV0 {
	const value = manifest();
	if (!value.diff) {
		throw new Error("Fixture must carry a diff");
	}
	value.diff.files = files;
	value.untracked = [];
	return value;
}

describe("RNP workspace manifest", () => {
	it("accepts the shared cross-language fixture unchanged", () => {
		const parsed = parseRnpWorkspaceManifest(workspaceFixture);
		expect(parsed).toEqual({ ok: true, value: manifest() });
		expect(parseRnpWorkspaceManifest(JSON.stringify(workspaceFixture)).ok).toBe(
			true
		);
	});

	it("leaves the v0 transcript bundle contract unchanged", () => {
		const parsed = parseRnpContinuityBundle(transcriptFixture);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(Object.keys(parsed.value)).not.toContain("workspace");
		}
	});

	it("rejects every unsafe path form", () => {
		for (const path of [
			"",
			"/etc/passwd",
			"\\\\server\\share\\x",
			"a\\b",
			"C:/Windows/system32",
			"c:relative",
			"a/../b",
			"./a",
			"a//b",
			"a/",
			".git/config",
			"sub/.GIT/hooks/pre-commit",
			"GIT~1/config",
			"dir./file",
			"dir /file",
			"a\u0000b",
			"a\nb",
			"x".repeat(RNP_WORKSPACE_LIMITS.pathBytes + 1),
		]) {
			expect(isSafeRepoRelativePath(path)).toBe(false);
			const parsed = parseRnpWorkspaceManifest(
				withDiffFiles([
					{ path, status: "added", binary: false, sensitive: false },
				])
			);
			expect(parsed.ok).toBe(false);
		}
		for (const path of ["src/main.rs", ".env", "dir/.gitignore", "x.git/y"]) {
			expect(isSafeRepoRelativePath(path)).toBe(true);
		}
	});

	it("rejects duplicate and colliding paths", () => {
		const file = {
			path: "README.md",
			status: "modified" as const,
			binary: false,
			sensitive: false,
		};
		expect(parseRnpWorkspaceManifest(withDiffFiles([file, file])).ok).toBe(
			false
		);
		const caseCollision = parseRnpWorkspaceManifest(
			withDiffFiles([file, { ...file, path: "readme.md" }])
		);
		expect(caseCollision.ok).toBe(false);
		const nfcCollision = parseRnpWorkspaceManifest(
			withDiffFiles([
				{ ...file, path: "caf\u00e9.txt" },
				{ ...file, path: "cafe\u0301.txt" },
			])
		);
		expect(nfcCollision.ok).toBe(false);
	});

	it("enforces the size and count caps", () => {
		const oversizedBundle = manifest();
		if (oversizedBundle.commits) {
			oversizedBundle.commits.blob.bytes = RNP_WORKSPACE_LIMITS.bundleBytes + 1;
		}
		const bundleResult = parseRnpWorkspaceManifest(oversizedBundle);
		expect(bundleResult.ok).toBe(false);
		if (!bundleResult.ok) {
			expect(bundleResult.error.code).toBe("limit-exceeded");
		}

		const oversizedDiff = manifest();
		if (oversizedDiff.diff) {
			oversizedDiff.diff.blob.bytes = RNP_WORKSPACE_LIMITS.diffBytes + 1;
		}
		expect(parseRnpWorkspaceManifest(oversizedDiff).ok).toBe(false);

		const files = Array.from(
			{ length: RNP_WORKSPACE_LIMITS.untrackedCount + 1 },
			(_, index) => ({
				path: `new/${index}.txt`,
				status: "added" as const,
				bytes: 1,
				binary: false,
				sensitive: false,
			})
		);
		const tooManyUntracked = withDiffFiles(files);
		tooManyUntracked.untracked = files;
		const untrackedResult = parseRnpWorkspaceManifest(tooManyUntracked);
		expect(untrackedResult.ok).toBe(false);
		if (!untrackedResult.ok) {
			expect(untrackedResult.error.code).toBe("limit-exceeded");
		}

		const bigUntracked = manifest();
		const first = bigUntracked.untracked[0];
		if (first) {
			first.bytes = RNP_WORKSPACE_LIMITS.untrackedFileBytes + 1;
		}
		expect(parseRnpWorkspaceManifest(bigUntracked).ok).toBe(false);
	});

	it("requires untracked files to ride in the diff", () => {
		const value = manifest();
		value.untracked = [
			{
				path: "elsewhere.txt",
				status: "added",
				binary: false,
				sensitive: false,
			},
		];
		expect(parseRnpWorkspaceManifest(value).ok).toBe(false);
	});

	it("rejects remote URLs that carry credentials or local paths", () => {
		for (const url of [
			"https://token@github.com/a/b.git",
			"https://user:pw@github.com/a/b.git",
			"ssh://alice@example.com/a/b.git",
			"ssh://git:pw@example.com/a/b.git",
			"http://github.com/a/b.git",
			"file:///srv/repo.git",
			"/srv/repo.git",
			"https://github.com/a/b.git?token=1",
		]) {
			expect(isCredentialFreeRemoteUrl(url)).toBe(false);
			const value = manifest();
			value.repo.remoteUrl = url;
			expect(parseRnpWorkspaceManifest(value).ok).toBe(false);
		}
		for (const url of [
			"https://github.com/a/b.git",
			"git@github.com:a/b.git",
			"ssh://git@example.com/a/b.git",
		]) {
			expect(isCredentialFreeRemoteUrl(url)).toBe(true);
		}
	});

	it("rejects a bundle whose tip is not the base commit", () => {
		const value = manifest();
		if (value.commits) {
			value.commits.tip = "3".repeat(40);
		}
		expect(parseRnpWorkspaceManifest(value).ok).toBe(false);
	});
});

describe("RNP workspace replies", () => {
	it("parses an inspection with sensitive candidates", () => {
		const parsed = parseRnpWorkspaceInspection({
			version: 0,
			conversationId: "conversation-1",
			repo: { name: "repo", baseCommit: "2".repeat(40) },
			unpushedCommits: 0,
			changed: [],
			untrackedCandidates: [
				{ path: ".env", bytes: 9, sensitive: true, selectable: true },
				{
					path: "nested/",
					bytes: 0,
					sensitive: false,
					selectable: false,
					reason: "submodule",
				},
			],
			diffStat: { files: 0, insertions: 0, deletions: 0 },
		});
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.value.untrackedCandidates[0]?.sensitive).toBe(true);
		}
	});

	it("drops unknown warnings and parses the resume result", () => {
		const parsed = parseRnpWorkspaceResumeResult({
			version: 0,
			workspaceId: "workspace-1",
			conversationId: "conversation-1",
			status: "created",
			folderPath: "/home/me/Documents/Ryu/handoffs/repo-abc",
			worktreePath: "/home/me/Documents/Ryu/handoffs/repo-abc/.ryu-worktrees/x",
			branch: "handoff/abc",
			warnings: ["workspace-untrusted", "from-the-future"],
		});
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.value.warnings).toEqual(["workspace-untrusted"]);
		}
	});

	it("parses capabilities", () => {
		expect(
			parseRnpCapabilities({ version: 0, features: ["workspace"] })
		).toEqual({ ok: true, value: { version: 0, features: ["workspace"] } });
		expect(parseRnpCapabilities({ version: 1, features: [] }).ok).toBe(false);
	});
});
