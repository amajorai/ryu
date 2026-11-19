import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseStagedRaw } from "../cli/secrets-scan-git.ts";
import { fakeNode, runSecrets } from "./secrets-fixture.ts";
import {
	detectorNode,
	LEAKED_VALUE,
	scannedFiles,
	type TempRepo,
	tempRepo,
	unreachableNode,
} from "./secrets-scan-fixture.ts";

let repo: TempRepo;

beforeEach(async () => {
	repo = await tempRepo();
});

afterEach(async () => {
	await repo.remove();
});

function scanIn(
	argv: string[],
	node: ReturnType<typeof fakeNode>,
	env: Record<string, string> = {}
) {
	return runSecrets(["scan", ...argv], node, {
		cwd: repo.dir,
		env: { ...repo.env, ...env },
	});
}

/** Everything a command printed, on either stream. */
function printed(result: { err: string; out: string }): string {
	return `${result.out}${result.err}`;
}

test("--staged scans the staged blob, not the working-tree file", async () => {
	await writeFile(join(repo.dir, "clean.txt"), "nothing here\n");
	repo.git("add", "clean.txt");
	repo.git("commit", "-q", "-m", "base");
	const leaked = `one\ntwo\nconst key = "${LEAKED_VALUE}";\n`;
	await writeFile(join(repo.dir, "config.ts"), leaked);
	repo.git("add", "config.ts");
	// The working tree no longer holds the value; the index still does.
	await writeFile(join(repo.dir, "config.ts"), "one\ntwo\nthree\n");
	await writeFile(join(repo.dir, "untracked.ts"), `"${LEAKED_VALUE}"`);

	const node = detectorNode();
	const result = await scanIn(["--staged"], node);

	expect(result.code).toBe(1);
	expect(scannedFiles(node)).toEqual([{ path: "config.ts", content: leaked }]);
	expect(result.out).toContain("config.ts:3:14 aws-access-key-id AKIA…UTST");
	expect(result.err).toContain("1 finding in 1 file");
	expect(printed(result)).not.toContain(LEAKED_VALUE);
});

test("--staged passes when only the working tree holds a credential", async () => {
	await writeFile(
		join(repo.dir, "config.ts"),
		"const key = process.env.KEY;\n"
	);
	repo.git("add", "config.ts");
	await writeFile(
		join(repo.dir, "config.ts"),
		`const key = "${LEAKED_VALUE}";\n`
	);

	const node = detectorNode();
	const result = await scanIn(["--staged"], node);

	expect(result.code).toBe(0);
	expect(scannedFiles(node)).toEqual([
		{ path: "config.ts", content: "const key = process.env.KEY;\n" },
	]);
	expect(result.out).toContain("No secrets found in 1 file.");
});

test("--staged skips deleted and binary files and reads only changed ones", async () => {
	await writeFile(join(repo.dir, "keep.txt"), `${LEAKED_VALUE}\n`);
	await writeFile(join(repo.dir, "gone.txt"), "bye\n");
	repo.git("add", ".");
	repo.git("commit", "-q", "-m", "base");
	repo.git("rm", "-q", "gone.txt");
	await writeFile(join(repo.dir, "image.bin"), new Uint8Array([1, 0, 2]));
	await writeFile(join(repo.dir, "new.txt"), "fresh\n");
	repo.git("add", ".");

	const node = detectorNode();
	const result = await scanIn(["--staged", "--json"], node);

	expect(result.code).toBe(0);
	expect(scannedFiles(node).map((file) => file.path)).toEqual(["new.txt"]);
	expect(JSON.parse(result.out)).toEqual({ files: 1, findings: [] });
});

test("parseStagedRaw keeps paths with spaces and drops gitlinks and symlinks", () => {
	const id = "a".repeat(40);
	const raw = [
		`:000000 100644 ${"0".repeat(40)} ${id} A`,
		"dir/with space.txt",
		`:000000 160000 ${"0".repeat(40)} ${id} A`,
		"submodule",
		`:000000 120000 ${"0".repeat(40)} ${id} A`,
		"link",
		"",
	].join("\0");
	expect(parseStagedRaw(raw)).toEqual([
		{ blob: id, path: "dir/with space.txt" },
	]);
});

