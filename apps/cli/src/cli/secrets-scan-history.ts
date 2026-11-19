// `ryu-cli secrets scan --history [REV…]`: scan the lines commits added.
//
// The newest `--max-commits` commits of `git log -p -U0` are read as a stream.
// Each (commit, path) becomes one submission holding only its `+` lines, plus
// a line map back to the file's real line numbers, so a finding reports the
// commit, path, and line that introduced it. Identical added content (a
// cherry-pick, the same file landing on two branches) is sent to Core once;
// its findings are reported for every commit that added it.

import { createHash } from "node:crypto";
import type { VaultFinding, VaultScanFile } from "@ryuhq/core-client/vault";
import { MAX_SCAN_FILE_BYTES } from "./secrets-scan-git.ts";

export const DEFAULT_HISTORY_COMMITS = 1000;
const MAX_BATCH_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_FILES = 200;
const COMMIT_MARKER = "\u0001";
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const C_ESCAPES = new Map([
	["n", "\n"],
	["t", "\t"],
	['"', '"'],
	["\\", "\\"],
]);

export interface HistoryFinding extends VaultFinding {
	commit: string;
	path: string;
}

export interface HistoryScan {
	commits: number;
	files: number;
	findings: HistoryFinding[];
	/** True when older commits exist beyond the limit. */
	limited: boolean;
}

interface Occurrence {
	commit: string;
	key: string;
	/** Real line number of each submitted line (0 for a hunk separator). */
	lineMap: number[];
	path: string;
}

type BatchScanner = (files: VaultScanFile[]) => Promise<VaultFinding[]>;

