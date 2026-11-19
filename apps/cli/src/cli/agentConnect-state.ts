// Which `ryu` entries Ryu wrote (hash-guarded ownership state) and the safe
// file IO under `ryu-cli connect`/`disconnect`. Split from `agentConnect.ts`.

import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { cliStatePath } from "../core/cliStatePath.ts";
import { notRegularFile, notUtf8, symlinkLoop } from "./agentConnect-errors.ts";
import { type Env, entryHash, type JsonValue } from "./agentConnect-types.ts";

// ── Ownership state ────────────────────────────────────────────────────────────

const connectionRecordSchema = z.object({
	configPath: z.string(),
	createdFile: z.boolean(),
	entryHash: z.string(),
	mcpUrl: z.string(),
	tokenMode: z.enum(["inline", "env"]),
});
export type ConnectionRecord = z.infer<typeof connectionRecordSchema>;

const connectStateSchema = z.object({
	version: z.literal(1),
	agents: z.record(z.string(), connectionRecordSchema).catch(() => ({})),
});
export type ConnectState = z.infer<typeof connectStateSchema>;

function emptyState(): ConnectState {
	return { version: 1, agents: {} };
}

/** Which entries Ryu wrote, in `<data dir>/state/cli/agent-connect.json`. */
export function connectStatePath(env: Env): string {
	return cliStatePath("agent-connect.json", env);
}

export function loadConnectState(env: Env): ConnectState {
	try {
		const raw: unknown = JSON.parse(
			readFileSync(connectStatePath(env), "utf8")
		);
		const parsed = connectStateSchema.safeParse(raw);
		return parsed.success ? parsed.data : emptyState();
	} catch {
		return emptyState();
	}
}

export function saveConnectState(env: Env, state: ConnectState): void {
	writeFileAtomic(connectStatePath(env), `${JSON.stringify(state, null, 2)}\n`);
}

/** Whether `current` is the entry Ryu recorded for this agent and path. */
export function isRecordedEntry(
	current: JsonValue | undefined,
	record: ConnectionRecord | undefined,
	configPath: string
): boolean {
	return (
		current !== undefined &&
		record !== undefined &&
		record.configPath === configPath &&
		entryHash(current) === record.entryHash
	);
}

// ── File IO ────────────────────────────────────────────────────────────────────

/** Read a config file, or null when it does not exist. A symlinked dotfile is
 *  followed; a directory or other non-file is refused. */
export function readConfigFile(path: string): string | null {
	if (!existsSync(path)) {
		return null;
	}
	const real = realpathSync(path);
	if (!statSync(real).isFile()) {
		throw notRegularFile(path);
	}
	try {
		// Fatal: a lossy decode would turn invalid bytes into U+FFFD and the
		// rewrite would then corrupt them in the user's file.
		return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(real));
	} catch {
		throw notUtf8(path);
	}
}

/** Follow a symlink chain to the file it names, even when that file does not
 *  exist yet (a dangling dotfile link), so writes land on the target and the
 *  link itself is kept. */
function resolveLinkTarget(path: string): string {
	let current = path;
	for (let hops = 0; hops < 40; hops++) {
		let isLink: boolean;
		try {
			isLink = lstatSync(current).isSymbolicLink();
		} catch {
			return current;
		}
		if (!isLink) {
			return current;
		}
		current = resolve(dirname(current), readlinkSync(current));
	}
	throw symlinkLoop(path);
}

/** Mode bits of an existing file, or null. */
export function fileMode(path: string): number | null {
	if (!existsSync(path)) {
		return null;
	}
	return statSync(realpathSync(path)).mode & 0o777;
}

/** Write via a sibling temp file + rename so a crash never leaves a truncated
 *  config. A symlinked dotfile is written through to its target (the link is
 *  kept); an existing file keeps its mode, and a new one is created 0600. */
export function writeFileAtomic(path: string, contents: string): void {
	const target = resolveLinkTarget(path);
	const mode = fileMode(target) ?? 0o600;
	const dir = dirname(target);
	mkdirSync(dir, { recursive: true });
	const temp = join(
		dir,
		`.${basename(target)}.ryu-${process.pid}-${Date.now()}.tmp`
	);
	try {
		writeFileSync(temp, contents, { mode });
		chmodSync(temp, mode);
		renameSync(temp, target);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/** Delete a config file Ryu created and that now holds nothing else. */
export function deleteConfigFile(path: string): void {
	// Remove the file Ryu created, not a symlink the user keeps pointing at it.
	rmSync(resolveLinkTarget(path), { force: true });
}
