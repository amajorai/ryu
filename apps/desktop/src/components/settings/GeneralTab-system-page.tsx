import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { invoke } from "@tauri-apps/api/core";
import {
	disable as disableAutostart,
	enable as enableAutostart,
	isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import { useEffect, useState } from "react";
import {
	HardwareAccelerationSetting,
	KeepAwakeSetting,
} from "./GeneralTab-system-settings.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/** Tray, login-launch and start-hidden state, loaded when the General tab mounts. */
export function useGeneralTabSystemControls(
	canManageDesktopLifecycle: boolean
) {
	// Tray visibility is persisted in the desktop process (tauri-plugin-store) so
	// it can be read at startup before Core is up. Disabled by default — the
	// icon shows in the tray / menu bar unless the user opts out.
	const [hideTrayIcon, setHideTrayIcon] = useState(false);
	// "Stay in the tray when closed" lives in the same desktop-process store and
	// is ON by default, so seed it optimistically to true — reading it back false
	// for a frame would flash the toggle off on every open.
	const [closeToTray, setCloseToTray] = useState(true);
	useEffect(() => {
		if (!canManageDesktopLifecycle) {
			return;
		}
		invoke<boolean>("get_hide_tray_icon")
			.then(setHideTrayIcon)
			.catch(() => {
				// Non-Tauri context or command unavailable: keep the default.
			});
		invoke<boolean>("get_close_to_tray")
			.then(setCloseToTray)
			.catch(() => {
				// Non-Tauri context or command unavailable: keep the default.
			});
	}, [canManageDesktopLifecycle]);

	// "Launch at login" is an OS registration (macOS LaunchAgent, Windows Run key,
	// Linux ~/.config/autostart), so the OS — not a local mirror — is the source
	// of truth: seed the toggle from the plugin. "Start hidden" is a local desktop
	// preference read during startup, and only applies to a login-launched
	// instance, so a manual launch is always visible.
	const [launchAtLogin, setLaunchAtLogin] = useState(false);
	const [startHidden, setStartHidden] = useState(false);
	useEffect(() => {
		if (!canManageDesktopLifecycle) {
			return;
		}
		isAutostartEnabled()
			.then(setLaunchAtLogin)
			.catch(() => {
				// Non-Tauri context or unsupported platform: keep the default.
			});
		invoke<boolean>("get_start_hidden")
			.then(setStartHidden)
			.catch(() => {
				// Non-Tauri context or command unavailable: keep the default.
			});
	}, [canManageDesktopLifecycle]);

	const handleLaunchAtLogin = async (enabled: boolean) => {
		setLaunchAtLogin(enabled);
		try {
			await (enabled ? enableAutostart() : disableAutostart());
		} catch {
			setLaunchAtLogin(!enabled);
			toast.error("Couldn't update the launch-at-login setting", {
				description:
					"Your change wasn't saved. You may need to allow Ryu to start at login in your system settings.",
			});
		}
	};

	const handleStartHidden = async (hidden: boolean) => {
		setStartHidden(hidden);
		try {
			await invoke("set_start_hidden", { hidden });
		} catch {
			setStartHidden(!hidden);
			toast.error("Couldn't update the start-hidden setting", {
				description: "Your change wasn't saved. Please try again.",
			});
		}
	};

	const handleCloseToTray = async (enabled: boolean) => {
		setCloseToTray(enabled);
		try {
			await invoke("set_close_to_tray", { enabled });
		} catch {
			setCloseToTray(!enabled);
			toast.error("Couldn't update the close-to-tray setting", {
				description: "Your change wasn't saved. Please try again.",
			});
		}
	};

	const handleHideTrayIcon = async (hidden: boolean) => {
		setHideTrayIcon(hidden);
		try {
			await invoke("set_hide_tray_icon", { hidden });
		} catch {
			// Revert the optimistic toggle if the command failed.
			setHideTrayIcon(!hidden);
			toast.error("Couldn't update the tray icon setting", {
				description: "Your change wasn't saved. Please try again.",
			});
		}
	};

	const handleShowInMenuBar = (show: boolean) => {
		void handleHideTrayIcon(!show);
	};

	return {
		closeToTray,
		handleCloseToTray,
		handleLaunchAtLogin,
		handleShowInMenuBar,
		handleStartHidden,
		hideTrayIcon,
		launchAtLogin,
		startHidden,
	};
}

export function GeneralTabSystemPage({
	controls,
}: {
	controls: ReturnType<typeof useGeneralTabSystemControls>;
}) {
	const {
		closeToTray,
		handleCloseToTray,
		handleLaunchAtLogin,
		handleShowInMenuBar,
		handleStartHidden,
		hideTrayIcon,
		launchAtLogin,
		startHidden,
	} = controls;
	return (
		<SettingsSection>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={launchAtLogin}
							id="launch-at-login-toggle"
							onCheckedChange={handleLaunchAtLogin}
						/>
					}
					title="Start Ryu on startup"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={startHidden}
							disabled={!launchAtLogin}
							id="start-hidden-toggle"
							onCheckedChange={handleStartHidden}
						/>
					}
					description="At login, run in the background with no window. Opening Ryu shows it."
					title="Start hidden"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={closeToTray && !hideTrayIcon}
							disabled={hideTrayIcon}
							id="close-to-tray-toggle"
							onCheckedChange={handleCloseToTray}
						/>
					}
					title="Stay in tray on close"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={!hideTrayIcon}
							id="show-in-menu-bar-toggle"
							onCheckedChange={handleShowInMenuBar}
						/>
					}
					settingsId="general.system.show-in-menu-bar"
					title="Show in menu bar"
				/>
				<HardwareAccelerationSetting />
				<KeepAwakeSetting />
			</SettingsGroup>
		</SettingsSection>
	);
}
