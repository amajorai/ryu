import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { MicPermissionPrompt } from "@/src/components/permissions/MicPermissionPrompt.tsx";
import {
	openAccessibilitySettings,
	openInputMonitoringSettings,
	openScreenRecordingSettings,
	requestAccessibilityPermission,
	requestInputMonitoringPermission,
	requestScreenRecordingPermission,
} from "@/src/lib/os/permissions.ts";
import { invokeWhenReady } from "@/src/lib/tauri-ready.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

const CAPABILITIES = [
	{
		label: "Screen Recording",
		check: "check_screen_recording_permission",
		request: requestScreenRecordingPermission,
		open: openScreenRecordingSettings,
		description: "Clips and Shadow capture; Ghost screenshots.",
	},
	{
		label: "Accessibility",
		check: "check_accessibility_permission",
		request: requestAccessibilityPermission,
		open: openAccessibilitySettings,
		description: "Ghost automation and Shadow app context.",
	},
	{
		label: "Input Monitoring",
		check: "check_input_monitoring_permission",
		request: requestInputMonitoringPermission,
		open: openInputMonitoringSettings,
		description: "Capture shortcuts and Ghost learning.",
	},
] as const;

export function DevicePermissionsSettings() {
	const tl = useLiteralMessages();
	const refreshRevision = useRef(0);
	const [grants, setGrants] = useState<boolean[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const isMac = navigator.userAgent.includes("Mac");
	const isWindows = navigator.userAgent.includes("Windows");

	const refresh = useCallback(async () => {
		const revision = ++refreshRevision.current;
		try {
			const next = await Promise.all(
				CAPABILITIES.map((capability) =>
					invokeWhenReady<boolean>(capability.check)
				)
			);
			if (revision !== refreshRevision.current) {
				return;
			}
			setGrants(next);
			setError(null);
		} catch {
			if (revision !== refreshRevision.current) {
				return;
			}
			setGrants(null);
			setError(
				"Couldn't check device access. Open this page in Ryu Desktop and retry."
			);
		}
	}, []);

	useEffect(() => {
		void refresh();
		window.addEventListener("focus", refresh);
		return () => {
			refreshRevision.current += 1;
			window.removeEventListener("focus", refresh);
		};
	}, [refresh]);

	return (
		<SettingsSection
			caption="These permissions belong to this computer. For a remote node, check access on that node. After changing macOS permissions, restart Ryu and retry the capture."
			title="Device permissions"
		>
			<SettingsGroup>
				<SettingsItem
					description="Voice input in chat and onboarding."
					title="Microphone"
				>
					<MicPermissionPrompt />
				</SettingsItem>
				{CAPABILITIES.map((capability, index) => (
					<SettingsItem
						actions={
							<div className="flex flex-wrap items-center gap-2">
								<span className="text-muted-foreground text-xs" role="status">
									{grants === null
										? "Unchecked"
										: grants[index]
											? isMac
												? "Granted"
												: "No OS prompt required"
											: "Unavailable"}
								</span>
								{isMac && (
									<>
										{grants?.[index] !== true && (
											<Button
												disabled={busy !== null}
												onClick={async () => {
													setBusy(capability.label);
													try {
														await capability.request();
														await refresh();
													} finally {
														setBusy(null);
													}
												}}
												size="sm"
												variant="secondary"
											>
												{busy === capability.label
													? "Requesting…"
													: tl("Request {label}", { label: capability.label })}
											</Button>
										)}
										<Button
											onClick={async () => {
												if (!(await capability.open())) {
													setError(
														"Couldn't open system settings. Open Privacy & Security manually."
													);
												}
											}}
											size="sm"
											variant="ghost"
										>
											{tl("Open {label} settings", { label: capability.label })}
										</Button>
									</>
								)}
							</div>
						}
						description={capability.description}
						key={capability.label}
						title={capability.label}
					/>
				))}
			</SettingsGroup>
			{!(isMac || isWindows) && (
				<p className="text-muted-foreground text-xs">
					Native screen capture and global automation require X11. Wayland
					portals are not supported by this recorder. Input learning also
					requires access to input devices.
				</p>
			)}
			{error && (
				<p className="text-status-destructive text-xs" role="alert">
					{error}
				</p>
			)}
			<Button onClick={refresh} size="sm" variant="ghost">
				Check access again
			</Button>
		</SettingsSection>
	);
}
