"use client";

import { useOptionalI18n } from "@ryu/i18n/react";

/**
 * A platform tile's name. A row with a `senseId` reads through that keyed
 * sense: the bare catalog "Watch" is the observe verb (de "Beobachten"), while
 * the platform is the wrist device (`hardware.deviceWatch`, de "Uhr"). Other
 * names stay literal text for the DOM localizer.
 */
export function AvailabilityPlatformName({
	platform,
	senseId,
}: {
	platform: string;
	senseId?: string;
}) {
	const i18n = useOptionalI18n();
	if (!senseId) {
		return platform;
	}
	return i18n?.t(senseId, {}, platform) ?? platform;
}
