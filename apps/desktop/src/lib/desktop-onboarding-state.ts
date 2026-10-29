import { z } from "zod";

/**
 * The desktop-level onboarding marker. This is deliberately local to the
 * installed client: theme, window, privacy, and device preferences belong to a
 * desktop user, not to whichever Core node is currently selected.
 */
export const DESKTOP_ONBOARDING_COMPLETE_KEY =
	"ryu_desktop_onboarding_complete";
export const DESKTOP_ONBOARDING_PHASE_KEY = "ryu_desktop_onboarding_phase";
export const DESKTOP_ONBOARDING_PROJECT_KEY =
	"ryu_desktop_onboarding_project_v1";

export const DESKTOP_ONBOARDING_PHASES = [
	"intro",
	"updates",
	"choose",
	"connect",
	"installing",
	"agents",
	"migrate",
	"skills",
	"node-setup",
	"local-default",
	"organization",
	"providers",
	"connections",
	"cloud-default",
	"imports",
	"profile",
	"agent-suggestions",
	"personalize-agent",
	"first-project",
	"telegram",
	"features",
	"mic",
	"theme",
	"safety",
	"preferences",
	"privacy",
	"guidance",
	"notifications",
	"activation-source",
	"activation-apps",
	"activation-value",
	"activation-offer",
	"activation-task",
	"finishing",
	"done",
] as const;

const desktopOnboardingPhaseSchema = z.enum(DESKTOP_ONBOARDING_PHASES);

export type DesktopOnboardingPhase = (typeof DESKTOP_ONBOARDING_PHASES)[number];

const NON_RESUMABLE_PHASES = new Set<DesktopOnboardingPhase>([
	"installing",
	"finishing",
	"done",
]);

/** Legacy marker used by releases before node onboarding was introduced. */
const LEGACY_DESKTOP_ONBOARDING_COMPLETE_KEY = "ryu_onboarding_complete";

function migrateStoredPhase(stored: string | null): string | null {
	if (stored === "welcome") {
		return "guidance";
	}
	if (stored === "starting") {
		return "intro";
	}
	return stored;
}

/** The step after the welcome intro: update check (native shell) or setup fork (browser). */
export function phaseAfterIntro(tauriReady: boolean): DesktopOnboardingPhase {
	return tauriReady ? "updates" : "choose";
}

/** Load the last durable Desktop onboarding step from this installation. */
export function getDesktopOnboardingPhase(): DesktopOnboardingPhase | null {
	try {
		const storedPhase = localStorage.getItem(DESKTOP_ONBOARDING_PHASE_KEY);
		// The former welcome step is now the guided setup summary, and the former
		// auto-advancing "starting" step is now the welcome intro.
		const phase = migrateStoredPhase(storedPhase);
		const parsed = desktopOnboardingPhaseSchema.safeParse(phase);
		if (parsed.success && !NON_RESUMABLE_PHASES.has(parsed.data)) {
			return parsed.data;
		}
	} catch {
		return null;
	}
	return null;
}

/** Resume an unfinished flow before applying the normal first-run defaults. */
export function resolveDesktopOnboardingPhase({
	desktopPending,
	nodePending,
}: {
	desktopPending: boolean;
	nodePending: boolean;
}): DesktopOnboardingPhase {
	const savedPhase = getDesktopOnboardingPhase();
	if (savedPhase) {
		return savedPhase;
	}
	if (nodePending && !desktopPending) {
		return "node-setup";
	}
	if (!nodePending && desktopPending) {
		return "guidance";
	}
	// A fresh flow opens on the welcome intro; it hands off to the update check
	// (native shell) or the setup fork (browser).
	return "intro";
}

/** Persist resumable steps; transitional work can safely return to its prior step. */
export function persistDesktopOnboardingPhase(
	phase: DesktopOnboardingPhase
): void {
	if (NON_RESUMABLE_PHASES.has(phase)) {
		return;
	}
	try {
		if (localStorage.getItem(DESKTOP_ONBOARDING_PHASE_KEY) !== phase) {
			localStorage.setItem(DESKTOP_ONBOARDING_PHASE_KEY, phase);
		}
	} catch {
		// The flow remains usable when local storage is unavailable.
	}
}

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
		localStorage.removeItem(DESKTOP_ONBOARDING_PHASE_KEY);
	} catch {
		// The route still completes when storage is unavailable; the next launch
		// will safely show onboarding again rather than pretending it persisted.
	}
}

export function resetDesktopOnboarding(): void {
	try {
		localStorage.removeItem(DESKTOP_ONBOARDING_COMPLETE_KEY);
		localStorage.removeItem(LEGACY_DESKTOP_ONBOARDING_COMPLETE_KEY);
		localStorage.removeItem(DESKTOP_ONBOARDING_PHASE_KEY);
		localStorage.removeItem(DESKTOP_ONBOARDING_PROJECT_KEY);
	} catch {
		// Storage can be unavailable in a locked-down webview.
	}
}

/** Last-known "this node needs no setup" per node URL, so a returning user gets
 *  the app shell on the first frame instead of waiting on `/api/onboarding/state`.
 *  Only a positive answer is cached; an unknown or incomplete node still waits. */
const NODE_SETUP_COMPLETE_PREFIX = "ryu_node_setup_complete:";

export function rememberNodeSetupComplete(
	nodeUrl: string,
	complete: boolean
): void {
	try {
		const key = `${NODE_SETUP_COMPLETE_PREFIX}${nodeUrl}`;
		if (complete) {
			localStorage.setItem(key, "true");
		} else {
			localStorage.removeItem(key);
		}
	} catch {
		// Without storage the next launch simply waits for the live answer.
	}
}

export function wasNodeSetupComplete(nodeUrl: string): boolean {
	try {
		return (
			localStorage.getItem(`${NODE_SETUP_COMPLETE_PREFIX}${nodeUrl}`) === "true"
		);
	} catch {
		return false;
	}
}
