// The one-line notices a ListTab shows after Enter or `a` acts on a row. A row
// action's result was a hand-built English fragment (`install queued: <id>`)
// that no catalog entry could match, so each action has its own whole sentence
// and only the row id is filled in.

import { tf } from "../i18n/translate.ts";

/** A catalog item (model, skill) was queued for install. */
export function queuedInstallNotice(name: string): string {
	return tf("Queued install: {name}", { name });
}

/** A model became the active served chat model. */
export function activeModelNotice(name: string): string {
	return tf("Active model: {name}", { name });
}

/** A skill was activated. */
export function activatedNotice(name: string): string {
	return tf("Activated {name}", { name });
}

/** A Library recipe was replayed. */
export function replayedNotice(name: string): string {
	return tf("Replayed {name}", { name });
}

/** A monitor was checked now. */
export function checkedNotice(name: string): string {
	return tf("Checked {name}", { name });
}

/** A Setup sidecar install started; `r` refreshes its state. */
export function installingNotice(name: string): string {
	return tf("Installing {name}… (press r to refresh)", { name });
}

/** A row action failed; `message` is the already-readable reason. */
export function listActionErrorNotice(message: string): string {
	return tf("Error: {message}", { message });
}
