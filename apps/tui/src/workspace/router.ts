// THE SURFACE ROUTER - the single registration point mapping a path string to a
// Surface module (the desktop Layout.tsx `renderTabContent` analog). A surface is
// one self-contained screen (Chat, Agents, ...); the shell renders the surface
// whose `match(path)` predicate accepts the active tab's path.
//
// ── SURFACE CONTRACT ────────────────────────────────────────────────────────
// A surface builder creates src/surfaces/<name>/index.tsx exporting a
// SurfaceModule and DOES NOT edit this file. The Integrate step imports the module
// here and calls registerSurface(module) once. Nothing else in this file changes.
//
//   import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
//   export const agentsSurface: SurfaceModule = {
//     id: "agents",
//     title: "Agents",
//     match: (path) => path === "/agents" || path.startsWith("/agents/"),
//     Component: AgentsSurface,
//   };
//
// Then Integrate adds to this file:
//   import { agentsSurface } from "../surfaces/agents/index.tsx";
//   registerSurface(agentsSurface);
//
// A surface reads the active Core node via useCore() and navigates via
// useWorkspace().openTab. It gates its keyboard on `active` AND being in the
// focused pane (useWorkspace().focusedPaneId === paneId). See SurfaceProps.

import type { ReactNode } from "react";
import { agentsSurface } from "../surfaces/agents/index.tsx";
import { calendarSurface } from "../surfaces/calendar/index.tsx";
import { chatSurface } from "../surfaces/chat/index.tsx";
import { homeSurface } from "../surfaces/home/index.tsx";
import { librarySurface } from "../surfaces/library/index.tsx";
import { meetingsSurface } from "../surfaces/meetings/index.tsx";
import { monitorsSurface } from "../surfaces/monitors/index.tsx";
import { spacesSurface } from "../surfaces/spaces/index.tsx";
import {
	storeEnginesSurface,
	storeFinetuneSurface,
	storeModelsSurface,
	storeSkillsSurface,
	storeSurface,
} from "../surfaces/store/index.tsx";
import { tasksSurface } from "../surfaces/tasks/index.tsx";
import { timelineSurface } from "../surfaces/timeline/index.tsx";
import { toolsSurface } from "../surfaces/tools/index.tsx";
import { workflowsSurface } from "../surfaces/workflows/index.tsx";

export interface SurfaceProps {
	/** True while this surface is the visible/active tab in ITS pane. A surface is
	 * mounted for the active tab of each pane, so with a split open two surfaces
	 * can be active at once - gate keyboard on `active && focused pane`. */
	active: boolean;
	/** The id of the pane this surface instance is rendered in. Compare against
	 * useWorkspace().focusedPaneId to know if this pane owns the keyboard. */
	paneId: string;
}

export interface SurfaceModule {
	/** React component. Typed as a plain function (not ComponentType) so it
	 * satisfies OpenTUI's JSX element constraint under React 19's ReactNode. */
	Component: (props: SurfaceProps) => ReactNode;
	/** Optional single-char glyph shown in the tab strip / palette. */
	icon?: string;
	/** Stable id, e.g. "chat", "agents". */
	id: string;
	/** Predicate deciding whether this surface owns a path. Supports exact and
	 * prefix matches (e.g. path.startsWith("/store")). */
	match: (path: string) => boolean;
	/** Human label used by the palette + default tab title. */
	title: string;
}

const registry: SurfaceModule[] = [];

/** Register a surface module. Idempotent by id (a duplicate id is ignored), so a
 * double import during hot paths / tests cannot register twice. */
export function registerSurface(module: SurfaceModule): void {
	if (!registry.some((existing) => existing.id === module.id)) {
		registry.push(module);
	}
}

/** Resolve the surface that owns a path, or undefined when none match. */
export function resolveSurface(path: string): SurfaceModule | undefined {
	return registry.find((module) => module.match(path));
}

/** All registered surfaces, in registration order (read-only). Used by the
 * command palette to derive navigation destinations. */
export function listSurfaces(): readonly SurfaceModule[] {
	return registry;
}

// Register every surface in desktop information-architecture order. Chat is the
// default home surface; the rest mirror the desktop NAV_ITEMS + Store sections.
registerSurface(homeSurface);
registerSurface(chatSurface);
registerSurface(agentsSurface);
registerSurface(storeSurface);
registerSurface(storeModelsSurface);
registerSurface(storeSkillsSurface);
registerSurface(storeEnginesSurface);
registerSurface(storeFinetuneSurface);
registerSurface(librarySurface);
registerSurface(spacesSurface);
registerSurface(toolsSurface);
registerSurface(workflowsSurface);
registerSurface(calendarSurface);
registerSurface(timelineSurface);
registerSurface(monitorsSurface);
registerSurface(tasksSurface);
registerSurface(meetingsSurface);
