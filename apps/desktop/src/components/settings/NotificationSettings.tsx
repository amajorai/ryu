import { Button } from "@ryu/ui/components/button.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useMemo, useState } from "react";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import {
	detectDeviceOs,
	notificationOnboardingCopy,
} from "@/src/lib/notifications/notification-onboarding.ts";
import {
	setOsNotificationsEnabled,
	useOsNotificationsChoice,
} from "@/src/lib/notifications/notification-preferences.ts";
import {
	getOsNotificationPermission,
	type OsNotificationPermission,
	osNotificationsEnabled,
	requestOsNotificationPermission,
	showOsNotification,
} from "@/src/lib/notifications/os-notify.ts";
import { useNotificationPlatform } from "@/src/lib/notifications/use-notification-platform.ts";
import {
	canOpenNotificationSettings,
	openNotificationSettings,
} from "@/src/lib/os/permissions.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/**
 * The device-local OS notification switch. Works on every host of the shared
 * shell: turning it on asks the browser or extension for permission from this
 * click, and on desktop links to the OS notification settings instead.
 */
export function NotificationSettings() {
	const { surface } = useAppSurface();
	const choice = useOsNotificationsChoice();
	const platform = useNotificationPlatform();
	const os = useMemo(() => detectDeviceOs(navigator.userAgent), []);
	const [permission, setPermission] =
		useState<OsNotificationPermission>("default");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let cancelled = false;
		getOsNotificationPermission()
			.then((current) => {
				if (!cancelled) {
					setPermission(current);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [platform]);

	const copy = notificationOnboardingCopy({
		os,
		permission,
		platform,
		surface,
	});
	// `choice` is read so the switch re-renders when it changes; the effective
	// state also covers users who have not chosen yet.
	const enabled = choice ?? osNotificationsEnabled();

	const toggle = async (next: boolean) => {
		if (!next) {
			setOsNotificationsEnabled(false);
			return;
		}
		setBusy(true);
		try {
			const result = await requestOsNotificationPermission();
			setPermission(result);
			if (result === "granted") {
				setOsNotificationsEnabled(true);
			}
		} finally {
			setBusy(false);
		}
	};

	const sendTest = () => {
		showOsNotification({
			title: "Ryu",
			body: "Notifications are working on this device.",
			tag: "ryu-settings-notification-test",
		}).catch(() => undefined);
	};

	return (
		<SettingsSection
			caption="Notifications are set per device. Agent replies show the agent's avatar."
			title="Notifications"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							aria-label="Show notifications on this device"
							checked={enabled && permission !== "denied"}
							disabled={busy || !copy.supported}
							onCheckedChange={(next) => {
								toggle(next).catch(() => undefined);
							}}
						/>
					}
					description={copy.subtitle}
					title="Show notifications on this device"
				/>
				{copy.supported && permission === "denied" && (
					<SettingsItem description={copy.blockedHelp} title="Blocked" />
				)}
				{copy.supported && enabled && permission !== "denied" && (
					<SettingsItem
						actions={
							<div className="flex flex-wrap items-center gap-2">
								{platform === "desktop" && canOpenNotificationSettings() && (
									<Button
										onClick={() => {
											openNotificationSettings().catch(() => undefined);
										}}
										size="sm"
										variant="ghost"
									>
										Open notification settings
									</Button>
								)}
								<Button onClick={sendTest} size="sm" variant="secondary">
									Send test notification
								</Button>
							</div>
						}
						description={platform === "desktop" ? copy.blockedHelp : undefined}
						title="Check delivery"
					/>
				)}
			</SettingsGroup>
		</SettingsSection>
	);
}
