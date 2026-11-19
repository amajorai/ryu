// `ryu-cli secrets scan`: find leaked credentials with Core's detector
// (`POST /api/vault/scan`). Core matches known shapes and the stored values the
// caller may read; it never matches sealed values, and its findings carry only
// a redacted preview, a fingerprint, and (for a leaked stored value) the
// value's `ENV/folder/NAME`, so nothing printed here holds a secret.
//
// Modes: paths (files on disk), `--staged` (the blobs a commit would record),
// `--history [REV…]` (lines commits added), and `install-hook` /
// `uninstall-hook` (`secrets-scan-hook.ts`).
//
// Exit codes, for hooks and CI: 0 clean, 1 findings, 3 the scan could not run
// (git failed, Core refused, or Core is unreachable). Unreachable Core fails
// closed unless `--allow-offline` or `RYU_SECRETS_SCAN_ALLOW_OFFLINE=1` is
// set, which turns only that case into a warning and exit 0.

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { type ApiTarget, fetchForTarget } from "@ryuhq/core-client/client";
import {
	scanForVaultSecrets,
	type VaultFinding,
	type VaultScanFile,
} from "@ryuhq/core-client/vault";
import { tf } from "../i18n/translate.ts";
import { formatError } from "./output.ts";
import { flag, type SecretsArgs } from "./secrets-args.ts";
import { printJson } from "./secrets-output.ts";
import {
	collectStagedFiles,
	isBinary,
	MAX_SCAN_FILE_BYTES,
	streamGitLines,
} from "./secrets-scan-git.ts";
import {
	DEFAULT_HISTORY_COMMITS,
	scanHistory,
} from "./secrets-scan-history.ts";
import { installHook, uninstallHook } from "./secrets-scan-hook.ts";
import { type CliContext, UsageError } from "./types.ts";

export const EXIT_CLEAN = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_SCAN_FAILED = 3;
export const ALLOW_OFFLINE_ENV = "RYU_SECRETS_SCAN_ALLOW_OFFLINE";
/** A Core that accepts the connection but never answers must not hang a commit. */
const SCAN_REQUEST_TIMEOUT_MS = 120_000;

const SKIP_DIRECTORIES = new Set([".git", "node_modules", "target"]);
/** Core accepts 4 MiB per scan request; JSON escaping can inflate content. */
const MAX_SCAN_BATCH_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_BATCH_FILES = 200;

/** The request never reached Core (refused, reset, timed out). */
class CoreUnreachableError extends Error {}

/** Collect scannable text files under `root` (a file or a directory). */
export async function collectScanFiles(
	root: string,
	cwd: string
): Promise<VaultScanFile[]> {
	const files: VaultScanFile[] = [];
	const visit = async (path: string): Promise<void> => {
		const info = await stat(path);
		if (info.isDirectory()) {
			const entries = await readdir(path, { withFileTypes: true });
			entries.sort((a, b) => a.name.localeCompare(b.name));
			for (const entry of entries) {
				if (entry.isSymbolicLink()) {
					continue;
				}
				if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) {
					continue;
				}
				await visit(join(path, entry.name));
			}
			return;
		}
		if (!info.isFile() || info.size > MAX_SCAN_FILE_BYTES) {
			return;
		}
		const bytes = await readFile(path);
		if (isBinary(bytes)) {
			return;
		}
		files.push({
			path: relative(cwd, path) || path,
			content: new TextDecoder().decode(bytes),
		});
	};
	await visit(root);
	return files;
}

/** Split files into request-sized batches. */
export function scanBatches(files: VaultScanFile[]): VaultScanFile[][] {
	const batches: VaultScanFile[][] = [];
	let current: VaultScanFile[] = [];
	let size = 0;
	for (const file of files) {
		const bytes = file.content.length;
		if (
			current.length > 0 &&
			(size + bytes > MAX_SCAN_BATCH_BYTES ||
				current.length >= MAX_SCAN_BATCH_FILES)
		) {
			batches.push(current);
			current = [];
			size = 0;
		}
		current.push(file);
		size += bytes;
	}
	if (current.length > 0) {
		batches.push(current);
	}
	return batches;
}

function findingLine(finding: VaultFinding): string {
	const where = `${finding.source ?? "<input>"}:${finding.line}:${finding.column}`;
	const leaked = finding.secret ? ` (${finding.secret})` : "";
	return `${where} ${finding.rule} ${finding.preview}${leaked}`;
}

/** `ctx.target` with transport failures marked and a response deadline. */
function scanTarget(target: ApiTarget): ApiTarget {
	const fetchImpl = fetchForTarget(target);
	return {
		...target,
		fetch: async (input, init) => {
			const deadline = AbortSignal.timeout(SCAN_REQUEST_TIMEOUT_MS);
			const signal = init?.signal
				? AbortSignal.any([init.signal, deadline])
				: deadline;
			try {
				return await fetchImpl(input, { ...init, signal });
			} catch (error) {
				throw new CoreUnreachableError(
					error instanceof Error ? error.message : String(error)
				);
			}
		},
	};
}

function batchScanner(ctx: CliContext, args: SecretsArgs) {
	const target = scanTarget(ctx.target);
	return async (files: VaultScanFile[]): Promise<VaultFinding[]> => {
		const result = await scanForVaultSecrets(target, {
			files,
			allow: args.values.get("--allow") ?? [],
			knownValues: !args.booleans.has("--no-known-values"),
		});
		return result.findings;
	};
}