test("Core unreachable fails closed with exit 3", async () => {
	await writeFile(join(repo.dir, "a.txt"), "x\n");
	repo.git("add", "a.txt");

	const result = await scanIn(["--staged"], unreachableNode());

	expect(result.code).toBe(3);
	expect(result.err).toContain("Could not reach Core at http://node.test");
	expect(result.err).toContain("--allow-offline");
});

test("--allow-offline and RYU_SECRETS_SCAN_ALLOW_OFFLINE=1 let an unreachable scan pass", async () => {
	await writeFile(join(repo.dir, "a.txt"), "x\n");
	repo.git("add", "a.txt");

	const flagged = await scanIn(
		["--staged", "--allow-offline"],
		unreachableNode()
	);
	expect(flagged.code).toBe(0);
	expect(flagged.err).toContain("skipping the secret scan");

	const viaEnv = await scanIn(["--staged"], unreachableNode(), {
		RYU_SECRETS_SCAN_ALLOW_OFFLINE: "1",
	});
	expect(viaEnv.code).toBe(0);
});

test("allow-offline never excuses a Core that answered with an error", async () => {
	await writeFile(join(repo.dir, "a.txt"), "x\n");
	repo.git("add", "a.txt");
	const node = fakeNode({
		"POST /api/vault/scan": () =>
			Response.json({ error: "vault sealed" }, { status: 503 }),
	});

	const result = await scanIn(["--staged", "--allow-offline"], node);

	expect(result.code).toBe(3);
	expect(result.err).toContain("The secret scan could not run");
});

test("--staged outside a git repository exits 3", async () => {
	const result = await runSecrets(["scan", "--staged"], detectorNode(), {
		cwd: join(repo.dir, ".."),
		env: repo.env,
	});
	expect(result.code).toBe(3);
	expect(result.err).toContain("git diff failed");
});

test("an AI agent session may scan, and no output holds the value", async () => {
	await writeFile(join(repo.dir, ".env"), `KEY=${LEAKED_VALUE}\n`);
	repo.git("add", ".env");

	const human = await scanIn(["--staged"], detectorNode(), { CLAUDECODE: "1" });
	expect(human.code).toBe(1);
	expect(human.out).toContain(".env:1:5 aws-access-key-id AKIA…UTST");
	expect(printed(human)).not.toContain(LEAKED_VALUE);

	const machine = await scanIn(["--staged", "--json"], detectorNode(), {
		CLAUDECODE: "1",
	});
	expect(machine.code).toBe(1);
	expect(JSON.parse(machine.out).findings[0].preview).toBe("AKIA…UTST");
	expect(printed(machine)).not.toContain(LEAKED_VALUE);
});

test("--staged rejects paths and --history", async () => {
	const withPath = await scanIn(["--staged", "src"], detectorNode());
	expect(withPath.code).toBe(2);
	const both = await scanIn(["--staged", "--history"], detectorNode());
	expect(both.code).toBe(2);
});

test("a path scan also exits 3 when Core is unreachable", async () => {
	await writeFile(join(repo.dir, "a.txt"), "x\n");
	const result = await runSecrets(["scan", repo.dir], unreachableNode(), {
		env: repo.env,
	});
	expect(result.code).toBe(3);
});

test("secrets help documents the scan modes and exit codes", async () => {
	const result = await runSecrets(["help"], detectorNode());
	for (const text of [
		"scan --staged",
		"scan --history [REV-RANGE] [--max-commits N]",
		"scan install-hook [--force]",
		"RYU_SECRETS_SCAN_ALLOW_OFFLINE=1",
	]) {
		expect(result.out).toContain(text);
	}
});
