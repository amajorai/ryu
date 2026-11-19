import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import {
	CHAINED_HOOK_NAME,
	HOOK_COMMAND,
	HOOK_MARKER,
	hookScript,
	huskyDirectoryOf,
} from "../cli/secrets-scan-hook.ts";
import { fakeNode, runSecrets } from "./secrets-fixture.ts";
import { type TempRepo, tempRepo } from "./secrets-scan-fixture.ts";

let repo: TempRepo;

beforeEach(async () => {
	repo = await tempRepo();
});

afterEach(async () => {
	await repo.remove();
});

function hookCommand(action: string, ...flags: string[]) {
	return runSecrets(["scan", action, ...flags], fakeNode({}), {
		cwd: repo.dir,
		env: repo.env,
	});
}

const defaultHook = () => join(repo.dir, ".git", "hooks", "pre-commit");

const isWindows = process.platform === "win32";

/** Git runs hooks with its bundled `sh` on Windows; use the same one here. */
function hookShell(): { sh: string; systemPath: string } {
	if (!isWindows) {
		return { sh: "/bin/sh", systemPath: "/usr/bin:/bin" };
	}
	const gitRoot = resolve(
		spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim(),
		"..",
		"..",
		".."
	);
	const usrBin = join(gitRoot, "usr", "bin");
	return { sh: join(usrBin, "sh.exe"), systemPath: usrBin };
}

/** Run the installed hook with a fake `ryu-cli` that exits `scanExit`. */
async function runHook(
	path: string,
	scanExit: number | null,
	env: Record<string, string> = {}
) {
	const bin = join(repo.dir, "..", "bin");
	await mkdir(bin, { recursive: true });
	const fake = join(bin, "ryu-cli");
	if (scanExit === null) {
		await writeFile(fake, "");
		await chmod(fake, 0o644);
	} else {
		await writeFile(
			fake,
			`#!/bin/sh\necho "ran $*" >> "${bin}/calls"\nexit ${scanExit}\n`
		);
		await chmod(fake, 0o755);
	}
	const { sh, systemPath } = hookShell();
	const run = spawnSync(sh, [path], {
		cwd: repo.dir,
		encoding: "utf8",
		env: { ...repo.env, PATH: `${bin}${delimiter}${systemPath}`, ...env },
	});
	const calls = existsSync(join(bin, "calls"))
		? await readFile(join(bin, "calls"), "utf8")
		: "";
	return { calls, code: run.status, stderr: run.stderr };
}

test("install-hook writes an executable pre-commit hook and is idempotent", async () => {
	const first = await hookCommand("install-hook");
	expect(first.code).toBe(0);
	expect(first.out).toContain(
		`Installed the pre-commit hook at ${defaultHook()}`
	);
	const script = await readFile(defaultHook(), "utf8");
	expect(script).toBe(hookScript(false));
	expect(script).toContain(`exec ${HOOK_COMMAND}`);
	if (!isWindows) {
		// Windows has no exec bits; Git's `sh` runs a hook by its shebang.
		expect((await stat(defaultHook())).mode & 0o111).not.toBe(0);
	}

	const again = await hookCommand("install-hook");
	expect(again.code).toBe(0);
	expect(again.out).toContain("is already installed");
	expect(await readFile(defaultHook(), "utf8")).toBe(script);
	expect(existsSync(join(repo.dir, ".git", "hooks", CHAINED_HOOK_NAME))).toBe(
		false
	);
});

test("install-hook refuses to clobber a hook, and --force chains it", async () => {
	const theirs = "#!/bin/sh\necho theirs >&2\nexit 7\n";
	await mkdir(join(repo.dir, ".git", "hooks"), { recursive: true });
	await writeFile(defaultHook(), theirs, { mode: 0o755 });

	const refused = await hookCommand("install-hook");
	expect(refused.code).toBe(1);
	expect(refused.err).toContain(
		"Refusing to replace the existing pre-commit hook"
	);
	expect(refused.err).toContain(HOOK_COMMAND);
	expect(await readFile(defaultHook(), "utf8")).toBe(theirs);

	const forced = await hookCommand("install-hook", "--force");
	expect(forced.code).toBe(0);
	const chained = join(repo.dir, ".git", "hooks", CHAINED_HOOK_NAME);
	expect(await readFile(chained, "utf8")).toBe(theirs);
	expect(await readFile(defaultHook(), "utf8")).toBe(hookScript(true));

	// The previous hook runs first and its failure blocks before the scan.
	const blocked = await runHook(defaultHook(), 0);
	expect(blocked.code).toBe(7);
	expect(blocked.calls).toBe("");

	const removed = await hookCommand("uninstall-hook");
	expect(removed.code).toBe(0);
	expect(removed.out).toContain("restored the previous hook");
	expect(await readFile(defaultHook(), "utf8")).toBe(theirs);
	expect(existsSync(chained)).toBe(false);
});

