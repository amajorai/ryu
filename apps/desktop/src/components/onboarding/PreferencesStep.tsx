// The onboarding general-settings step. It is deliberately the same knobs the
// Settings → General / Appearance panels lead with (inset sidebar, pointer
// cursor, start-at-login) driven through the *same* setters, so whatever the
// user picks here is already persisted by the time onboarding finishes — there
// is no separate onboarding preference state to reconcile later.
//
// "Start Ryu on startup" is an OS registration (macOS LaunchAgent, Windows Run
// key, Linux ~/.config/autostart), so the OS — not a local mirror — is the
// source of truth: seed the toggle from the plugin and revert on write failure,
// exactly as the General tab does. It is the one knob here that is ON by
// default, and because there is no stored default to flip, this step performs
// the registration once on a fresh machine — see the effect below for why
// onboarding is the right (and only) place for that.

import {
	OnboardingActions,
	OnboardingCta,
} from "@ryu/blocks/desktop/onboarding-shell.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { invoke } from "@tauri-apps/api/core";
import {
	disable as disableAutostart,
	enable as enableAutostart,
	isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import { useEffect, useRef, useState } from "react";
import {
	SettingsGroup,
	SettingsItem,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import {
	setPointerCursor,
	usePointerCursor,
} from "@/src/hooks/usePointerCursor.ts";
import { useSidebarVariant } from "@/src/hooks/useSidebarVariant.ts";
import { ActivationStepShell } from "./ActivationStepShell.tsx";

/**
 * One-shot marker for the launch-at-login opt-in below. Deliberately its own key
 * rather than a reuse of `ryu_onboarding_complete`: this must record "we already
 * offered this once on this machine", which is a different fact from "onboarding
 * finished".
 */
const AUTOSTART_SEEDED_KEY = "ryu_autostart_seeded";

interface PreferencesStepProps {
	/** Onboarding is finishing; the step locks so the user can't double-submit. */
	busy?: boolean;
	onContinue: () => void;
}

export function PreferencesStep({
	busy = false,
	onContinue,
}: PreferencesStepProps) {
	const { canManageDesktopLifecycle } = useAppSurface();
	const [sidebarVariant, setSidebarVariant] = useSidebarVariant();
	const pointerCursorEnabled = usePointerCursor();
	const [launchAtLogin, setLaunchAtLogin] = useState(false);
	// Flipped the moment the user touches the switch, so the opt-in-by-default
	// bootstrap below can never overwrite a deliberate choice made while the OS
	// probe was still in flight.
	const userTouchedLaunchAtLogin = useRef(false);
	// "Stay in tray on close" needs no seeding pass, unlike launch-at-login: it is
	// a stored desktop preference whose ABSENT value already reads as ON, so the
	// switch starts true and only ever writes when the user changes it.
	const [closeToTray, setCloseToTray] = useState(true);
	useEffect(() => {
		if (!canManageDesktopLifecycle) {
			return;
		}
		invoke<boolean>("get_close_to_tray")
			.then(setCloseToTray)
			.catch(() => {
				// Non-Tauri context or command unavailable: keep the default.
			});
	}, [canManageDesktopLifecycle]);

	const handleCloseToTray = async (enabled: boolean) => {
		setCloseToTray(enabled);
		try {
			await invoke("set_close_to_tray", { enabled });
		} catch {
			setCloseToTray(!enabled);
			toast.error({
				title: "Couldn't update the close-to-tray setting",
				description: "Your change wasn't saved. Please try again.",
			});
		}
	};

	// "Start Ryu on startup" lives in the OS, not in a local mirror — there is no
	// stored default to flip, so defaulting it ON means actually registering with
	// the OS. Onboarding is where that is legitimate: the switch and its
	// description are on screen while it happens and it is reversible in the same
	// view, so the step itself is the consent.
	//
	// Strictly one-shot per machine, via its own `ryu_autostart_seeded` marker
	// rather than `ryu_onboarding_complete` — the latter is only written when
	// onboarding FINISHES (OnboardingPage), so it is always absent right here and
	// would gate nothing. The marker is written before the call, so a re-run of
	// onboarding never silently re-enables autostart for someone who turned it off.
	useEffect(() => {
		if (!canManageDesktopLifecycle) {
			return;
		}
		let cancelled = false;

		const seedLaunchAtLogin = async () => {
			let alreadyEnabled = false;
			try {
				alreadyEnabled = await isAutostartEnabled();
			} catch {
				// Non-Tauri context or unsupported platform: keep the default.
				return;
			}
			if (cancelled) {
				return;
			}
			if (alreadyEnabled) {
				setLaunchAtLogin(true);
				return;
			}
			if (
				userTouchedLaunchAtLogin.current ||
				localStorage.getItem(AUTOSTART_SEEDED_KEY) === "true"
			) {
				return;
			}
			localStorage.setItem(AUTOSTART_SEEDED_KEY, "true");
			try {
				await enableAutostart();
			} catch {
				// Unsupported platform or a refused registration: leave the switch
				// reading its real (off) value rather than lying about the OS. No
				// toast — the user did not ask for this, so it must not report at them.
				return;
			}
			if (!(cancelled || userTouchedLaunchAtLogin.current)) {
				setLaunchAtLogin(true);
			}
		};

		void seedLaunchAtLogin();
		return () => {
			cancelled = true;
		};
	}, [canManageDesktopLifecycle]);

	const handleLaunchAtLogin = async (enabled: boolean) => {
		userTouchedLaunchAtLogin.current = true;
		setLaunchAtLogin(enabled);
		try {
			await (enabled ? enableAutostart() : disableAutostart());
		} catch {
			// Revert the optimistic toggle if the OS registration failed.
			setLaunchAtLogin(!enabled);
			toast.error({
				title: "Couldn't update the launch-at-login setting",
				description:
					"Your change wasn't saved. You may need to allow Ryu to start at login in your system settings.",
			});
		}
	};

	return (
		<ActivationStepShell
			subtitle="You can change any of these later in Settings."
			title="Set your preferences"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={sidebarVariant === "inset"}
							id="onboarding-inset-sidebar"
							onCheckedChange={(checked) =>
								setSidebarVariant(checked ? "inset" : "floating")
							}
						/>
					}
					description="Sit the sidebar flush against the window, with the content as its own card."
					title="Inset sidebar"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={pointerCursorEnabled}
							id="onboarding-pointer-cursor"
							onCheckedChange={setPointerCursor}
						/>
					}
					description="Show a pointer cursor when hovering over interactive elements."
					title="Pointer cursor"
				/>
				{canManageDesktopLifecycle ? (
					<>
						<SettingsItem
							actions={
								<Switch
									checked={launchAtLogin}
									id="onboarding-launch-at-login"
									onCheckedChange={handleLaunchAtLogin}
								/>
							}
							description="Start Ryu when you sign in, so your agents are ready."
							title="Start Ryu on startup"
						/>
						<SettingsItem
							actions={
								<Switch
									checked={closeToTray}
									id="onboarding-close-to-tray"
									onCheckedChange={handleCloseToTray}
								/>
							}
							description="Closing the window keeps Ryu and its background agents running."
							title="Stay in tray on close"
						/>
					</>
				) : null}
			</SettingsGroup>
			<OnboardingActions>
				<OnboardingCta disabled={busy} onClick={onContinue}>
					{busy ? "Finishing…" : "Continue"}
				</OnboardingCta>
			</OnboardingActions>
		</ActivationStepShell>
	);
}
