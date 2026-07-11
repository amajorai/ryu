// Overlay registry - modal centered panels with their own inset nav (the desktop
// Settings/Gateway dialog analog). An overlay is a full-screen-ish modal body
// keyed by a stable id. The OverlayHost renders the open overlay's body.
//
// ── OVERLAY CONTRACT ────────────────────────────────────────────────────────
// A builder fills src/overlays/<id>/* exporting an OverlayModule and DOES NOT
// edit the OverlayHost. The Integrate step swaps the skeleton registration for
// the real body:
//
//   import type { OverlayModule } from "../overlays/registry.ts";
//   export const settingsOverlay: OverlayModule = {
//     id: "settings",
//     title: "Settings",
//     Body: SettingsBody,   // (props: OverlayBodyProps) => ReactNode
//   };
//   // in the Integrate step:
//   registerOverlay(settingsOverlay);
//
// A body reads the node via useCore(), navigates via useWorkspace().openTab, and
// closes itself via props.close (or the host's Esc handling).

import type { ReactNode } from "react";

export interface OverlayBodyProps {
	/** Close this overlay. */
	close: () => void;
	/** The overlay id (handy when one body serves several ids). */
	id: string;
}

export interface OverlayModule {
	/** The modal body. Typed as a plain function for the OpenTUI JSX constraint. */
	Body: (props: OverlayBodyProps) => ReactNode;
	/** Stable id used with openOverlay(id), e.g. "settings", "gateway". */
	id: string;
	/** Header title rendered by the host chrome. */
	title: string;
}

const registry = new Map<string, OverlayModule>();

/** Register (or replace) an overlay body by id. Integrate calls this to swap a
 * skeleton for the real body. */
export function registerOverlay(module: OverlayModule): void {
	registry.set(module.id, module);
}

/** Look up an overlay module by id. */
export function resolveOverlay(id: string): OverlayModule | undefined {
	return registry.get(id);
}

// Skeleton bodies for the two foundation-owned overlay ids. The Settings and
// Gateway builders re-register these ids (registerOverlay) with the real bodies
// from src/overlays/settings/* and src/overlays/gateway/*; until then the host
// shows a titled placeholder so openOverlay("settings"|"gateway") always works.
function makeSkeleton(id: string, note: string): OverlayModule {
	return {
		id,
		title: note,
		Body: () => null,
	};
}

registerOverlay(makeSkeleton("settings", "Settings"));
registerOverlay(makeSkeleton("gateway", "Gateway"));