async function scanFiles(
	ctx: CliContext,
	args: SecretsArgs,
	files: VaultScanFile[]
): Promise<VaultFinding[]> {
	const scanBatch = batchScanner(ctx, args);
	const findings: VaultFinding[] = [];
	for (const batch of scanBatches(files)) {
		findings.push(...(await scanBatch(batch)));
	}
	return findings;
}

function allowsOffline(ctx: CliContext, args: SecretsArgs): boolean {
	const value = ctx.env[ALLOW_OFFLINE_ENV]?.trim().toLowerCase();
	return (
		args.booleans.has("--allow-offline") || value === "1" || value === "true"
	);
}

function reportScanFailure(
	ctx: CliContext,
	args: SecretsArgs,
	error: unknown
): number {
	if (error instanceof UsageError) {
		throw error;
	}
	if (error instanceof CoreUnreachableError) {
		const values = { url: ctx.target.url, message: error.message };
		if (allowsOffline(ctx, args)) {
			ctx.io.err(
				`${tf("Core at {url} is unreachable ({message}); skipping the secret scan because offline scans are allowed.", values)}\n`
			);
			return EXIT_CLEAN;
		}
		ctx.io.err(
			`${tf("Could not reach Core at {url} to scan for secrets ({message}). Start Core, or pass --allow-offline (RYU_SECRETS_SCAN_ALLOW_OFFLINE=1) to skip the scan while it is down.", values)}\n`
		);
		return EXIT_SCAN_FAILED;
	}
	ctx.io.err(
		`${tf("The secret scan could not run: {message}", { message: formatError(error) })}\n`
	);
	return EXIT_SCAN_FAILED;
}

function reportFileFindings(
	ctx: CliContext,
	fileCount: number,
	findings: VaultFinding[]
): number {
	if (ctx.flags.json) {
		printJson(ctx, { files: fileCount, findings });
	} else if (findings.length === 0) {
		ctx.io.out(
			`${tf("No secrets found in {fileCount, plural, one {# file} other {# files}}.", { fileCount })}\n`
		);
	} else {
		ctx.io.out(`${findings.map(findingLine).join("\n")}\n`);
		ctx.io.err(
			`${tf("{findingCount, plural, one {# finding} other {# findings}} in {fileCount, plural, one {# file} other {# files}}. Suppress a reviewed finding with --allow <fingerprint>.", { findingCount: findings.length, fileCount })}\n`
		);
	}
	return findings.length > 0 ? EXIT_FINDINGS : EXIT_CLEAN;
}

function maxCommits(args: SecretsArgs): number {
	const value = flag(args, "--max-commits");
	if (value === undefined) {
		return DEFAULT_HISTORY_COMMITS;
	}
	const parsed = Number(value);
	if (!(Number.isInteger(parsed) && parsed > 0)) {
		throw new UsageError("Pass a positive whole number to --max-commits.");
	}
	return parsed;
}

async function runHistory(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const revisions = args.positional.slice(1);
	const limit = maxCommits(args);
	const result = await scanHistory(
		(gitArgs, onLine) => streamGitLines(ctx, gitArgs, onLine),
		revisions,
		limit,
		batchScanner(ctx, args)
	);
	const { commits, findings } = result;
	if (ctx.flags.json) {
		printJson(ctx, result);
	} else if (findings.length === 0) {
		ctx.io.out(
			`${tf("No secrets found in {commitCount, plural, one {# commit} other {# commits}}.", { commitCount: commits })}\n`
		);
	} else {
		ctx.io.out(
			`${findings.map((item) => `${item.commit.slice(0, 12)} ${findingLine(item)}`).join("\n")}\n`
		);
		ctx.io.err(
			`${tf("{findingCount, plural, one {# finding} other {# findings}} in {commitCount, plural, one {# commit} other {# commits}}. Suppress a reviewed finding with --allow <fingerprint>.", { findingCount: findings.length, commitCount: commits })}\n`
		);
	}
	if (result.limited && !ctx.flags.json) {
		ctx.io.err(
			`${tf("Scanned only the {limit, plural, one {# newest commit} other {# newest commits}}; pass --max-commits to scan further back.", { limit })}\n`
		);
	}
	return findings.length > 0 ? EXIT_FINDINGS : EXIT_CLEAN;
}

async function runScan(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const staged = args.booleans.has("--staged");
	const history = args.booleans.has("--history");
	if (staged && history) {
		throw new UsageError("Pass either --staged or --history, not both.");
	}
	if (history) {
		return await runHistory(ctx, args);
	}
	if (staged) {
		if (args.positional.length > 1) {
			throw new UsageError(
				"Paths cannot be combined with --staged, which scans the whole index."
			);
		}
		const files = await collectStagedFiles(ctx);
		return reportFileFindings(
			ctx,
			files.length,
			await scanFiles(ctx, args, files)
		);
	}
	const roots = args.positional.slice(1);
	const cwd = process.cwd();
	const files: VaultScanFile[] = [];
	for (const root of roots.length > 0 ? roots : ["."]) {
		files.push(...(await collectScanFiles(root, cwd)));
	}
	return reportFileFindings(
		ctx,
		files.length,
		await scanFiles(ctx, args, files)
	);
}

export async function scan(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[1];
	if (action === "install-hook") {
		return await installHook(ctx);
	}
	if (action === "uninstall-hook") {
		return await uninstallHook(ctx);
	}
	try {
		return await runScan(ctx, args);
	} catch (error) {
		return reportScanFailure(ctx, args, error);
	}
}
