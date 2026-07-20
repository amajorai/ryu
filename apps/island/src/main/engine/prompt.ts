// Compact prompt construction for the local-model suggestion call.
//
// We keep the prompt small (a local Gemma 4 E2B has a modest context window) and
// force STRICT JSON output. The OCR text is truncated to ~1500 chars so a busy
// screen does not blow the budget. Pure + unit-testable.

import type { CoreChatMessage } from "../../shared/ipc.ts";
import type { ContextSnapshot } from "./change-detection.ts";

/** Max OCR characters embedded in the prompt. */
export const OCR_TRUNCATE_CHARS = 1500;
/** Max selected-text characters embedded in the prompt. */
export const SELECTION_TRUNCATE_CHARS = 500;
/**
 * Max browser-page characters embedded in the prompt. Larger than the OCR
 * budget: the browser extension bridges the *full* page text (including content
 * scrolled off-screen that screen capture/OCR can never see), which is the whole
 * point of the bridge — so it gets more room.
 */
export const BROWSER_TRUNCATE_CHARS = 3000;

const SYSTEM_PROMPT = [
	"You are a proactive desktop assistant embedded in a small island overlay.",
	"You see the user's current screen context. Decide if there is ONE genuinely",
	"helpful, specific suggestion you can offer right now (e.g. summarize, draft a",
	"reply, explain an error, look something up). Be conservative: most of the time",
	"there is nothing useful to add, and you should say so.",
	"",
	"Respond with STRICT JSON only, no prose, no markdown fences:",
	'{"relevant": boolean, "title": string, "body": string,',
	'"action": "chat" | "dismiss", "confidence": number between 0 and 1}',
	"Set relevant=false when there is nothing worth interrupting the user for.",
].join("\n");

function truncate(text: string | null, max: number): string {
	if (!text) {
		return "";
	}
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Build the chat messages for a context snapshot's suggestion request. */
export function buildSuggestionMessages(
	snapshot: ContextSnapshot
): CoreChatMessage[] {
	const ocr = truncate(snapshot.ocrText, OCR_TRUNCATE_CHARS);
	const selection = truncate(snapshot.selectedText, SELECTION_TRUNCATE_CHARS);
	const browser = truncate(
		snapshot.browserContent ?? null,
		BROWSER_TRUNCATE_CHARS
	);
	const lines = [
		`App: ${snapshot.appName ?? "unknown"}`,
		`Window: ${snapshot.windowTitle ?? "unknown"}`,
		selection.length > 0 ? `Selected text: ${selection}` : null,
		ocr.length > 0 ? `On-screen text:\n${ocr}` : "On-screen text: (none)",
		snapshot.browserUrl ? `Browser page: ${snapshot.browserUrl}` : null,
		browser.length > 0 ? `Full page content:\n${browser}` : null,
	].filter((line): line is string => line !== null);
	return [
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "user", content: lines.join("\n") },
	];
}
