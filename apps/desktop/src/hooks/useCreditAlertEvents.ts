import { activeLocale, numberFormatter, translate as tl } from "@ryu/i18n/core";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useEffect } from "react";
import { abortableDelay } from "@/src/lib/abortable-delay.ts";
import {
	type CreditAlertEvent,
	hasCreditsAuth,
	isTerminalCreditsError,
	openCreditAlertStream,
} from "@/src/lib/api/credits.ts";
import { showOsNotification } from "@/src/lib/notifications/os-notify.ts";
import { playSound } from "@/src/lib/sounds/play-sound.ts";

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 10_000;
/**
 * Retry cadence after a refusal only user action elsewhere can clear (signed
 * out or revoked, no active org, org access policy). Matches `useWalletStream`:
 * this hook is mounted for every signed-in window, so the transient cadence
 * would repeat the same 401/403/409 every 10 seconds for the whole session.
 */
const TERMINAL_RETRY_MS = 300_000;

const MICRO_USD_PER_DOLLAR = 1_000_000;

/**
 * The alert's title in the UI language: the server sends an English sentence
 * with an en-US amount, so it is rebuilt here from `balanceMicroUsd` with the
 * locale's own currency format ("4,20 $" in German). The server title stays
 * the fallback when the payload has no usable balance.
 */
export function creditAlertTitle(
	event: CreditAlertEvent,
	locale: string = activeLocale()
): string {
	if (!Number.isFinite(event.balanceMicroUsd)) {
		return event.title || tl("Your Ryu credit balance is low");
	}
	const balance = numberFormatter(locale, {
		currency: "USD",
		style: "currency",
	}).format(event.balanceMicroUsd / MICRO_USD_PER_DOLLAR);
	return tl("Your Ryu credit balance is low ({balance})", { balance });
}

function creditAlertBody(): string {
	return tl("Top up your Ryu credits to keep managed work running.");
}

function osNotify(event: CreditAlertEvent, signal: AbortSignal): void {
	if (signal.aborted) {
		return;
	}
	showOsNotification({
		title: creditAlertTitle(event),
		body: creditAlertBody(),
		tag: "ryu-credit-alert",
	}).catch(() => undefined);
}

/** Run (and keep reconnecting) the credit-alert stream until `signal` aborts. */
export async function runCreditAlertStream(
	signal: AbortSignal,
	onAlert: (event: CreditAlertEvent) => void
): Promise<void> {
	let backoff = INITIAL_BACKOFF_MS;
	while (!signal.aborted) {
		// Set when the last attempt failed for a reason reconnecting cannot fix.
		let terminal = false;
		if (hasCreditsAuth()) {
			try {
				for await (const message of openCreditAlertStream(signal)) {
					if (signal.aborted) {
						break;
					}
					onAlert(message.data);
					backoff = INITIAL_BACKOFF_MS; // a live frame resets the backoff
				}
			} catch (e) {
				// A transient cloud API failure must not affect the app; a refusal
				// that will repeat until the user acts drops to the slow cadence.
				terminal = isTerminalCreditsError(e);
			}
		}
		if (signal.aborted) {
			break;
		}
		if (terminal) {
			await abortableDelay(TERMINAL_RETRY_MS, signal);
			backoff = INITIAL_BACKOFF_MS;
			continue;
		}
		// Signed out there is no token to send; wait a full interval so a later
		// sign-in is picked up without hot-looping.
		await abortableDelay(hasCreditsAuth() ? backoff : MAX_BACKOFF_MS, signal);
		backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
	}
}

/** Subscribe once at the shell level so every claimed alert reaches the user. */
export function useCreditAlertEvents(): void {
	useEffect(() => {
		const controller = new AbortController();
		runCreditAlertStream(controller.signal, (event) => {
			toast.warning({
				title: creditAlertTitle(event),
				description: creditAlertBody(),
			});
			playSound("credit-alert", { source: "stream" });
			osNotify(event, controller.signal);
		}).catch(() => undefined);
		return () => controller.abort();
	}, []);
}
