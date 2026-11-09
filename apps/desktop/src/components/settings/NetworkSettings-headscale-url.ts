import type { LiteralMessage } from "@ryu/i18n/react";
import { isValidHeadscaleUrl } from "./NetworkSettings-network-resource.ts";

/** Why the Headscale control server URL cannot be saved, in the reader's
 *  language, or `null` when it is a usable HTTP or HTTPS URL. */
export function headscaleUrlErrorText(
	url: string,
	tl: LiteralMessage
): string | null {
	if (isValidHeadscaleUrl(url)) {
		return null;
	}
	return url.trim()
		? tl("Enter a valid HTTP or HTTPS URL.")
		: tl("Enter the Headscale control server URL.");
}
