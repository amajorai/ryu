/**
 * Localized device-limit copy shared by the sign-in screen, the account
 * switcher, the startup chooser, and the Sessions settings. The English
 * sentences mirror `deviceLimitReachedMessage` and the generic refusal in
 * `apps/desktop/lib/device-limit-error.ts`; tests pin them together.
 */

import type { DeviceSurface } from "@ryu/auth/lib/device-limits";
import type { LiteralMessage } from "@ryu/i18n/react";
import { DeviceLimitReachedError } from "@/lib/device-limit-error.ts";

/**
 * Localized surface names. Each literal mirrors `DEVICE_SURFACE_LABELS` in
 * `@ryu/auth/lib/device-limits` (a test pins them together) so the i18n
 * extractor sees every string.
 */
export function deviceSurfaceLabels(
	tl: LiteralMessage
): Record<DeviceSurface, string> {
	return {
		web: tl("Web browsers"),
		desktop: tl("Ryu Desktop"),
		self_hosted: tl("Self-hosted and headless Core"),
		mobile: tl("Mobile apps"),
		extension: tl("Browser extension"),
		cli: tl("CLI and MCP"),
	};
}

/** The localized refusal sentence for a device-limit error. */
export function localizedDeviceLimitMessage(
	tl: LiteralMessage,
	error: DeviceLimitReachedError
): string {
	if (error.surface && error.limit !== null) {
		return tl(
			"Device limit reached for {surfaceLabel}: this account is already signed in on the maximum of {limit, plural, one {# device} other {# devices}}. Sign out of one you no longer use, then try again.",
			{
				surfaceLabel: deviceSurfaceLabels(tl)[error.surface],
				limit: error.limit,
			}
		);
	}
	return tl(
		"Device limit reached: this account is already signed in on as many devices of this kind as it allows. Sign out of one you no longer use, then try again."
	);
}

/**
 * A sign-in failure's description: the localized sentence for a device-limit
 * refusal, else the error's own message.
 */
export function signInErrorDescription(
	tl: LiteralMessage,
	error: Error
): string {
	return error instanceof DeviceLimitReachedError
		? localizedDeviceLimitMessage(tl, error)
		: error.message;
}
