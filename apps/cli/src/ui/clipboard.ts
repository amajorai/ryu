// Copy-on-select: when a mouse drag over selectable text finishes, OpenTUI emits
// the renderer's "selection" event. We write the selected text to the host
// clipboard with OSC 52 and confirm with a short toast. The highlight is left
// in place (as opencode does) so the user can still see what was copied; the
// next click or keypress clears it.
//
// Clickable chrome (the sidebar) activates through useSelectionSafeActivate so
// that a click made while a selection is showing only clears the highlight
// (OpenTUI clears it on mouse-down), and a drag released over a row never
// navigates.

import type { MouseEvent, Selection } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { useCallback, useEffect } from "react";
import type { StatusVariant } from "@/components/ui/status-message.tsx";
import { type NotifyOptions, useToast } from "./toast.tsx";

/** Lifetime of the "copied" flash; shorter than the default success toast. */
export const COPY_TOAST_TTL_MS = 2000;
export const COPIED_MESSAGE = "Copied to clipboard";
export const CLIPBOARD_UNAVAILABLE_MESSAGE =
	"Clipboard unavailable in this terminal (OSC 52)";

/** The slice of OpenTUI's Selection the copy path reads. */
export interface SelectedTextSource {
	getSelectedText(): string;
}

/** The slice of OpenTUI's CliRenderer the copy path writes through. */
export interface ClipboardWriter {
	copyToClipboardOSC52(text: string): boolean;
}

export type CopyNotify = (
	message: string,
	variant?: StatusVariant,
	options?: NotifyOptions
) => void;

export type CopyOutcome = "copied" | "empty" | "unavailable";

/**
 * Copies a finished selection to the clipboard and reports it. A plain click
 * leaves an empty (or whitespace-only) selection, which is ignored silently.
 */
export function copySelectionToClipboard(
	renderer: ClipboardWriter,
	selection: SelectedTextSource | null | undefined,
	notify: CopyNotify
): CopyOutcome {
	const text = selection?.getSelectedText() ?? "";
	if (text.trim() === "") {
		return "empty";
	}
	if (renderer.copyToClipboardOSC52(text)) {
		notify(COPIED_MESSAGE, "success", { ttlMs: COPY_TOAST_TTL_MS });
		return "copied";
	}
	notify(CLIPBOARD_UNAVAILABLE_MESSAGE, "warning");
	return "unavailable";
}

/**
 * Subscribes to the renderer's finished-selection event and copies each
 * non-empty selection. Any keypress except Ctrl+C clears a lingering highlight
 * without consuming the key; Ctrl+C is left to the shell, which copies the
 * highlight again and then clears it. Mount once inside ToastProvider (WorkspaceShell does).
 */
export function useCopyOnSelect(): void {
	const renderer = useRenderer();
	const { notify } = useToast();
	useEffect(() => {
		const onSelection = (selection: Selection | null) => {
			copySelectionToClipboard(renderer, selection, notify);
		};
		renderer.on("selection", onSelection);
		return () => {
			renderer.off("selection", onSelection);
		};
	}, [renderer, notify]);
	useKeyboard((key) => {
		// Ctrl+C copies the highlight first; the shell's handler clears it after.
		if (key.ctrl && key.name === "c") {
			return;
		}
		if (renderer.getSelection()) {
			renderer.clearSelection();
		}
	});
}

/** The slice of OpenTUI's CliRenderer the activation guard reads. */
export interface SelectionHost {
	getSelection(): SelectedTextSource | null;
}

/** The slice of an OpenTUI mouse event the activation guard inspects. */
export interface PointerEvent {
	isDragging?: boolean;
	target: {
		height: number;
		screenX: number;
		screenY: number;
		width: number;
	} | null;
	x: number;
	y: number;
}

/** What a mouse-down on clickable chrome recorded for the matching release. */
export interface PressRecord {
	/** Highlighted text was showing; this click only dismisses it. */
	dismissesSelection: boolean;
	target: PointerEvent["target"];
}

/**
 * Records a press. It runs before OpenTUI clears the old selection on
 * mouse-down, so it still sees the highlight the click is about to dismiss.
 */
export function recordPress(
	renderer: SelectionHost,
	event: PointerEvent
): PressRecord {
	return {
		dismissesSelection: Boolean(renderer.getSelection()?.getSelectedText()),
		target: event.target,
	};
}

function releasedInside({ target, x, y }: PointerEvent): boolean {
	if (!target) {
		return true;
	}
	return (
		x >= target.screenX &&
		y >= target.screenY &&
		x < target.screenX + target.width &&
		y < target.screenY + target.height
	);
}

/**
 * Whether a release should activate: it must finish a press on the same target
 * made while no text was highlighted, must not end a drag-select (left to
 * copy-on-select), and must land inside the target (dragging off cancels).
 */
export function shouldActivate(
	press: PressRecord | null,
	release: PointerEvent
): boolean {
	return (
		press !== null &&
		!press.dismissesSelection &&
		!release.isDragging &&
		press.target === release.target &&
		releasedInside(release)
	);
}

export interface ActivateHandlers {
	onMouseDown: (event: MouseEvent) => void;
	onMouseUp: (event: MouseEvent) => void;
}

// One pointer, so one pending press: a press on a target always reaches that
// target's release handler (OpenTUI captures the drag), which consumes it.
let pendingPress: PressRecord | null = null;

/**
 * Click handlers for chrome that must respect an active selection; spread the
 * result onto the element. A click while text is highlighted only clears the
 * highlight, and a drag released over the element never activates it. Pair it
 * with `selectable={false}` on the element's text so a press there does not
 * start a new selection (which would clear the old one before we see it).
 */
export function useSelectionSafeActivate(): (
	action: () => void
) => ActivateHandlers {
	const renderer = useRenderer();
	return useCallback(
		(action: () => void) => ({
			onMouseDown: (event: MouseEvent) => {
				pendingPress = recordPress(renderer, event);
			},
			onMouseUp: (event: MouseEvent) => {
				const press = pendingPress;
				pendingPress = null;
				if (shouldActivate(press, event)) {
					action();
				}
			},
		}),
		[renderer]
	);
}