test("install-hook follows core.hooksPath", async () => {
	repo.git("config", "core.hooksPath", ".githooks");
	const result = await hookCommand("install-hook");
	expect(result.code).toBe(0);
	const hook = join(repo.dir, ".githooks", "pre-commit");
	expect(await readFile(hook, "utf8")).toContain(HOOK_MARKER);
	expect(existsSync(defaultHook())).toBe(false);

	expect((await hookCommand("uninstall-hook")).code).toBe(0);
	expect(existsSync(hook)).toBe(false);
	const none = await hookCommand("uninstall-hook");
	expect(none.out).toContain("No pre-commit hook is installed");
});

test("a husky repository gets the line to add instead of a written hook", async () => {
	repo.git("config", "core.hooksPath", ".husky/_");
	await mkdir(join(repo.dir, ".husky", "_"), { recursive: true });
	await writeFile(join(repo.dir, ".husky", "pre-commit"), "bun run lint\n");

	const result = await hookCommand("install-hook");
	expect(result.code).toBe(1);
	expect(result.err).toContain("Husky manages this repository's hooks");
	expect(result.err).toContain(
		`${join(repo.dir, ".husky", "pre-commit")}: ${HOOK_COMMAND}`
	);
	expect(existsSync(join(repo.dir, ".husky", "_", "pre-commit"))).toBe(false);
	expect(await readFile(join(repo.dir, ".husky", "pre-commit"), "utf8")).toBe(
		"bun run lint\n"
	);

	await writeFile(
		join(repo.dir, ".husky", "pre-commit"),
		`bun run lint\n${HOOK_COMMAND}\n`
	);
	const wired = await hookCommand("install-hook");
	expect(wired.code).toBe(0);
	expect(wired.out).toContain("already runs the secret scan");
});

test("uninstall-hook leaves a hook it did not install", async () => {
	await mkdir(join(repo.dir, ".git", "hooks"), { recursive: true });
	await writeFile(defaultHook(), "#!/bin/sh\nexit 0\n");
	const result = await hookCommand("uninstall-hook");
	expect(result.code).toBe(1);
	expect(await readFile(defaultHook(), "utf8")).toBe("#!/bin/sh\nexit 0\n");
});

test("the hook passes the scan's exit code and fails closed without ryu-cli", async () => {
	expect((await hookCommand("install-hook")).code).toBe(0);

	const clean = await runHook(defaultHook(), 0);
	expect(clean.code).toBe(0);
	expect(clean.calls).toBe("ran secrets scan --staged\n");
	expect((await runHook(defaultHook(), 1)).code).toBe(1);
	expect((await runHook(defaultHook(), 3)).code).toBe(3);

	const missing = await runHook(defaultHook(), null);
	expect(missing.code).toBe(3);
	expect(missing.stderr).toContain("ryu-cli is not on PATH");
	const allowed = await runHook(defaultHook(), null, {
		RYU_SECRETS_SCAN_ALLOW_OFFLINE: "1",
	});
	expect(allowed.code).toBe(0);
});

test("huskyDirectoryOf finds the .husky segment", () => {
	expect(huskyDirectoryOf("/r/.husky/_")).toBe("/r/.husky");
	expect(huskyDirectoryOf("/r/.husky")).toBe("/r/.husky");
	expect(huskyDirectoryOf("/r/.githooks")).toBeNull();
	expect(huskyDirectoryOf("C:\\r\\.husky\\_")).toBe("C:\\r\\.husky");
	expect(huskyDirectoryOf("C:/r/.husky/_")).toBe("C:/r/.husky");
});
