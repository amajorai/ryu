// The onboarding notifications step. The shell is shared by the desktop app, the
// browser extension, and the web app (desktop and phone browsers), so the copy,
// the permission request, and the "blocked" recovery all come from the platform
// the shell is running on. Enabling sends a real notification from the user's
// default agent, avatar included, so they see the result before moving on.

import { Notification03Icon, Settings02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ONBOARDING_CONTENT_DELAY_MS } from "@ryu/blocks/desktop/onboarding.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { PageHeader } from "@ryu/ui/components/page-header.tsx";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal.tsx";
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
			className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-md"
		>
			<RyuOnboardingAvatar size={40} />
			<div className="min-w-0 flex-1">
				<p className="truncate font-medium text-sm" title={name}>
					{name}
				</p>
				<p className="truncate text-muted-foreground text-xs">
					Finished your task — ready for you to review.
				</p>
			</div>
			<span className="self-start text-muted-foreground text-xs">now</span>
		</div>
	);
}

export function NotificationsStep({
	busy,
	onContinue,
}: NotificationsStepProps) {
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
		<div className="scroll-fade h-full w-full overflow-y-auto">
			<div
				className="flex min-h-full w-full flex-col items-center justify-center gap-8 p-8"
				data-tauri-drag-region="true"
			>
				<StaggerReveal>
					<div className="shrink-0">
						<RyuOnboardingAvatar />
					</div>
					<PageHeader
						stagger={false}
						subtitle={copy.subtitle}
						title="Know when your agents reply"
					/>
				</StaggerReveal>

				<div className="flex w-full max-w-md flex-col gap-6">
					<StaggerReveal startDelay={ONBOARDING_CONTENT_DELAY_MS} wrap>
						<NotificationPreview name={persona.name} />

						{status === "enabled" && (
							<div className="flex items-start gap-2 text-sm" role="status">
								<HugeiconsIcon
									className="mt-0.5 shrink-0 text-primary"
									icon={Notification03Icon}
									size={16}
								/>
								<span className="text-muted-foreground">
									Notifications are on. We just sent a test one.
									{platform === "desktop" ? ` ${copy.blockedHelp}` : ""}
								</span>
							</div>
						)}

						{blocked && copy.supported && (
							<p className="text-sm text-status-destructive" role="alert">
								{copy.blockedHelp}
							</p>
						)}

						<div className="flex flex-wrap items-center justify-end gap-2">
							{showSettingsLink && (
								<Button
									onClick={() => {
										openNotificationSettings().catch(() => undefined);
									}}
									type="button"
									variant="ghost"
								>
									<HugeiconsIcon icon={Settings02Icon} size={16} />
									Notification settings
								</Button>
							)}
							{status === "enabled" || !copy.supported ? (
								<Button
									disabled={busy}
									onClick={onContinue}
									size="lg"
									type="button"
									variant="mono"
								>
									Continue
								</Button>
							) : (
								<>
									<Button
										disabled={busy || status === "requesting"}
										onClick={skip}
										size="lg"
										type="button"
										variant="ghost"
									>
										Not now
									</Button>
									<Button
										disabled={busy || status === "requesting"}
										onClick={() => {
											enable().catch(() => setStatus("blocked"));
										}}
										size="lg"
										type="button"
										variant="mono"
									>
										<HugeiconsIcon icon={Notification03Icon} size={16} />
										{enableButtonLabel(status, blocked, copy.enableLabel)}
									</Button>
								</>
							)}
						</div>
					</StaggerReveal>
				</div>
			</div>
		</div>
	);
}
