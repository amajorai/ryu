import {
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { z } from "zod";
import { type CliStateEnvironment, cliStatePath } from "./cliStatePath.ts";

export const PROMPT_HISTORY_LIMIT = 100;

/** Purpose Core seals the history under (its allowlist names it). */
export const PROMPT_HISTORY_PURPOSE = "cli.prompt-history";
const SEALED_PREFIX = "encb:v1:";

const promptHistorySchema = z.array(z.string().nullable().catch(null));
const sealedResponseSchema = z.object({ sealed: z.string() });
const openedResponseSchema = z.object({ value: z.string() });

export interface PromptHistoryState {
	cursor: number;
	draft: string;
	entries: string[];
}

/**
 * Seals and opens the history file through the local Core, which holds the
 * key (the CLI cannot reach the OS keychain). Without a reachable Core the
 * history stays in memory only.
 */
export interface PromptHistorySealer {
	open(sealed: string): Promise<string>;
	seal(plaintext: string): Promise<string>;
}

/** The loopback-only, owner-only Core routes `POST /api/local-content/*`. */
export function coreHistorySealer(target: ApiTarget): PromptHistorySealer {
	return {
		async open(sealed) {
			const response = await request(
				target,
				"/api/local-content/open",
				{
					method: "POST",
					body: { purpose: PROMPT_HISTORY_PURPOSE, value: sealed },
				},
				openedResponseSchema
			);
			return response.value;
		},
		async seal(plaintext) {
			const response = await request(
				target,
				"/api/local-content/seal",
				{
					method: "POST",
					body: { purpose: PROMPT_HISTORY_PURPOSE, value: plaintext },
				},
				sealedResponseSchema
			);
			return response.sealed;
		},
	};
}

/** The TUI's prompt history (`<data dir>/state/cli/prompt-history.json`). */
export function promptHistoryPath(
	environment: CliStateEnvironment = process.env
): string {
	return cliStatePath("prompt-history.json", environment);
}

function boundedEntries(entries: readonly string[]): string[] {
	return entries
		.filter((entry) => entry.trim().length > 0)
		.map((entry) => entry.trim())
		.slice(-PROMPT_HISTORY_LIMIT);
}

export function initialPromptHistory(
	entries: readonly string[] = []
): PromptHistoryState {
	return { entries: boundedEntries(entries), cursor: -1, draft: "" };
}

function parseEntries(text: string): string[] {
	const parsed = promptHistorySchema.safeParse(JSON.parse(text));
	return parsed.success
		? parsed.data.flatMap((entry) => (entry === null ? [] : [entry]))
		: [];
}

/**
 * The text a sent prompt contributes to history: collapsed pastes keep only
 * their placeholder (the pasted block is never recorded), and a slash command
 * keeps only its name (arguments can carry secrets).
 */
export function historyEntryFor(composerText: string): string {
	const value = composerText.trim();
	if (value.startsWith("/")) {
		return value.split(/\s+/, 1)[0] ?? "";
	}
	return value;
}

/** Outcome of reading the history file. */
export interface LoadedPromptHistory {
	/** True when the file held plaintext from an older build (seal it next). */
	legacyPlaintext: boolean;
	state: PromptHistoryState;
}

/**
 * The history file is sealed but Core could not open it (still starting, not
 * signed in, another profile's key). The file is kept as it is: callers must
 * not write history until a later load succeeds, or they would replace it.
 */
export class PromptHistoryUnreadableError extends Error {
	constructor(cause: unknown) {
		super("The sealed prompt history could not be opened", { cause });
		this.name = "PromptHistoryUnreadableError";
	}
}

function parseLoaded(text: string, legacyPlaintext: boolean) {
	try {
		return { legacyPlaintext, state: initialPromptHistory(parseEntries(text)) };
	} catch {
		return { legacyPlaintext: false, state: initialPromptHistory() };
	}
}

/**
 * Read history defensively: an absent or corrupt file (or, without Core, a
 * sealed one) behaves like empty history, and a legacy plaintext file still
 * reads. A sealed file that Core fails to open rejects with
 * {@link PromptHistoryUnreadableError} so it is never overwritten.
 */
export async function loadSealedPromptHistory(
	sealer: PromptHistorySealer | null,
	path = promptHistoryPath()
): Promise<LoadedPromptHistory> {
	let text: string;
	try {
		text = readFileSync(path, "utf8").trim();
	} catch {
		return { legacyPlaintext: false, state: initialPromptHistory() };
	}
	if (!text.startsWith(SEALED_PREFIX)) {
		return parseLoaded(text, true);
	}
	if (!sealer) {
		return { legacyPlaintext: false, state: initialPromptHistory() };
	}
	let opened: string;
	try {
		opened = await sealer.open(text);
	} catch (error) {
		throw new PromptHistoryUnreadableError(error);
	}
	return parseLoaded(opened, false);
}

/**
 * Persist history sealed. Best-effort so a read-only home or an unreachable
 * Core never breaks the composer: without a sealer nothing is written (the
 * history lives in memory only). The temporary file holds only the sealed
 * value, and the sealed copy is opened again and compared before it replaces
 * the file, so a legacy plaintext file is only dropped once its sealed
 * replacement is confirmed. Returns whether the file was written.
 */
export async function saveSealedPromptHistory(
	entries: readonly string[],
	sealer: PromptHistorySealer | null,
	path = promptHistoryPath()
): Promise<boolean> {
	if (!sealer) {
		return false;
	}
	const temporaryPath = `${path}.${process.pid}.tmp`;
	try {
		const plaintext = JSON.stringify(boundedEntries(entries));
		const sealed = await sealer.seal(plaintext);
		if (!sealed.startsWith(SEALED_PREFIX)) {
			return false;
		}
		if ((await sealer.open(sealed)) !== plaintext) {
			return false;
		}
		const directory = dirname(path);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
		writeFileSync(temporaryPath, sealed, { mode: 0o600 });
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, path);
		chmodSync(path, 0o600);
		return true;
	} catch {
		rmSync(temporaryPath, { force: true });
		// History is a convenience and must not prevent sending a prompt.
		return false;
	}
}

