// The fallback failure toast of a plugin-contributed menu row ("Export
// failed"), as one translated sentence. It runs when the row's action
// settles, so it reads the UI's language at that moment.

import { translate as tl } from "@ryu/i18n/core";

/** "{label} failed" for a contributed row without its own error copy. */
export function contributedRowFailedLabel(label: string): string {
	return tl("{label} failed", { label });
}
