import { activeLocale, numberFormatter, translate as tl } from "@ryu/i18n/lite";

// Core saves one user row when a voice call ends, in English:
// `Call ended · 03:07` (apps/core/src/server/voice_ws.rs persist_call_ended).
// That text stays the machine key the desktop uses to group a call's rows
// (apps/desktop/src/components/voice/voice-call.ts), so it is never rewritten
// in storage. The transcript shows it in the reader's language instead.

/** The stored English row: minutes (two or more digits) and seconds. */
const CALL_ENDED_RE = /^Call ended · (\d{2,}):([0-5]\d)$/;

export interface CallEnded {
	seconds: number;
}

/** The call length a stored call-ended row carries, or null for any other text. */
export function parseCallEnded(body: string): CallEnded | null {
	const match = CALL_ENDED_RE.exec(body.trim());
	if (!match) {
		return null;
	}
	const minutes = Number(match[1]);
	const seconds = Number(match[2]);
	if (!(Number.isSafeInteger(minutes) && Number.isSafeInteger(seconds))) {
		return null;
	}
	return { seconds: minutes * 60 + seconds };
}

/** `mm:ss` with the locale's digits ("03:07", "٠٣:٠٧"). */
export function formatCallClock(
	totalSeconds: number,
	locale: string = activeLocale()
): string {
	const whole = Number.isFinite(totalSeconds)
		? Math.max(0, Math.floor(totalSeconds))
		: 0;
	const twoDigits = numberFormatter(locale, {
		minimumIntegerDigits: 2,
		useGrouping: false,
	});
	return `${twoDigits.format(Math.floor(whole / 60))}:${twoDigits.format(whole % 60)}`;
}

/** Translate an English ICU source with values, in the active locale. */
export type CallEndedTranslate = (
	source: string,
	values: Record<string, string>
) => string;

const defaultTranslate: CallEndedTranslate = (_source, values) =>
	tl("Call ended · {duration}", values);

/**
 * The stored call-ended row in the reader's language, or null when `body` is
 * not one. `translateMessage` receives the English ICU source.
 */
export function callEndedText(
	body: string,
	translateMessage: CallEndedTranslate = defaultTranslate,
	locale: string = activeLocale()
): string | null {
	const parsed = parseCallEnded(body);
	if (!parsed) {
		return null;
	}
	return translateMessage("Call ended · {duration}", {
		duration: formatCallClock(parsed.seconds, locale),
	});
}