/**
 * Load history and, when the file is a plaintext one from an older build,
 * rewrite it sealed (the plaintext is replaced only after the sealed copy is
 * confirmed). Idempotent; without Core the plaintext stays until next time.
 * Rejects with {@link PromptHistoryUnreadableError} when a sealed file does
 * not open; history must then not be saved until a later load succeeds.
 */
export async function loadAndMigratePromptHistory(
	sealer: PromptHistorySealer | null,
	path = promptHistoryPath()
): Promise<PromptHistoryState> {
	const loaded = await loadSealedPromptHistory(sealer, path);
	if (loaded.legacyPlaintext && sealer) {
		await saveSealedPromptHistory(loaded.state.entries, sealer, path);
	}
	return loaded.state;
}

/**
 * Synchronous reader of a plaintext history file (the format older builds
 * wrote). The app reads through {@link loadSealedPromptHistory}, which uses
 * this format only to migrate a legacy file.
 */
export function loadPromptHistory(
	path = promptHistoryPath()
): PromptHistoryState {
	try {
		return initialPromptHistory(parseEntries(readFileSync(path, "utf8")));
	} catch {
		return initialPromptHistory();
	}
}

/**
 * @deprecated Writes the legacy PLAINTEXT format; kept only for callers that
 * predate sealing. The app writes through {@link saveSealedPromptHistory}.
 */
export function savePromptHistory(
	entries: readonly string[],
	path = promptHistoryPath()
): void {
	try {
		const directory = dirname(path);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
		const temporaryPath = `${path}.${process.pid}.tmp`;
		writeFileSync(temporaryPath, JSON.stringify(boundedEntries(entries)), {
			mode: 0o600,
		});
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, path);
		chmodSync(path, 0o600);
	} catch {
		// History is a convenience and must not prevent sending a prompt.
	}
}

/** Entries recorded before an asynchronous load finished go after it. */
export function mergeLoadedHistory(
	loaded: PromptHistoryState,
	current: PromptHistoryState
): PromptHistoryState {
	return {
		...current,
		entries: boundedEntries([...loaded.entries, ...current.entries]),
	};
}

export function recordPrompt(
	state: PromptHistoryState,
	prompt: string
): PromptHistoryState {
	const value = prompt.trim();
	if (value.length === 0) {
		return { ...state, cursor: -1, draft: "" };
	}
	const entries =
		state.entries.at(-1) === value
			? state.entries
			: [...state.entries, value].slice(-PROMPT_HISTORY_LIMIT);
	return { entries, cursor: -1, draft: "" };
}

export interface PromptNavigationResult {
	state: PromptHistoryState;
	value: string;
}

export function previousPrompt(
	state: PromptHistoryState,
	currentValue: string
): PromptNavigationResult {
	if (state.entries.length === 0) {
		return { state, value: currentValue };
	}
	const draft = state.cursor === -1 ? currentValue : state.draft;
	const cursor =
		state.cursor === -1
			? state.entries.length - 1
			: Math.max(0, state.cursor - 1);
	return {
		state: { ...state, cursor, draft },
		value: state.entries[cursor] ?? draft,
	};
}

export function nextPrompt(
	state: PromptHistoryState,
	currentValue: string
): PromptNavigationResult {
	if (state.cursor === -1) {
		return { state, value: currentValue };
	}
	const cursor = state.cursor + 1;
	if (cursor >= state.entries.length) {
		return { state: { ...state, cursor: -1 }, value: state.draft };
	}
	return {
		state: { ...state, cursor },
		value: state.entries[cursor] ?? currentValue,
	};
}

export function resetPromptNavigation(
	state: PromptHistoryState
): PromptHistoryState {
	return state.cursor === -1 ? state : { ...state, cursor: -1, draft: "" };
}
