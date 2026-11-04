import { translate as tl } from "@ryu/i18n/core";

// Core's voice socket closes a call with `{ type: "error", code, message }`
// (apps/core/src/server/voice_ws.rs). The message is English diagnostic text,
// so the call composer shows a sentence chosen by the code instead. "forbidden"
// covers several refusals (no access to the conversation, a ticket bound to
// another conversation, a member asking for a cloned voice or the shared
// Gateway audio, an agent the member may not run); it reads as one sentence.
// tts_engine_unknown (apps/core/src/voice/session.rs) names the engine; the
// spoken reply stops but the text reply keeps streaming. A code this table
// does not know (asr_failed, turn_failed: engine detail) keeps the server's text.

const VOICE_ERROR_COPY: Readonly<Record<string, () => string>> = {
	bad_conversation_id: () =>
		tl("This conversation can't be used for a voice call."),
	call_history_failed: () =>
		tl("The call ended, but its summary could not be saved."),
	forbidden: () => tl("You don't have permission to start this voice call."),
	node_token_rotated: () =>
		tl("This device's access was renewed. Start the call again."),
	socket: () => tl("The voice connection was lost."),
	too_many_calls: () =>
		tl("You already have the most voice calls open on this workspace."),
	tts_engine_unknown: () =>
		tl(
			"The speech engine set for voice replies isn't available. Replies stay as text."
		),
	user_identity_expired: () =>
		tl("Your sign-in expired during the call. Start the call again."),
};

/** The voice error codes that have their own localized sentence. */
export const LOCALIZED_VOICE_ERROR_CODES: readonly string[] =
	Object.keys(VOICE_ERROR_COPY);

/** The sentence the call composer shows for a voice socket error frame. */
export function voiceErrorCopy(code: string, message: string): string {
	const copy = Object.hasOwn(VOICE_ERROR_COPY, code)
		? VOICE_ERROR_COPY[code]
		: undefined;
	return copy ? copy() : message;
}
