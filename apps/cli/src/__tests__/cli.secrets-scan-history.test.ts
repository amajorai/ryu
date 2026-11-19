import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scanHistory, unquoteGitPath } from "../cli/secrets-scan-history.ts";
import { runSecrets } from "./secrets-fixture.ts";
import {
	detectorNode,
	LEAKED_VALUE,
	scannedFiles,
	type TempRepo,
	tempRepo,
} from "./secrets-scan-fixture.ts";

let repo: TempRepo;

beforeEach(async () => {
	repo = await tempRepo();
});

afterEach(async () => {
	await repo.remove();
});

async function commit(files: Record<string, string>, message: string) {
	for (const [path, content] of Object.entries(files)) {
		await writeFile(join(repo.dir, path), content);
	}
	repo.git("add", ".");
	repo.git("commit", "-q", "-m", message);
	return repo.git("rev-parse", "HEAD");
}

function scanIn(argv: string[], node = detectorNode()) {
	return runSecrets(["scan", "--history", ...argv], node, {
		cwd: repo.dir,
		env: repo.env,
	});
}

interface JsonHistory {
	commits: number;
	findings: { column: number; commit: string; line: number; path: string }[];
	limited: boolean;
}

test("--history maps each finding to the commit, path and line that added it", async () => {
	const first = await commit(
		{ "a.txt": `header\nkey=${LEAKED_VALUE}\n` },
		"add a"
	);
	await commit({ "b.txt": "clean\n" }, "add b");
	const lines = ["1", "2", "3", "4", "5", "6", "7"];
	await commit({ "c.txt": `${lines.join("\n")}\n` }, "add c");
	lines.splice(5, 0, `token: ${LEAKED_VALUE}`);
	const fourth = await commit({ "c.txt": `${lines.join("\n")}\n` }, "edit c");

	const node = detectorNode();
	const result = await scanIn(["--json"], node);

	expect(result.code).toBe(1);
	const body = JSON.parse(result.out) as JsonHistory;
	expect(body.commits).toBe(4);
	expect(body.limited).toBe(false);
	expect(
		body.findings.map(({ commit: sha, path, line, column }) => ({
			sha,
			path,
			line,
			column,
		}))
	).toEqual([
		{ sha: fourth, path: "c.txt", line: 6, column: 8 },
		{ sha: first, path: "a.txt", line: 2, column: 5 },
	]);
	// Only added lines reach Core: the edit sends one line, not the whole file.
	const sent = scannedFiles(node).find((file) =>
		file.path?.startsWith(fourth.slice(0, 12))
	);
	expect(sent?.content).toBe(`token: ${LEAKED_VALUE}`);
	expect(result.out).not.toContain(LEAKED_VALUE);

	const human = await scanIn([]);
	expect(human.out).toContain(
		`${fourth.slice(0, 12)} c.txt:6:8 aws-access-key-id AKIA…UTST`
	);
	expect(human.err).toContain("2 findings in 4 commits");
	expect(human.out + human.err).not.toContain(LEAKED_VALUE);
});

test("--history stops at --max-commits and says older commits were skipped", async () => {
	await commit({ "old.txt": `${LEAKED_VALUE}\n` }, "old leak");
	await commit({ "mid.txt": "fine\n" }, "mid");
	await commit({ "new.txt": "fine\n" }, "new");

	const limited = await scanIn(["--max-commits", "2"]);
	expect(limited.code).toBe(0);
	expect(limited.out).toContain("No secrets found in 2 commits.");
	expect(limited.err).toContain("Scanned only the 2 newest commits");

	const all = await scanIn(["--max-commits", "3", "--json"]);
	expect(all.code).toBe(1);
	expect((JSON.parse(all.out) as JsonHistory).limited).toBe(false);

	expect((await scanIn(["--max-commits", "0"])).code).toBe(2);
});

test("--history takes a revision range", async () => {
	await commit({ "a.txt": `${LEAKED_VALUE}\n` }, "leak");
	const base = await commit({ "b.txt": "x\n" }, "base");
	await commit({ "c.txt": "y\n" }, "after");

	const result = await scanIn([`${base}..HEAD`, "--json"]);
	expect(result.code).toBe(0);
	expect((JSON.parse(result.out) as JsonHistory).commits).toBe(1);

	expect((await scanIn(["no-such-rev"])).code).toBe(3);
});

test("--history sends identical added content once and reports every commit", async () => {
	const content = `id=${LEAKED_VALUE}\n`;
	const first = await commit({ "one.txt": content }, "one");
	const second = await commit({ "two.txt": content }, "two");

	const node = detectorNode();
	const result = await scanIn(["--json"], node);

	expect(scannedFiles(node)).toHaveLength(1);
	const body = JSON.parse(result.out) as JsonHistory;
	expect(body.findings.map((item) => [item.commit, item.path])).toEqual([
		[second, "two.txt"],
		[first, "one.txt"],
	]);
});

test("scanHistory separates hunks and maps lines across them", async () => {
	const sha = "f".repeat(40);
	const log = [
		`\u0001${sha}`,
		"",
		"diff --git a/x.txt b/x.txt",
		"--- a/x.txt",
		"+++ b/x.txt",
		"@@ -2,0 +3 @@",
		"+first",
		"@@ -9 +10,2 @@",
		"-gone",
		"+++ not a header",
		"+second",
		"diff --git a/y.bin b/y.bin",
		"Binary files a/y.bin and b/y.bin differ",
	];
	const sent: string[] = [];
	const result = await scanHistory(
		async (_args, onLine) => {
			for (const line of log) {
				await onLine(line);
			}
		},
		[],
		10,
		(files) => {
			sent.push(...files.map((file) => file.content));
			return Promise.resolve([
				{
					rule: "r",
					description: "d",
					source: files[0]?.path,
					line: 4,
					column: 1,
					preview: "p",
					fingerprint: "f",
				},
			]);
		}
	);
	expect(sent).toEqual(["first\n\n++ not a header\nsecond"]);
	expect(result.findings.map((item) => [item.path, item.line])).toEqual([
		["x.txt", 11],
	]);
});

test("unquoteGitPath decodes git's C-style quoting", () => {
	expect(unquoteGitPath("plain/path.txt")).toBe("plain/path.txt");
	expect(unquoteGitPath('"b/a\\"q\\tb.txt"')).toBe('b/a"q\tb.txt');
	expect(unquoteGitPath('"b/caf\\303\\251.txt"')).toBe("b/café.txt");
});
