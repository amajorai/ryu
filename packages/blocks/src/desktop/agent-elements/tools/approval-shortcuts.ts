import { type Chord, chordMatches } from "@ryu/hotkeys/chord";
import { useOptionalHotkeyBinding } from "@ryu/hotkeys/react";
import { type KeyboardEvent as ReactKeyboardEvent, useCallback } from "react";

/** Registry ids for the contextual approval actions. */
export const APPROVAL_ACCEPT_HOTKEY_ID = "approval.accept";
export const APPROVAL_DECLINE_HOTKEY_ID = "approval.decline";

interface ApprovalShortcutOptions {
	enabled?: boolean;
	onAccept?: () => void;
	onDecline?: () => void;
}

export interface ApprovalShortcutProps {
	/** Effective bindings, rendered in the DOM for assistive technology and tests. */
	ariaKeyshortcuts?: string;
	hasShortcut: boolean;
	onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
	tabIndex?: 0;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
	return (
		globalThis.Element !== undefined &&
		target instanceof Element &&
		Boolean(
			target.closest(
				"button, a, input, textarea, select, [contenteditable='true'], [role='button']"
			)
		)
	);
}

function shortcutLabel(bindings: (Chord | null)[]): string | undefined {
	const value = bindings.filter((binding): binding is Chord =>
		Boolean(binding)
	);
	return value.length > 0 ? value.join(" ") : undefined;
}

/**
 * Match the configured approval actions only inside the card that owns this
 * handler. This keeps several pending tool rows from competing for one global
 * hotkey registration.
 */
export function useApprovalShortcuts({
	enabled = true,
	onAccept,
	onDecline,
}: ApprovalShortcutOptions): ApprovalShortcutProps {
	const acceptBinding = useOptionalHotkeyBinding(APPROVAL_ACCEPT_HOTKEY_ID);
	const declineBinding = useOptionalHotkeyBinding(APPROVAL_DECLINE_HOTKEY_ID);
	const canAccept = enabled && Boolean(onAccept && acceptBinding);
	const canDecline = enabled && Boolean(onDecline && declineBinding);

	const onKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLElement>) => {
			if (
				event.defaultPrevented ||
				event.nativeEvent.isComposing ||
				event.nativeEvent.repeat
			) {
				return;
			}

			if (
				canAccept &&
				acceptBinding &&
				chordMatches(acceptBinding, event.nativeEvent) &&
				!isInteractiveTarget(event.target)
			) {
				event.preventDefault();
				event.stopPropagation();
				onAccept?.();
				return;
			}

			if (
				canDecline &&
				declineBinding &&
				chordMatches(declineBinding, event.nativeEvent)
			) {
				event.preventDefault();
				event.stopPropagation();
				onDecline?.();
			}
		},
		[acceptBinding, canAccept, canDecline, declineBinding, onAccept, onDecline]
	);

	const hasShortcut = canAccept || canDecline;

	return {
		ariaKeyshortcuts: shortcutLabel([
			canAccept ? acceptBinding : null,
			canDecline ? declineBinding : null,
		]),
		hasShortcut,
		onKeyDown,
		tabIndex: hasShortcut ? 0 : undefined,
	};
}
