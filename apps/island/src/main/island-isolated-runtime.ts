// Test-only helper (no shipping importer): run a main-process module scenario in
// a fresh Bun runtime.
//
// `bun test src` executes every Island test file in ONE process, and Bun's
// `mock.module` replacements are process-wide and cannot be undone. A file that
// replaces `electron`, `koffi` or `./config.ts` in-process therefore leaks its
// replacement into every file that runs after it (and inherits earlier files'
// replacements), so a file can pass alone and fail in the full suite. Scenarios
// that must replace an OS boundary run here instead: the replacement lives and
// dies with the child runtime, while the shipping module under test is imported
// by absolute path and its real dependencies load unchanged.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface IsolatedIslandRun {
	/** The scenario's JSON observation (the runtime's whole stdout). */
	result: unknown;
	/** Anything the runtime wrote to stderr; scenarios expect it to be empty. */
	stderr: string;
}

/**
 * Write the scenario returned by `source(root)` to `<root>/run.ts` and execute it
 * in a separate Bun runtime. `root` is a private scratch directory (for example
 * Electron's `userData`) removed afterwards. The runtime must print exactly one
 * JSON document to stdout; a non-zero exit or a budget overrun rejects with its
 * stderr so a crashed scenario can never look like an empty observation.
 */
export async function runIsolatedIslandScenario(
	source: (root: string) => string,
	budgetMs = 10_000
): Promise<IsolatedIslandRun> {
	const root = await mkdtemp(join(tmpdir(), "island-isolated-"));
	let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
	let budget: ReturnType<typeof setTimeout> | null = null;
	try {
		const runner = join(root, "run.ts");
		await writeFile(runner, source(root));
		child = Bun.spawn([process.execPath, runner], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const running = child;
		budget = setTimeout(() => running.kill("SIGKILL"), budgetMs);
		const [stdout, stderr, exit] = await Promise.all([
			new Response(running.stdout).text(),
			new Response(running.stderr).text(),
			running.exited,
		]);
		if (exit !== 0) {
			throw new Error(`Isolated Island runtime exited ${exit}: ${stderr}`);
		}
		return { result: JSON.parse(stdout), stderr };
	} finally {
		if (budget) {
			clearTimeout(budget);
		}
		if (child?.exitCode === null) {
			child.kill("SIGKILL");
		}
		if (child) {
			await child.exited;
		}
		await rm(root, { recursive: true, force: true });
	}
}
