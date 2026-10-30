// The onboarding notifications step. The shell is shared by the desktop app, the
// browser extension, and the web app (desktop and phone browsers), so the copy,
// the permission request, and the "blocked" recovery all come from the platform
// the shell is running on. Enabling sends a real notification from the user's
// default agent, avatar included, so they see the result before moving on.

import { Notification03Icon, Settings02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	OnboardingActions,
	OnboardingCta,
} from "@ryu/blocks/desktop/onboarding-shell.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useMemo, useState } from "react";
import {
	RyuOnboardingAvatar,
	useRyuOnboardingPersona,
} from "@/src/components/onboarding/RyuOnboardingPersona.tsx";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import {
	detectDeviceOs,
	notificationOnboardingCopy,
} from "@/src/lib/notifications/notification-onboarding.ts";
import { setOsNotificationsEnabled } from "@/src/lib/notifications/notification-preferences.ts";
import {
	getOsNotificationPermission,
	type OsNotificationPermission,
	requestOsNotificationPermission,
	showOsNotification,
} from "@/src/lib/notifications/os-notify.ts";
import { useNotificationPlatform } from "@/src/lib/notifications/use-notification-platform.ts";
import {
	canOpenNotificationSettings,
	openNotificationSettings,
} from "@/src/lib/os/permissions.ts";
import { ActivationStepShell } from "./ActivationStepShell.tsx";

type StepStatus = "idle" | "requesting" | "enabled" | "blocked";

interface NotificationsStepProps {
	busy?: boolean;
	onContinue: () => void;
}

function enableButtonLabel(
	status: StepStatus,
	blocked: boolean,
	enableLabel: string
): string {
	if (status === "requesting") {
		return "Waiting for permission…";
	}
	return blocked ? "Try again" : enableLabel;
}

/** A static picture of the notification the user is about to turn on. */
function NotificationPreview({ name }: { name: string }) {
	return (
		<div
			aria-hidden="true"
			className="flex w-full items-center gap-3 rounded-xl border border-border p-3"
		>
			<RyuOnboardingAvatar size={40} />
			<div className="min-w-0 flex-1">
				<p className="truncate font-medium text-sm" title={name}>
					{name}
				</p>
				<p className="truncate text-detail text-muted-foreground">
					Finished your task — ready for you to review.
				</p>
			</div>
			<span className="self-start text-muted-foreground/70 text-xs">now</span>
		</div>
	);
}

export function NotificationsStep({
	busy,
	onContinue,
}: NotificationsStepProps) {
	const tl = useLiteralMessages();
	const { surface } = useAppSurface();
	const persona = useRyuOnboardingPersona();
	const platform = useNotificationPlatform();
	const os = useMemo(() => detectDeviceOs(navigator.userAgent), []);
	const [permission, setPermission] =
		useState<OsNotificationPermission>("default");
	const [status, setStatus] = useState<StepStatus>("idle");

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
	const blocked = status === "blocked" || permission === "denied";
	const showSettingsLink =
		platform === "desktop" && canOpenNotificationSettings();

	const enable = async () => {
		setStatus("requesting");
		const result = await requestOsNotificationPermission();
		setPermission(result);
		if (result !== "granted") {
			setStatus("blocked");
			return;
		}
		setOsNotificationsEnabled(true);
		setStatus("enabled");
		await showOsNotification({
			title: persona.name,
			body: "Notifications are on. I'll let you know when I reply.",
			tag: "ryu-onboarding-notification-test",
			sender: {
				id: "onboarding-default-agent",
				name: persona.name,
				avatarGlyph: persona.avatar,
			},
		});
	};

	const skip = () => {
		setOsNotificationsEnabled(false);
		onContinue();
	};

	return (
		<ActivationStepShell
			subtitle={copy.subtitle}
			title="Know when your agents reply"
		>
			<NotificationPreview name={persona.name} />

			{status === "enabled" && (
				<div className="flex items-start gap-2 text-sm" role="status">
					<HugeiconsIcon
						className="mt-0.5 shrink-0 text-muted-foreground"
						icon={Notification03Icon}
						size={16}
					/>
					<span className="text-muted-foreground">
						{platform === "desktop"
							? tl(
									"Notifications are on. We just sent a test one. {blockedHelp}",
									{ blockedHelp: copy.blockedHelp }
								)
							: tl("Notifications are on. We just sent a test one.")}
					</span>
				</div>
			)}

			{blocked && copy.supported && (
				<p className="text-sm text-status-destructive" role="alert">
					{copy.blockedHelp}
				</p>
			)}

			<OnboardingActions>
				{showSettingsLink && (
					<OnboardingCta
						onClick={() => {
							openNotificationSettings().catch(() => undefined);
						}}
						tone="secondary"
						type="button"
					>
						<HugeiconsIcon icon={Settings02Icon} size={16} />
						Notification settings
					</OnboardingCta>
				)}
				{status === "enabled" || !copy.supported ? (
					<OnboardingCta disabled={busy} onClick={onContinue} type="button">
						Continue
					</OnboardingCta>
				) : (
					<>
						<OnboardingCta
							disabled={busy || status === "requesting"}
							onClick={skip}
							tone="secondary"
							type="button"
						>
							Not now
						</OnboardingCta>
						<OnboardingCta
							disabled={busy || status === "requesting"}
							onClick={() => {
								enable().catch(() => setStatus("blocked"));
							}}
							type="button"
						>
							{enableButtonLabel(status, blocked, copy.enableLabel)}
						</OnboardingCta>
					</>
				)}
			</OnboardingActions>
		</ActivationStepShell>
	);
}
