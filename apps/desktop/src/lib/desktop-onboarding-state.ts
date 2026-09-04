/**
 * The desktop-level onboarding marker. This is deliberately local to the
 * installed client: theme, window, privacy, and device preferences belong to a
 * desktop user, not to whichever Core node is currently selected.
 */
export const DESKTOP_ONBOARDING_COMPLETE_KEY =
	"ryu_desktop_onboarding_complete";

/** Legacy marker used by releases before node onboarding was introduced. */
const LEGACY_DESKTOP_ONBOARDING_COMPLETE_KEY = "ryu_onboarding_complete";

/** Decide whether the app must mount onboarding for either state owner. */
export function shouldStartOnboarding({
	desktopComplete,
	nodeCanConfigure,
	nodeComplete,
	nodeStateAvailable,
}: {
	desktopComplete: boolean;
	nodeCanConfigure?: boolean;
	nodeComplete: boolean | undefined;
	nodeStateAvailable: boolean;
}): boolean {
	return (
		!desktopComplete ||
		(nodeStateAvailable && nodeCanConfigure !== false && nodeComplete !== true)
	);
}

export function isDesktopOnboardingComplete(): boolean {
	try {
		const current = localStorage.getItem(DESKTOP_ONBOARDING_COMPLETE_KEY);
		if (current === "true") {
			return true;
		}
		if (
			localStorage.getItem(LEGACY_DESKTOP_ONBOARDING_COMPLETE_KEY) === "true"
		) {
			// Migrate the old client-only marker without making it the canonical
			// contract again.
			localStorage.setItem(DESKTOP_ONBOARDING_COMPLETE_KEY, "true");
			return true;
		}
	} catch {
		return false;
	}
	return false;
}

export function markDesktopOnboardingComplete(): void {
	try {
		localStorage.setItem(DESKTOP_ONBOARDING_COMPLETE_KEY, "true");
		localStorage.removeItem(LEGACY_DESKTOP_ONBOARDING_COMPLETE_KEY);
	} catch {
		// The route still completes when storage is unavailable; the next launch
		// will safely show onboarding again rather than pretending it persisted.
	}
}

export function resetDesktopOnboarding(): void {
	try {
		localStorage.removeItem(DESKTOP_ONBOARDING_COMPLETE_KEY);
		localStorage.removeItem(LEGACY_DESKTOP_ONBOARDING_COMPLETE_KEY);
	} catch {
		// Storage can be unavailable in a locked-down webview.
	}
}
