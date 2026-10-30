// apps/desktop/src/components/channels/TelegramManagedBotPanel-pairing.ts
//
// Timing constants, the phase type and small pure helpers for the managed-bot
// pairing flow in TelegramManagedBotPanel.tsx.

/**
 * How often to ask the node whether Telegram is done. The user has to switch
 * apps, read a dialog and confirm, so sub-second polling buys nothing and the
 * node forwards each poll to the manager (which rate-limits per nonce).
 */
export const POLL_MS = 3000;
/**
 * How many polls in a row may fail before we say so. One flaky request during a
 * 10-minute wait is not worth tearing the flow down, but a node that has gone
 * away must not hide behind the countdown and then surface as "expired".
 */
export const MAX_POLL_FAILURES = 4;
/** Countdown tick. Independent of the poll so the timer reads smoothly. */
export const TICK_MS = 1000;
const SECONDS_PER_MINUTE = 60;
export const QR_SIZE = 168;

export function safeTelegramDeepLink(value: string): string | null {
	try {
		const url = new URL(value);
		if (
			url.protocol === "https:" &&
			new Set(["t.me", "telegram.me", "www.t.me", "www.telegram.me"]).has(
				url.hostname
			)
		) {
			return url.href;
		}
		return url.protocol === "tg:" && url.hostname === "resolve"
			? url.href
			: null;
	} catch {
		return null;
	}
}

export type Phase =
	| "idle"
	| "starting"
	| "waiting"
	/** Telegram made a bot; the node is holding its token until the user says it is
	 *  theirs. See `confirming` below for why this step is not skippable. */
	| "confirming"
	| "completing"
	| "expired"
	| "failed";

/** The new bot, as the node describes it while asking whether to keep it. */
export interface CreatedBot {
	botId: number;
	botUsername: string;
	ownerTelegramUserId: number | null;
}

/** `4:07` — a countdown the user can read against Telegram's 10-minute window. */
export function formatRemaining(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / TICK_MS));
	const minutes = Math.floor(total / SECONDS_PER_MINUTE);
	const seconds = total % SECONDS_PER_MINUTE;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
