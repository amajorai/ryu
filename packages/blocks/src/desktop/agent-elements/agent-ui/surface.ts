// The live generative-UI surface: which `ui.render` screen a host that shows ONE
// screen at a time (the Island) should display for a conversation.
//
// The desktop transcript keeps every `ui.render` as an inline card in history.
// A surface host instead treats the agent's UI as a single screen that is
// generated when you ask, reshapes as you talk, and disappears when the
// conversation moves on:
//
// - **Generated**: the latest completed `ui.render` in the current turn is the screen.
// - **Reshapes**: while a follow-up turn is in flight, the previous screen stays up
//   (marked `updating`) until the new turn renders its replacement.
// - **Disappears**: a finished turn that rendered no UI clears the screen.
//
// Pure and runtime-free so the rules are unit-testable without a chat runtime.

import type { ChatStatus, UIMessage } from "ai";
import { z } from "zod";

export type AgentUiSurfaceFormat = "json-render" | "a2ui";

export interface AgentUiSurface {
	format?: AgentUiSurfaceFormat;
	/** Stable per render call; keys the surface's enter/exit animation. */
	id: string;
	/** The raw spec from the message part. */
	spec: unknown;
	title?: string;
}

export interface LiveAgentUiSurface {
	surface: AgentUiSurface | null;
	/** A follow-up turn is running and has not rendered its replacement yet. */
	updating: boolean;
}

const NO_SURFACE: LiveAgentUiSurface = { surface: null, updating: false };

/**
 * Content identity for a surface. The chat runtime re-snapshots message parts on
 * every stream update, so object identity is not stable; two renders of the same
 * screen (a tool row and its turn-end card) share one key.
 */
export function agentUiSurfaceKey(surface: AgentUiSurface): string {
	try {
		return JSON.stringify([surface.format ?? "json-render", surface.spec]);
	} catch {
		return surface.id;
	}
}

const uiRenderPartSchema = z.looseObject({
	type: z.string(),
	toolName: z.string().optional(),
	toolCallId: z.string().optional(),
	state: z.string().optional(),
	input: z
		.looseObject({
			format: z.enum(["json-render", "a2ui"]).optional(),
			spec: z.unknown(),
			title: z.string().optional(),
		})
		.optional(),
});

function isUiRenderType(type: string, toolName: string | undefined): boolean {
	return (
		type === "tool-ui.render" ||
		(type === "dynamic-tool" && toolName === "ui.render")
	);
}

/**
 * The `ui.render` call in `part`, once its input has fully arrived. A spec that
 * is still streaming is skipped: the pinned json-render renderer is not hardened
 * for partial props (see the tool renderer), and Core's echo completes it fast.
 */
export function agentUiSurfaceFromPart(
	part: unknown,
	fallbackId: string
): AgentUiSurface | null {
	const parsed = uiRenderPartSchema.safeParse(part);
	if (!parsed.success) {
		return null;
	}
	const { input, state, toolCallId, toolName, type } = parsed.data;
	if (!isUiRenderType(type, toolName) || state === "input-streaming") {
		return null;
	}
	if (input?.spec == null) {
		return null;
	}
	return {
		format: input.format,
		id: toolCallId ?? fallbackId,
		spec: input.spec,
		title: input.title,
	};
}

function lastSurfaceIn(message: UIMessage): AgentUiSurface | null {
	for (let index = message.parts.length - 1; index >= 0; index -= 1) {
		const surface = agentUiSurfaceFromPart(
			message.parts[index],
			`${message.id}-ui-${index}`
		);
		if (surface) {
			return surface;
		}
	}
	return null;
}

function lastSurfaceBefore(
	messages: readonly UIMessage[],
	end: number
): AgentUiSurface | null {
	for (let index = end - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") {
			continue;
		}
		const surface = lastSurfaceIn(message);
		if (surface) {
			return surface;
		}
	}
	return null;
}

/** The screen a single-surface host shows for `messages` at `status`. */
export function deriveLiveAgentUiSurface(
	messages: readonly UIMessage[],
	status: ChatStatus
): LiveAgentUiSurface {
	let lastUser = messages.length - 1;
	while (lastUser >= 0 && messages[lastUser]?.role !== "user") {
		lastUser -= 1;
	}
	const turnStart = lastUser + 1;
	for (let index = messages.length - 1; index >= turnStart; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") {
			continue;
		}
		const surface = lastSurfaceIn(message);
		if (surface) {
			return { surface, updating: false };
		}
	}
	// The current turn has rendered nothing (yet). While it runs — or if it
	// failed — keep the previous screen so a refinement reshapes it instead of
	// flashing it away; once the turn finishes without UI, the screen is gone.
	if (status === "ready") {
		return NO_SURFACE;
	}
	const previous = lastSurfaceBefore(messages, Math.max(lastUser, 0));
	if (!previous) {
		return NO_SURFACE;
	}
	return { surface: previous, updating: status !== "error" };
}

/**
 * What the user did to a single-surface host's screen. Dismissal is keyed by
 * render id, not content: closing a screen hides THAT `ui.render`, so a later
 * render of an identical spec (a new tool call) still appears.
 */
export interface AgentUiSurfaceSelection {
	/** {@link AgentUiSurface.id} of the render the user closed. */
	dismissedId: string | null;
	/** Id of the live render this selection was last reconciled with. */
	liveId: string | null;
	/** A screen brought back from the transcript; it wins until a new render. */
	reopened: AgentUiSurface | null;
}

export const EMPTY_AGENT_UI_SURFACE_SELECTION: AgentUiSurfaceSelection = {
	dismissedId: null,
	liveId: null,
	reopened: null,
};

/**
 * Reconcile with the live render: a new render supersedes a screen reopened from
 * history. Returns `selection` itself while the live render is unchanged, so a
 * host can compare by identity before storing it.
 */
export function reconcileAgentUiSurfaceSelection(
	selection: AgentUiSurfaceSelection,
	live: AgentUiSurface | null
): AgentUiSurfaceSelection {
	const liveId = live?.id ?? null;
	if (liveId === selection.liveId) {
		return selection;
	}
	return { ...selection, liveId, reopened: null };
}

/** Bring `surface` back on screen, clearing any dismissal. */
export function reopenAgentUiSurface(
	selection: AgentUiSurfaceSelection,
	surface: AgentUiSurface
): AgentUiSurfaceSelection {
	return { ...selection, dismissedId: null, reopened: surface };
}

/** Close the screen on display (`displayed`), hiding only that render. */
export function dismissAgentUiSurface(
	selection: AgentUiSurfaceSelection,
	displayed: AgentUiSurface | null
): AgentUiSurfaceSelection {
	return {
		...selection,
		dismissedId: displayed?.id ?? selection.dismissedId,
		reopened: null,
	};
}

/** The screen to draw: the reopened one, else the live one, unless closed. */
export function displayedAgentUiSurface(
	selection: AgentUiSurfaceSelection,
	live: AgentUiSurface | null
): AgentUiSurface | null {
	const candidate = selection.reopened ?? live;
	if (!candidate || candidate.id === selection.dismissedId) {
		return null;
	}
	return candidate;
}
