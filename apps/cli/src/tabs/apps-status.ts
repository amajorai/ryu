// Copy for the Apps tab's install-state column and its "already" notice. An
// install_state id (`installed`, `installing`) spliced into translated text
// stays English in every language, so each state gets its own catalog entry.

import { tf, tr } from "../i18n/translate.ts";

export interface AppStatusColors {
	error: string;
	info: string;
	mutedForeground: string;
	success: string;
}

export interface AppStatus {
	color: string;
	icon: string;
	label: string;
}

/** An install_state's icon, translated label and color (parity with the
 * status column in apps/cli's render_apps_content). */
export function appStatusFor(
	state: string,
	colors: AppStatusColors
): AppStatus {
	if (state === "failed") {
		return { icon: "✗", label: tr("failed"), color: colors.error };
	}
	if (state === "installing") {
		return { icon: "◌", label: tr("installing"), color: colors.info };
	}
	if (state === "installed") {
		return { icon: "●", label: tr("installed"), color: colors.success };
	}
	return { icon: " ", label: "-", color: colors.mutedForeground };
}

/** The status cell: the state's icon and label, or a spinner while busy. */
export function appStatusText(status: AppStatus, busy: boolean): string {
	return busy ? `◌ ${tr("working")}` : `${status.icon} ${status.label}`;
}

/** The notice when installing an app that is installed or being installed. */
export function alreadyInstalledText(name: string, state: string): string {
	return state === "installing"
		? tf("{name} is already being installed", { name })
		: tf("{name} is already installed", { name });
}
