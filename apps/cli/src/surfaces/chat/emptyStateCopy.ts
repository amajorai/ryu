// Empty-state hero copy. The mode line and hint chips are explicit `tr`/`tf`
// literals so the catalog extractor collects them, and they are translated
// before the hero measures its column, so a longer locale still fits.

import { tf, tr } from "../../i18n/translate.ts";

/** The hero's mode line: the group or agent in focus, else the open prompt. */
export function emptyStateMode(
	team: string | null,
	agent: string | null
): string {
	if (team) {
		return tf("Group: {team}", { team });
	}
	if (agent) {
		return tf("Agent: {agent}", { agent });
	}
	return tr("Ask anything");
}

/** The key-hint chips under the version, each one whole translated phrase. */
export function emptyStateHints(simpleInterface: boolean): string[] {
	if (simpleInterface) {
		return [tr("Chat with Ryu"), tr("/ commands")];
	}
	return [
		tr("Ctrl+A pick agent"),
		tr("/ commands"),
		tr("@ mention"),
		tr("Ctrl+Q queue"),
	];
}

/** The label beside each recent conversation's Alt+N key. */
export function recentResumeLabel(): string {
	return tr("Resume");
}
