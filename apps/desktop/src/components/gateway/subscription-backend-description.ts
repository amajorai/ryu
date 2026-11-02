// The description line under a subscription backend row in the Cloud tasks
// settings: its sign-in state, then a cooldown and an install hint when they
// apply. Each part is one whole translated sentence; only the separator joins
// them, so no English fragment is glued into another language's text.

import type { LiteralMessage } from "@ryu/i18n/react";
import type { CloudTaskBackendView } from "@/src/lib/api/cloud-task-backends.ts";

const PART_SEPARATOR = " · ";

/** Where this node stands on signing in to the backend. */
export function subscriptionSignInLabel(
	backend: CloudTaskBackendView,
	tl: LiteralMessage
): string {
	if (!backend.installed) {
		return tl("Not installed on this node");
	}
	switch (backend.signIn) {
		case "subscription":
			return tl("Signed in with your plan");
		case "other_method":
			return tl("Signed in with an API key, not your plan");
		default:
			return tl("Not signed in");
	}
}

/** The row's whole description, translated part by part. */
export function subscriptionBackendDescription(
	backend: CloudTaskBackendView,
	tl: LiteralMessage
): string {
	const parts = [subscriptionSignInLabel(backend, tl)];
	if (backend.cooldownSecondsRemaining) {
		parts.push(
			tl("Usage limit reached; skipped for {minutes} min", {
				minutes: Math.ceil(backend.cooldownSecondsRemaining / 60),
			})
		);
	}
	if (!backend.installed) {
		parts.push(
			tl("Install it, then run {command}", {
				command: `\`${backend.signInCommand ?? ""}\``,
			})
		);
	}
	return parts.join(PART_SEPARATOR);
}
