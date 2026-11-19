// Runs test files in separate processes, several at a time. Each file still
// gets its own process (Bun's `mock.module` is process-global), but files no
// longer wait for one another. Output is buffered per file and printed whole
// when that file finishes, so concurrent logs never interleave.
//
// Shared by packages/blocks and apps/web (whose private runner imports this
// public file by relative path, never the other way round).
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";

export interface IsolatedTestRun {
	readonly args: readonly string[];
	readonly file: string;
}

export interface IsolatedTestPoolOptions {
	readonly command?: string;
	readonly concurrency?: number;
	readonly env?: NodeJS.ProcessEnv;
	readonly write?: (chunk: string) => void;
}

const DEFAULT_MAX_CONCURRENCY = 4;

export function resolveConcurrency(
	requested: string | undefined,
	cores: number = availableParallelism()
): number {
	const parsed = Number.parseInt(requested ?? "", 10);
	if (Number.isInteger(parsed) && parsed > 0) {
		return parsed;
	}
	return Math.max(1, Math.min(DEFAULT_MAX_CONCURRENCY, cores));
}

function runOne(
	run: IsolatedTestRun,
	command: string,
	env: NodeJS.ProcessEnv
): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		const child = spawn(command, [...run.args], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.on("error", (error) => {
			chunks.push(Buffer.from(`${error.message}\n`));
			resolve({ code: null, output: Buffer.concat(chunks).toString() });
		});
		child.on("close", (code) => {
			resolve({ code, output: Buffer.concat(chunks).toString() });
		});
	});
}

/** Runs every file and resolves with the files that failed, in input order. */
export async function runIsolatedTestFiles(
	runs: readonly IsolatedTestRun[],
	options: IsolatedTestPoolOptions = {}
): Promise<string[]> {
	const command = options.command ?? process.execPath;
	const env = options.env ?? process.env;
	const write = options.write ?? ((chunk) => process.stdout.write(chunk));
	const concurrency = Math.max(
		1,
		options.concurrency ?? resolveConcurrency(process.env.RYU_TEST_CONCURRENCY)
	);
	const failed = new Set<string>();
	let next = 0;

	async function worker(): Promise<void> {
		while (next < runs.length) {
			const run = runs[next];
			next += 1;
			if (!run) {
				continue;
			}
			const { code, output } = await runOne(run, command, env);
			write(output);
			if (code !== 0) {
				failed.add(run.file);
			}
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(concurrency, runs.length) }, worker)
	);
	return runs.map((run) => run.file).filter((file) => failed.has(file));
}
