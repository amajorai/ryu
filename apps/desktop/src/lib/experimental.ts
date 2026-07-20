// Experimental feature flags for the desktop shell.
//
// These gate not-yet-stable surfaces behind a per-flag default, reusing the same
// localStorage + change-event pattern as `features.ts` (which toggles sidebar
// sections). Each is a boolean flag keyed by its own storage key. Most default
// ABSENT/OFF (must not run for a normal user until knowingly enabled); a small
// allowlist (`DEFAULT_ON_FLAGS`) graduates to ON-by-default once safe, still
// honoring an explicit persisted opt-out.
//
// The flagship flag is `ryu:experimental-plugin-runtime`: the entire third-party
// plugin / Ryu App WIDGET CODE-EXECUTION path (fetching bundled UI and mounting it
// in the sandboxed ExtensionHost / null-origin widget iframe). It is now DEFAULT-ON
// (see PLUGIN_RUNTIME_FLAG below for why it is safe + the CI cert dependency). With
// it OFF (explicit opt-out), the desktop never fetches or runs third-party code — a
// plugin companion renders only the benign data-driven summary (WF2's behavior) and
// a widget tool row degrades to plain tool output.

import { useEffect, useState } from "react";

/** localStorage key for the third-party plugin / Ryu App WIDGET runtime.
 *
 *  DEFAULT: now **ON** (see `DEFAULT_ON_FLAGS` below). Absent = ON; an explicit
 *  `"0"`/`"false"` (written by the Experimental settings toggle) is the persistent
 *  opt-OUT escape hatch.
 *
 *  Why it is now safe to default this ON — the two blockers the flag guarded are
 *  both closed this round:
 *    1. The DEFAULT `ryu` (Pi) agent can now actually TRIGGER a widget. Pi has no
 *       MCP bridge, so it previously reached zero widget-bearing tools; a managed-Pi
 *       proxy extension (`apps/core/assets/pi-extensions/ryu-mcp.ts`) + a Core
 *       widget-synthesis site now emit `ui_tool_widget` on the default agent's path.
 *    2. The widget CSP now renders real Apps-SDK-style apps with GOVERNED egress:
 *       `connect-src 'none'` stays (fetch routes through the Gateway) while remote
 *       image/font/media assets load only through the Core `/api/widgets/asset`
 *       proxy (SSRF-guarded, allowlisted, exec-audited) — so the moat holds.
 *
 *  The sandbox invariants this flag guards (CSP `connect-src 'none'` egress blocking
 *  + null-origin `window.parent.document` isolation) are certified by the
 *  `plugin-runtime-cert` job (`.github/workflows/plugin-runtime-e2e.yml`, running
 *  `e2e/plugin-runtime.spec.ts` in real Chromium). SHIPPING NOTE / cert dependency:
 *  that job MUST be a required, green status check in branch protection before this
 *  default-ON reaches release — it is the only thing that proves the boundary in a
 *  real browser (happy-dom/jsdom enforce neither CSP nor real origin isolation).
 *
 *  NOTE: the full path still needs a live smoke test — the build agents could not
 *  run the Pi agent headless, so Pi-triggered → SSE `ui_tool_widget` → rendered
 *  widget has been verified only unit-by-unit, not end-to-end in a running app. */
export const PLUGIN_RUNTIME_FLAG = "ryu:experimental-plugin-runtime";

/** Experimental flags whose ABSENT default is ON rather than OFF. Every other key
 *  passed to `isExperimentalEnabled` keeps the fail-safe default-OFF; only these
 *  graduate to on-by-default while still honoring an explicit persisted opt-out. */
const DEFAULT_ON_FLAGS = new Set<string>([PLUGIN_RUNTIME_FLAG]);

/** The absent/unreadable default for a flag: ON only for `DEFAULT_ON_FLAGS`. */
function defaultForFlag(key: string): boolean {
	return DEFAULT_ON_FLAGS.has(key);
}

