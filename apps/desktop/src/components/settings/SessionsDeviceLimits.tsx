import {
	type DeviceLimitSummary,
	type DeviceSurface,
	isDeviceSurface,
} from "@ryu/auth/lib/device-limits";
import { useLiteralMessages } from "@ryu/i18n/react";
import { deviceSurfaceLabels } from "@/src/lib/device-limit-copy.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

// Re-exported so existing settings imports keep one entry point.
export { deviceSurfaceLabels } from "@/src/lib/device-limit-copy.ts";

/** The surface the API stamped on a session row, if it sent a known one. */
export function sessionSurface(session: object): DeviceSurface | null {
	const surface: unknown = Reflect.get(session, "surface");
	return isDeviceSurface(surface) ? surface : null;
}

/**
 * Per-surface "{count} of {limit}" usage. Rendered only while the account's
 * device limits are enforced; otherwise the caps are informational and the
 * session list already says everything.
 */
export function SessionsDeviceLimits({
	summary,
}: {
	summary: DeviceLimitSummary | undefined;
}) {
	const tl = useLiteralMessages();
	if (!summary?.enforced || summary.surfaces.length === 0) {
		return null;
	}
	const labels = deviceSurfaceLabels(tl);

	return (
		<SettingsSection
			caption="Each kind of device has its own limit. Revoke a session you no longer use to sign in somewhere new."
			title="Device limits"
		>
			<SettingsGroup>
				{summary.surfaces.map((usage) => {
					const full = usage.count >= usage.limit;
					return (
						<SettingsItem key={usage.surface} title={labels[usage.surface]}>
							<p
								className={
									full
										? "font-medium text-destructive text-xs"
										: "text-muted-foreground text-xs"
								}
								data-device-limit-usage={usage.surface}
							>
								{full
									? tl("{count} of {limit} · Limit reached", {
											count: usage.count,
											limit: usage.limit,
										})
									: tl("{count} of {limit}", {
											count: usage.count,
											limit: usage.limit,
										})}
							</p>
						</SettingsItem>
					);
				})}
			</SettingsGroup>
		</SettingsSection>
	);
}