/** Undo git's C-style quoting of an unusual path (`"a\"b"`). */
export function unquoteGitPath(path: string): string {
	if (!(path.startsWith('"') && path.endsWith('"'))) {
		return path;
	}
	const bytes: number[] = [];
	const body = path.slice(1, -1);
	const encoder = new TextEncoder();
	for (let index = 0; index < body.length; index++) {
		const char = body[index] ?? "";
		if (char !== "\\") {
			bytes.push(...encoder.encode(char));
			continue;
		}
		const octal = /^[0-7]{3}/.exec(body.slice(index + 1));
		if (octal) {
			bytes.push(Number.parseInt(octal[0], 8));
			index += 3;
			continue;
		}
		const next = body[index + 1] ?? "";
		bytes.push(...encoder.encode(C_ESCAPES.get(next) ?? next));
		index += 1;
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The new-side path of a `+++ b/<path>` header, or null for a deletion. */
function newSidePath(header: string): string | null {
	const raw = header.slice(4).replace(/\t$/, "");
	if (raw === "/dev/null") {
		return null;
	}
	const path = unquoteGitPath(raw);
	return path.startsWith("b/") ? path.slice(2) : path;
}

class HistoryCollector {
	readonly occurrences: Occurrence[] = [];
	private readonly keysByContent = new Map<string, string>();
	private readonly findingsByKey = new Map<string, VaultFinding[]>();
	private pending: VaultScanFile[] = [];
	private pendingBytes = 0;
	private readonly scanBatch: BatchScanner;

	constructor(scanBatch: BatchScanner) {
		this.scanBatch = scanBatch;
	}

	async add(
		occurrence: Omit<Occurrence, "key">,
		content: string
	): Promise<void> {
		const digest = createHash("sha256").update(content).digest("hex");
		let key = this.keysByContent.get(digest);
		if (key === undefined) {
			key = `${occurrence.commit.slice(0, 12)}:${occurrence.path}`;
			this.keysByContent.set(digest, key);
			if (
				this.pending.length >= MAX_BATCH_FILES ||
				(this.pending.length > 0 &&
					this.pendingBytes + content.length > MAX_BATCH_BYTES)
			) {
				await this.flush();
			}
			this.pending.push({ path: key, content });
			this.pendingBytes += content.length;
		}
		this.occurrences.push({ ...occurrence, key });
	}

	async flush(): Promise<void> {
		const batch = this.pending;
		this.pending = [];
		this.pendingBytes = 0;
		if (batch.length === 0) {
			return;
		}
		for (const finding of await this.scanBatch(batch)) {
			const key = finding.source ?? "";
			this.findingsByKey.set(key, [
				...(this.findingsByKey.get(key) ?? []),
				finding,
			]);
		}
	}

	findings(): HistoryFinding[] {
		return this.occurrences.flatMap((occurrence) =>
			(this.findingsByKey.get(occurrence.key) ?? []).map((finding) => ({
				...finding,
				commit: occurrence.commit,
				path: occurrence.path,
				source: occurrence.path,
				line: occurrence.lineMap[finding.line - 1] || finding.line,
			}))
		);
	}
}

/** Parser state for one file section of a `git log -p -U0` commit. */
interface FileSection {
	bytes: number;
	lineMap: number[];
	lines: string[];
	newRemaining: number;
	nextLine: number;
	oldRemaining: number;
	path: string | null;
}

function emptySection(): FileSection {
	return {
		bytes: 0,
		lineMap: [],
		lines: [],
		nextLine: 0,
		oldRemaining: 0,
		newRemaining: 0,
		path: null,
	};
}

function addLine(section: FileSection, text: string): void {
	section.bytes += text.length + 1;
	if (section.bytes > MAX_SCAN_FILE_BYTES) {
		// Too large to scan: stop holding its lines (it is skipped).
		section.lines = [];
		section.lineMap = [];
		return;
	}
	const previous = section.lineMap.at(-1);
	if (previous !== undefined && previous !== section.nextLine - 1) {
		section.lines.push("");
		section.lineMap.push(0);
	}
	section.lines.push(text);
	section.lineMap.push(section.nextLine);
}

/** Apply one line inside a hunk. */
function hunkLine(section: FileSection, line: string): void {
	const kind = line[0];
	if (kind === "+") {
		addLine(section, line.slice(1));
		section.nextLine += 1;
		section.newRemaining -= 1;
	} else if (kind === "-") {
		section.oldRemaining -= 1;
	} else if (kind === " ") {
		section.nextLine += 1;
		section.newRemaining -= 1;
		section.oldRemaining -= 1;
	}
}

/** Apply one header line (between `diff --git` and the next hunk). */
function headerLine(section: FileSection, line: string): void {
	if (line.startsWith("+++ ")) {
		section.path = newSidePath(line);
		return;
	}
	const hunk = HUNK_HEADER.exec(line);
	if (hunk) {
		section.oldRemaining = Number(hunk[1] ?? 1);
		section.nextLine = Number(hunk[2]);
		section.newRemaining = Number(hunk[3] ?? 1);
	}
}

export function historyLogArgs(revisions: string[], limit: number): string[] {
	return [
		"-c",
		"core.quotePath=false",
		"log",
		"-p",
		"-U0",
		"-M",
		"--no-ext-diff",
		"--no-textconv",
		"--no-color",
		`--format=${COMMIT_MARKER}%H`,
		`--max-count=${limit + 1}`,
		...revisions,
		"--",
	];
}

/** Scan what the newest `limit` commits in `revisions` added. */
export async function scanHistory(
	run: (
		args: string[],
		onLine: (line: string) => Promise<boolean>
	) => Promise<void>,
	revisions: string[],
	limit: number,
	scanBatch: BatchScanner
): Promise<HistoryScan> {
	const collector = new HistoryCollector(scanBatch);
	let commit = "";
	let commits = 0;
	let limited = false;
	let section = emptySection();
	const finishSection = async (): Promise<void> => {
		const done = section;
		section = emptySection();
		if (
			done.path !== null &&
			done.lines.length > 0 &&
			done.bytes <= MAX_SCAN_FILE_BYTES
		) {
			await collector.add(
				{ commit, path: done.path, lineMap: done.lineMap },
				done.lines.join("\n")
			);
		}
	};
	await run(historyLogArgs(revisions, limit), async (line) => {
		if (section.oldRemaining > 0 || section.newRemaining > 0) {
			hunkLine(section, line);
			return true;
		}
		if (line.startsWith(COMMIT_MARKER)) {
			await finishSection();
			if (commits === limit) {
				limited = true;
				return false;
			}
			commit = line.slice(1).trim();
			commits += 1;
			return true;
		}
		if (line.startsWith("diff --git ")) {
			await finishSection();
			return true;
		}
		headerLine(section, line);
		return true;
	});
	await finishSection();
	await collector.flush();
	return {
		commits,
		files: collector.occurrences.length,
		findings: collector.findings(),
		limited,
	};
}
