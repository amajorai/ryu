// The line `ryu-cli` prints when the waitlist gate refuses a one-shot command.
// Each refusal is a whole catalog sentence, so it reads in the CLI's language.

import type { CliWaitlistAccess } from "../core/waitlist.ts";
import { type CliTranslator, tr as cliTr } from "../i18n/translate.ts";

/** Why the gate refused, in the CLI locale (`approved` is never refused). */
export function waitlistRefusal(
	access: Exclude<CliWaitlistAccess, "approved">,
	tr: CliTranslator["tr"] = cliTr
): string {
	if (access === "unauthenticated") {
		return tr("Sign in first with `ryu-cli login`.");
	}
	if (access === "pending") {
		return tr("Your account is still on the waitlist.");
	}
	return tr(
		"Ryu could not verify waitlist access. Try again when the control plane is reachable."
	);
}
