import { afterEach, expect, test } from "bun:test";
import { messageIdForLiteral } from "@ryu/i18n/lite";
// The provider registers its runtime here; a test registers a stand-in.
import {
	type ActiveI18nRuntime,
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../packages/i18n/src/active-locale.ts";
import {
	LOCALIZED_VOICE_ERROR_CODES,
	voiceErrorCopy,
} from "./voice-error-copy.ts";

/** The English frames Core sends today, by code. */
const SERVER_FRAMES: Record<string, string> = {
	bad_conversation_id:
		"conversation_id must be 1-128 ASCII letters, digits, '.', '_' or '-'",
	call_history_failed: "The call ended, but its summary could not be saved.",
	forbidden: "you do not have access to that conversation",
	node_token_rotated: "node token rotated; reconnect required",
	socket: "voice socket error",
	too_many_calls:
		"you already have the most voice calls open on this workspace",
	tts_engine_unknown: "unknown TTS engine 'kokoro': not installed",
	user_identity_expired: "user identity expired; reconnect required",
};

/** A German stand-in runtime: every catalog message reads "[de] <id>". */
const german: ActiveI18nRuntime = {
	direction: "ltr",
	locale: "de",
	translate: (id) => `[de] ${id}`,
};

afterEach(() => {
	unregisterActiveI18nRuntime(german);
});

test("every Core voice error code has its own sentence", () => {
	expect([...LOCALIZED_VOICE_ERROR_CODES].sort()).toEqual(
		Object.keys(SERVER_FRAMES).sort()
	);
	for (const [code, message] of Object.entries(SERVER_FRAMES)) {
		const copy = voiceErrorCopy(code, message);
		expect(copy).not.toBe("");
		if (code !== "call_history_failed") {
			expect(copy).not.toBe(message);
		}
	}
});

test("known codes come from the catalog in the active locale", () => {
	registerActiveI18nRuntime(german);
	const copy = voiceErrorCopy(
		"too_many_calls",
		SERVER_FRAMES.too_many_calls ?? ""
	);
	expect(copy).toBe(
		`[de] ${messageIdForLiteral("You already have the most voice calls open on this workspace.")}`
	);
	// All four "forbidden" refusals read as one sentence.
	expect(voiceErrorCopy("forbidden", "WebSocket ticket is not bound")).toBe(
		voiceErrorCopy("forbidden", "only built-in voices are available")
	);
});

test("an unknown code keeps the server's text", () => {
	registerActiveI18nRuntime(german);
	expect(voiceErrorCopy("turn_failed", "engine exploded")).toBe(
		"engine exploded"
	);
	expect(voiceErrorCopy("constructor", "raw")).toBe("raw");
});