/** Window event fired when any experimental flag changes, so mounted surfaces
 *  re-sync from storage within the same tab. */
export const EXPERIMENTAL_CHANGED_EVENT = "ryu:experimental-changed";

/** Read one experimental boolean flag fresh from storage. An absent, unrecognized,
 *  or unreadable value falls back to the flag's default (`defaultForFlag`): OFF for
 *  ordinary experimental keys, ON for `DEFAULT_ON_FLAGS`. An explicit `"0"`/`"false"`
 *  always wins, so a persisted opt-out survives even for a default-ON flag. */
export function isExperimentalEnabled(key: string): boolean {
	try {
		const raw = localStorage.getItem(key);
		if (raw === "1" || raw === "true") {
			return true;
		}
		if (raw === "0" || raw === "false") {
			return false;
		}
		// absent or unrecognized: use the flag's own default.
		return defaultForFlag(key);
	} catch {
		return defaultForFlag(key);
	}
}

/** Persist one experimental boolean flag and notify mounted surfaces to re-sync.
 *  For a `DEFAULT_ON_FLAGS` key, disabling writes an explicit `"0"` (the escape
 *  hatch) rather than removing the key — removal would silently re-enable it. */
export function setExperimentalEnabled(key: string, enabled: boolean): void {
	try {
		if (enabled) {
			localStorage.setItem(key, "1");
		} else if (defaultForFlag(key)) {
			// default-ON: an explicit opt-out must persist, not fall back to ON.
			localStorage.setItem(key, "0");
		} else {
			localStorage.removeItem(key);
		}
	} catch {
		// best-effort; still notify so in-memory state stays consistent
	}
	window.dispatchEvent(new CustomEvent(EXPERIMENTAL_CHANGED_EVENT));
}

/**
 * Subscribe to one experimental flag. Returns its current value plus a setter.
 * Stays in sync across surfaces via the change event (same tab) and the `storage`
 * event (other windows), mirroring `useFeatureToggles`.
 */
export function useExperimentalFlag(key: string): {
	enabled: boolean;
	setEnabled: (enabled: boolean) => void;
} {
	const [enabled, setEnabledState] = useState<boolean>(() =>
		isExperimentalEnabled(key)
	);

	useEffect(() => {
		const resync = () => setEnabledState(isExperimentalEnabled(key));
		window.addEventListener(EXPERIMENTAL_CHANGED_EVENT, resync);
		window.addEventListener("storage", resync);
		return () => {
			window.removeEventListener(EXPERIMENTAL_CHANGED_EVENT, resync);
			window.removeEventListener("storage", resync);
		};
	}, [key]);

	return {
		enabled,
		setEnabled: (next: boolean) => {
			setExperimentalEnabled(key, next);
			setEnabledState(isExperimentalEnabled(key));
		},
	};
}

/**
 * The flag-gate decision for loading a plugin's third-party UI. Pure so it is
 * testable without a DOM (the `flag_off_no_code` adversarial test asserts it):
 * third-party code loads ONLY when the runtime flag is ON AND the plugin actually
 * carries a UI bundle. With the flag OFF this is always `false`, so the caller
 * never fetches or mounts third-party code.
 */
export function shouldLoadThirdPartyUi(
	flagOn: boolean,
	hasUiBundle: boolean
): boolean {
	return flagOn && hasUiBundle;
}

/**
 * The flag-gate decision for rendering a Ryu App WIDGET (the streamed
 * `data-tool-widget-available` part). Shares the SAME `PLUGIN_RUNTIME_FLAG` as the
 * third-party plugin runtime: a widget runs the same null-origin sandboxed iframe
 * code path, so it stays behind the same operator opt-in until the browser
 * security certificate job is green. Pure so ChatPage can gate the widget host
 * context (withholding it when OFF, so the tool row degrades to a plain tool
 * output) without a DOM.
 */
export function shouldRenderWidget(flagOn: boolean): boolean {
	return flagOn;
}
