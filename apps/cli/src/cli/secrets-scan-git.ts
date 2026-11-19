// Git plumbing for `ryu-cli secrets scan --staged` and `--history`.
//
// Git runs with `ctx.env` and `ctx.cwd`, so a pre-commit hook's own
// `GIT_INDEX_FILE` (a partial `git commit -- <paths>` stages into a temporary
// index) is honoured, and tests point it at a temporary repository. Content is
// read from git objects only: the staged scan never opens working-tree files,
// which can differ from what the commit records.

import type { VaultScanFile } from "@ryuhq/core-client/vault";
import { LocalizedError, localize } from "./localizedText.ts";
import type { CliContext } from "./types.ts";

export const MAX_SCAN_FILE_BYTES = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;
/** Gitlinks (submodules) and symlinks have no file content to scan. */
const UNSCANNED_MODES = new Set(["160000", "120000"]);

/** Git could not run or refused the command (not a repository, bad revision). */
export class GitCommandError extends LocalizedError {}

export function isBinary(bytes: Uint8Array): boolean {
	return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

export function gitWorkingDirectory(ctx: CliContext): string {
	return ctx.cwd ?? process.cwd();
}

function gitEnvironment(ctx: CliContext): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(ctx.env)) {
		if (value !== undefined) {
			env[name] = value;
		}
	}
	return env;
}

function spawnGit(ctx: CliContext, args: string[], input?: Uint8Array) {
	try {
		return Bun.spawn(["git", ...args], {
			cwd: gitWorkingDirectory(ctx),
			env: gitEnvironment(ctx),
			stdin: input ?? "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		throw new GitCommandError(
			localize("Could not run git: {message}", {
				message: error instanceof Error ? error.message : String(error),
			})
		);
	}
}

function gitFailure(args: string[], stderr: string): GitCommandError {
	const detail = stderr.trim().split("\n")[0] ?? "";
	return new GitCommandError(
		localize("git {command} failed: {detail}", {
			command:
				args.find(
					(arg, index) => !arg.startsWith("-") && args[index - 1] !== "-c"
				) ?? "",
			detail,
		})
	);
}

/** Run git to completion and return its stdout bytes. */
export async function runGit(
	ctx: CliContext,
	args: string[],
	input?: Uint8Array
): Promise<Uint8Array> {
	const proc = spawnGit(ctx, args, input);
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		throw gitFailure(args, stderr);
	}
	return new Uint8Array(stdout);
}

export async function gitText(
	ctx: CliContext,
	args: string[]
): Promise<string> {
	return new TextDecoder().decode(await runGit(ctx, args)).trim();
}

/**
 * Feed git's stdout to `onLine` one line at a time. `onLine` returning false
 * stops git early (the history commit limit); awaiting inside it pauses the
 * read, so a slow scan applies backpressure instead of buffering the log.
 */
export async function streamGitLines(
	ctx: CliContext,
	args: string[],
	onLine: (line: string) => Promise<boolean> | boolean
): Promise<void> {
	const proc = spawnGit(ctx, args);
	const stderrText = new Response(proc.stderr).text();
	const decoder = new TextDecoder();
	let buffered = "";
	let stopped = false;
	const reader = proc.stdout.getReader();
	reading: while (true) {
		const { done, value } = await reader.read();
		buffered += done
			? decoder.decode()
			: decoder.decode(value, { stream: true });
		let newline = buffered.indexOf("\n");
		while (newline !== -1) {
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			if (!(await onLine(line))) {
				stopped = true;
				break reading;
			}
			newline = buffered.indexOf("\n");
		}
		if (done) {
			break;
		}
	}
	if (!stopped && buffered !== "") {
		await onLine(buffered);
	}
	if (stopped) {
		await reader.cancel();
		proc.kill();
		await proc.exited;
		return;
	}
	const code = await proc.exited;
	if (code !== 0) {
		throw gitFailure(args, await stderrText);
	}
}

interface BlobHeader {
	id: string;
	size: number;
	type: string;
}

function parseBlobHeader(line: string): BlobHeader | null {
	const [id, type, size] = line.split(" ");
	if (!(id && type && size)) {
		return null;
	}
	return { id, type, size: Number(size) };
}

/** Text content of each blob at most `MAX_SCAN_FILE_BYTES` (binary skipped). */
export async function readTextBlobs(
	ctx: CliContext,
	ids: string[]
): Promise<Map<string, string>> {
	const unique = [...new Set(ids)];
	const blobs = new Map<string, string>();
	if (unique.length === 0) {
		return blobs;
	}
	const encoder = new TextEncoder();
	const checked = new TextDecoder().decode(
		await runGit(
			ctx,
			["cat-file", "--batch-check"],
			encoder.encode(`${unique.join("\n")}\n`)
		)
	);
	const wanted = checked
		.split("\n")
		.map(parseBlobHeader)
		.filter(
			(header): header is BlobHeader =>
				header !== null &&
				header.type === "blob" &&
				header.size <= MAX_SCAN_FILE_BYTES
		)
		.map((header) => header.id);
	if (wanted.length === 0) {
		return blobs;
	}
	const output = await runGit(
		ctx,
		["cat-file", "--batch"],
		encoder.encode(`${wanted.join("\n")}\n`)
	);
	let offset = 0;
	while (offset < output.length) {
		const end = output.indexOf(10, offset);
		if (end === -1) {
			break;
		}
		const header = parseBlobHeader(
			new TextDecoder().decode(output.subarray(offset, end))
		);
		offset = end + 1;
		if (header?.type !== "blob") {
			continue;
		}
		const bytes = output.subarray(offset, offset + header.size);
		offset += header.size + 1;
		if (!isBinary(bytes)) {
			blobs.set(header.id, new TextDecoder().decode(bytes));
		}
	}
	return blobs;
}

/** One staged path and the blob a commit would record for it. */
interface StagedEntry {
	blob: string;
	path: string;
}

/** Parse `git diff --cached --raw -z` (`:old new oldId newId S\0path\0`). */
export function parseStagedRaw(raw: string): StagedEntry[] {
	const tokens = raw.split("\0");
	const entries: StagedEntry[] = [];
	for (let index = 0; index + 1 < tokens.length; index += 2) {
		const [, newMode, , newId] = (tokens[index] ?? "").split(" ");
		const path = tokens[index + 1] ?? "";
		if (newMode && newId && path && !UNSCANNED_MODES.has(newMode)) {
			entries.push({ blob: newId, path });
		}
	}
	return entries;
}

/** The text a commit would add: every added, copied, or modified staged file. */
export async function collectStagedFiles(
	ctx: CliContext
): Promise<VaultScanFile[]> {
	const raw = new TextDecoder().decode(
		await runGit(ctx, [
			"diff",
			"--cached",
			"--raw",
			"-z",
			"--no-abbrev",
			"--no-renames",
			"--diff-filter=ACM",
		])
	);
	const entries = parseStagedRaw(raw);
	const blobs = await readTextBlobs(
		ctx,
		entries.map((entry) => entry.blob)
	);
	return entries.flatMap((entry) => {
		const content = blobs.get(entry.blob);
		return content === undefined ? [] : [{ path: entry.path, content }];
	});
}
