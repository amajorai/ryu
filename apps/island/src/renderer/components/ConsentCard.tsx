// First-run consent card wrapper. The presentational body now lives in
// @ryu/blocks/island (`ConsentCardView`); this file keeps the gate logic
// (renders nothing once both prompts are answered) and wires the real consent
// hook. Declining `contextRead` keeps the privacy HARD GATE closed: zero
// requests ever reach Shadow (:3030).

import { ConsentCardView } from "@ryu/blocks/island/consent-card";
import { useConsent } from "../hooks/use-consent.ts";

/** The first-run consent card. Renders nothing once both prompts are answered. */
export function ConsentCard() {
	const { consent, needsPrompt, setConsent } = useConsent();

	if (!(consent && needsPrompt)) {
		return null;
	}

	return (
		<ConsentCardView
			onSet={(key, value) => setConsent({ [key]: value })}
			values={{
				contextRead: consent.contextRead,
				proactive: consent.proactive,
			}}
		/>
	);
}
