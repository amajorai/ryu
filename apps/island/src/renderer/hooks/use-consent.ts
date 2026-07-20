import { useCallback, useEffect, useState } from "react";
import type { ConsentPatch, ConsentState } from "../../shared/ipc.ts";

/**
 * Subscribe to the main-process consent store. Returns the current per-capability
 * consent, a setter that grants/declines capabilities, and `needsPrompt` (true
 * while `contextRead` or `proactive` is still unanswered) so the first-run card
 * can decide whether to show.
 */
export function useConsent(): {
	consent: ConsentState | null;
	needsPrompt: boolean;
	setConsent: (patch: ConsentPatch) => Promise<void>;
} {
	const [consent, setConsentState] = useState<ConsentState | null>(null);

	useEffect(() => {
		let active = true;
		window.island.consent.get().then((state) => {
			if (active) {
				setConsentState(state);
			}
		});
		const unsubscribe = window.island.consent.onChanged((state) => {
			setConsentState(state);
		});
		return () => {
			active = false;
			unsubscribe();
		};
	}, []);

	const setConsent = useCallback(async (patch: ConsentPatch): Promise<void> => {
		const next = await window.island.consent.set(patch);
		setConsentState(next);
	}, []);

	const needsPrompt =
		consent !== null &&
		(consent.contextRead === null || consent.proactive === null);

	return { consent, needsPrompt, setConsent };
}
