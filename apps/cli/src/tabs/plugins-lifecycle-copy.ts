// Whole sentences for the Plugins tab's lifecycle actions. An English verb id
// (`install`, `disable`) spliced into a translated template stays English in
// every language, so each action gets its own catalog sentence.

import { tf, tr } from "../i18n/translate.ts";

export type LifecycleVerb =
	| "disable"
	| "enable"
	| "install"
	| "uninstall"
	| "update";

/** A destructive action that may also take a plugin's dependents. */
export type CascadeVerb = "disable" | "uninstall";

/** The toast after an action succeeds. */
export function lifecycleDoneText(verb: LifecycleVerb, name: string): string {
	switch (verb) {
		case "disable":
			return tf("Disabled {name}", { name });
		case "enable":
			return tf("Enabled {name}", { name });
		case "install":
			return tf("Installed {name}", { name });
		case "uninstall":
			return tf("Uninstalled {name}", { name });
		default:
			return tf("Updated {name}", { name });
	}
}

/** The toast after an action fails; `error` is the already-localized reason. */
export function lifecycleFailedText(
	verb: LifecycleVerb,
	error: string
): string {
	switch (verb) {
		case "disable":
			return tf("Disable failed: {error}", { error });
		case "enable":
			return tf("Enable failed: {error}", { error });
		case "install":
			return tf("Install failed: {error}", { error });
		case "uninstall":
			return tf("Uninstall failed: {error}", { error });
		default:
			return tf("Update failed: {error}", { error });
	}
}

/** The warning that offers to repeat a blocked action on the dependents too. */
export function cascadeOfferText(verb: CascadeVerb, message: string): string {
	return verb === "disable"
		? tf("{message} (Press C to disable its dependents too.)", { message })
		: tf("{message} (Press C to uninstall its dependents too.)", { message });
}

/** The cascade confirmation's title. */
export function cascadeTitleText(verb: CascadeVerb, name: string): string {
	return verb === "disable"
		? tf("Disable {name} and its dependents?", { name })
		: tf("Uninstall {name} and its dependents?", { name });
}

/** The cascade confirmation's action button. */
export function cascadeConfirmLabel(verb: CascadeVerb): string {
	return verb === "disable" ? tr("Disable all") : tr("Uninstall all");
}
