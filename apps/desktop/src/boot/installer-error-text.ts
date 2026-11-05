// Words for the background installer toasts. The native installer runner
// (`src-tauri/src/core/install/installer_script.rs`) never sends a sentence: a
// failed run reports a stable `code` (for example `installer_exit`) and keeps
// the technical cause in `detail`, which stays in logs. Each known code maps to
// one whole translated sentence here; anything else, including an older build
// that still sends a raw English `error`, falls back to a generic sentence.

import { formatPercent } from "@ryu/i18n/format-percent";
import type { LiteralMessage } from "@ryu/i18n/react";

/** The error fields an `installer-progress` event with `phase: "error"` may carry. */
export interface InstallerErrorPayload {
	code?: string | null;
	detail?: string | null;
	error?: string | null;
}

/** The toast sentence for a failed installer run. Never echoes `error`/`detail`. */
export function installerErrorText(
	payload: InstallerErrorPayload,
	tl: LiteralMessage
): string {
	switch (payload.code) {
		case "installer_exit":
			return tl("Ryu setup didn't finish. Try again.");
		default:
			return tl("Ryu setup failed");
	}
}

/** "42% of setup" in the reader's language and number format, or nothing. */
export function installerProgressText(
	percent: number | undefined,
	tl: LiteralMessage
): string | undefined {
	if (percent === undefined || !Number.isFinite(percent)) {
		return;
	}
	return tl("{percent} of setup", { percent: formatPercent(percent / 100) });
}
