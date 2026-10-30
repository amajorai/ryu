import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
	scanForVaultSecrets,
	type VaultFinding,
	type VaultScanFile,
} from "@ryuhq/core-client/vault";
import { tf } from "../i18n/translate.ts";
import type { SecretsArgs } from "./secrets-args.ts";
import { printJson } from "./secrets-output.ts";
import type { CliContext } from "./types.ts";

const SKIP_DIRECTORIES = new Set([".git", "node_modules", "target"]);
const MAX_SCAN_FILE_BYTES = 1024 * 1024;
/** Core accepts 4 MiB per scan request; JSON escaping can inflate content. */
const MAX_SCAN_BATCH_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_BATCH_FILES = 200;
const BINARY_SNIFF_BYTES = 8000;

function isBinary(bytes: Uint8Array): boolean {
	return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

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

export async function scan(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const roots = args.positional.slice(1);
	const cwd = process.cwd();
	const files: VaultScanFile[] = [];
	for (const root of roots.length > 0 ? roots : ["."]) {
		files.push(...(await collectScanFiles(root, cwd)));
	}
	const findings: VaultFinding[] = [];
	for (const batch of scanBatches(files)) {
		const result = await scanForVaultSecrets(ctx.target, {
			files: batch,
			allow: args.values.get("--allow") ?? [],
			knownValues: !args.booleans.has("--no-known-values"),
		});
		findings.push(...result.findings);
	}
	if (ctx.flags.json) {
		printJson(ctx, { files: files.length, findings });
	} else if (findings.length === 0) {
		ctx.io.out(
			`${tf("No secrets found in {fileCount} file(s).", { fileCount: String(files.length) })}\n`
		);
	} else {
		ctx.io.out(`${findings.map(findingLine).join("\n")}\n`);
		ctx.io.err(
			`${tf("{findingCount} finding(s) in {fileCount} file(s). Suppress a reviewed finding with --allow <fingerprint>.", { findingCount: String(findings.length), fileCount: String(files.length) })}\n`
		);
	}
	return findings.length > 0 ? 1 : 0;
}
