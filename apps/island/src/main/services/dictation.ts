// Main-process dictation pipeline: turn captured audio into text typed straight
// into whatever native app has OS focus (WhisprFlow / SuperWhisper style).
//
// The renderer only captures the WAV; everything after lands here because it needs
// the Electron `clipboard` module (paste insertion) and Core's MCP bridge (ghost
// synthetic input). The stages:
//   1. transcribe  — Core `/api/voice/transcribe` with the configured engine.
//   2. post-process — optional LLM cleanup (fast local model OR a full agent);
//      fails open to the raw transcript so speech is never silently dropped.
//   3. insert       — type (ghost `ghost_type`) or paste (clipboard + paste chord
//      via ghost `ghost_hotkey`, with optional clipboard restore), then an
//      optional Enter (ghost `ghost_press`) when auto-send is on.
//
// ghost is reached over Core's `/api/mcp/tools/call` under the flagship `ryu`
// agent, whose allowlist is unrestricted by default so the ghost tools resolve.

import { clipboard } from "electron";
import { DEFAULT_AGENT_ID } from "../../shared/agents.ts";
import {
	type DictationPrefs,
	parseDictationPrefs,
} from "../../shared/dictation.ts";
import type {
	CoreChatMessage,
	DictationSubmitResult,
} from "../../shared/ipc.ts";
import { callTool, completions, runAgentText, transcribe } from "./core.ts";

/**
 * Delay before restoring the pre-paste clipboard. The paste chord is dispatched
 * asynchronously through the OS, so restoring too early races the paste and the
 * app receives the old clipboard instead. A short delay lets the paste land first.
 */
const CLIPBOARD_RESTORE_DELAY_MS = 400;

/** The `ryu` agent gates the ghost MCP calls; its allowlist is unrestricted. */
const GHOST_AGENT_ID = DEFAULT_AGENT_ID;

/** Resolve the paste chord into ghost `keys` tokens, platform-defaulting when unset. */
function pasteKeysFor(prefs: DictationPrefs): string[] {
	const custom = prefs.pasteKeys
		.split("+")
		.map((token) => token.trim().toLowerCase())
		.filter((token) => token.length > 0);
	if (custom.length > 0) {
		return custom;
	}
	return process.platform === "darwin" ? ["cmd", "v"] : ["ctrl", "v"];
}

/**
 * Optionally clean the raw transcript with an LLM. Empty `agent` uses the fast
 * local default model (one gateway completion); a non-empty id routes through that
 * agent. Fails open: any unavailable/empty result returns the raw transcript.
 */
async function postProcess(
	text: string,
	prefs: DictationPrefs
): Promise<string> {
	if (!prefs.postProcess.enabled) {
		return text;
	}
	const messages: CoreChatMessage[] = [
		{ role: "system", content: prefs.postProcess.prompt },
		{ role: "user", content: text },
	];
	const agent = prefs.postProcess.agent.trim();
	const result =
		agent.length > 0
			? await runAgentText(agent, messages)
			: await completions({ messages });
	if (result.available) {
		const cleaned = result.text.trim();
		if (cleaned.length > 0) {
			return cleaned;
		}
	}
	return text;
}

/** Insert `text` into the focused app per the configured insertion mode. */
async function insertText(text: string, prefs: DictationPrefs): Promise<void> {
	if (prefs.insertMode === "paste") {
		const previous = prefs.restoreClipboard ? clipboard.readText() : null;
		clipboard.writeText(text);
		await callTool({
			agent_id: GHOST_AGENT_ID,
			arguments: { keys: pasteKeysFor(prefs) },
			tool: "ghost__ghost_hotkey",
		});
		if (previous !== null) {
			setTimeout(() => {
				clipboard.writeText(previous);
			}, CLIPBOARD_RESTORE_DELAY_MS);
		}
	} else {
		await callTool({
			agent_id: GHOST_AGENT_ID,
			arguments: { text },
			tool: "ghost__ghost_type",
		});
	}
	if (prefs.autoSend) {
		await callTool({
			agent_id: GHOST_AGENT_ID,
			arguments: { key: "enter" },
			tool: "ghost__ghost_press",
		});
	}
}

/**
 * Run the full dictation pipeline on captured WAV bytes. `rawPrefs` is the current
 * `dictation` preference blob (raw JSON). Returns a small result the renderer can
 * flash on the recording pill; never rejects.
 */
export async function runDictation(
	audio: ArrayBuffer,
	rawPrefs: string | null
): Promise<DictationSubmitResult> {
	const prefs = parseDictationPrefs(rawPrefs);
	const transcript = await transcribe(audio, prefs.engine);
	if (!transcript.available) {
		return { ok: false, reason: transcript.reason };
	}
	const raw = transcript.text.trim();
	if (raw.length === 0) {
		return { ok: false, reason: "empty" };
	}
	const finalText = (await postProcess(raw, prefs)).trim();
	if (finalText.length === 0) {
		return { ok: false, reason: "empty" };
	}
	try {
		await insertText(finalText, prefs);
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : "insert-failed",
		};
	}
	return { ok: true, text: finalText };
}
