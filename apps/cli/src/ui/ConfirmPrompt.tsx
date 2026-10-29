/* @jsxImportSource @opentui/react */
// ConfirmPrompt: an inline confirmation for destructive store and service
// actions (uninstall, cascade, start/stop all). It renders a bordered box with
// the title, the consequence in the warning tone, and a `[ Cancel ] [ <Action> ]`
// button pair. Cancel is focused by default, so a stray Enter is safe, and the
// destructive label is drawn in the error tone.
//
// Keys (only while `active`): y confirms; n and Esc cancel; Enter runs the
// focused button; Tab, ←/→ or h/l move focus between the buttons. Ctrl/Alt
// chords are left to the shell.
//
// OpenTUI delivers every key to every mounted useKeyboard handler, so the host
// tab must ignore its own keys while the prompt is open. Otherwise y, n or r
// would also trigger tab actions. A surface that hosts such a tab and owns plain
// keys of its own (the Store's ←/→ sections and / search) provides
// ConfirmClaimContext and yields those keys while a prompt is mounted. The
// prompt is self-contained and renders inline, so it can later be dropped into a
// Modal unchanged.
//
// Layout: the title and the key hint each stay on one line (truncated when the
// pane is narrow) and the buttons never wrap; only the consequence wraps. Hosts
// show the prompt in place of their own key-hint footer so it fits short panes.

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { createContext, useContext, useEffect, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";

/** Lets a hosting surface know a ConfirmPrompt is open below it, so it can
 *  leave the keys the prompt uses (←/→ in particular) alone. */
export const ConfirmClaimContext = createContext<
	((open: boolean) => void) | null
>(null);

export interface ConfirmPromptProps {
	/** Whether the prompt owns the keyboard (the host tab is focused). */
	active: boolean;
	/** Label for the safe choice; defaults to "Cancel". */
	cancelLabel?: string;
	/** Label for the destructive choice, e.g. "Uninstall". */
	confirmLabel: string;
	/** What will happen if the action runs, shown in the warning tone. */
	consequence: string;
	onCancel: () => void;
	onConfirm: () => void;
	/** One-line question, e.g. "Uninstall Browser?". */
	title: string;
}

type ConfirmFocus = "cancel" | "confirm";

const SWITCH_KEYS = new Set(["tab", "left", "right", "h", "l"]);

/** Decide what a key does in the prompt. Exported for unit tests. */
export function confirmKeyAction(
	key: Pick<KeyEvent, "ctrl" | "meta" | "name" | "option">,
	focus: ConfirmFocus
): "cancel" | "confirm" | "switch" | null {
	if (key.ctrl || key.meta || key.option) {
		return null;
	}
	if (key.name === "y") {
		return "confirm";
	}
	if (key.name === "n" || key.name === "escape") {
		return "cancel";
	}
	if (key.name === "return" || key.name === "enter") {
		return focus;
	}
	if (SWITCH_KEYS.has(key.name)) {
		return "switch";
	}
	return null;
}

export function ConfirmPrompt({
	active,
	cancelLabel = "Cancel",
	confirmLabel,
	consequence,
	onCancel,
	onConfirm,
	title,
}: ConfirmPromptProps) {
	const theme = useTheme();
	const [focus, setFocus] = useState<ConfirmFocus>("cancel");
	const claim = useContext(ConfirmClaimContext);

	useEffect(() => {
		claim?.(true);
		return () => claim?.(false);
	}, [claim]);

	useKeyboard((key) => {
		if (!active) {
			return;
		}
		const action = confirmKeyAction(key, focus);
		if (action === "confirm") {
			onConfirm();
		} else if (action === "cancel") {
			onCancel();
		} else if (action === "switch") {
			setFocus((current) => (current === "cancel" ? "confirm" : "cancel"));
		}
	});

	const cancelFocused = focus === "cancel";
	return (
		<box
			border
			borderColor={theme.colors.error}
			borderStyle="rounded"
			flexDirection="column"
			flexShrink={0}
			// Hosts pad only their left edge; keep the border off the pane's last
			// column like the Store search box above it.
			marginRight={1}
			paddingLeft={1}
			paddingRight={1}
		>
			<text fg={theme.colors.foreground} truncate wrapMode="none">
				<b>{title}</b>
			</text>
			<text fg={theme.colors.warning}>{consequence}</text>
			<box flexDirection="row" flexShrink={0} gap={1}>
				<text
					bg={cancelFocused ? theme.colors.selection : undefined}
					fg={
						cancelFocused
							? theme.colors.selectionForeground
							: theme.colors.foreground
					}
					flexShrink={0}
					wrapMode="none"
				>
					{`[ ${cancelLabel} ]`}
				</text>
				<text
					bg={cancelFocused ? undefined : theme.colors.error}
					fg={cancelFocused ? theme.colors.error : theme.colors.errorForeground}
					flexShrink={0}
					wrapMode="none"
				>
					{`[ ${confirmLabel} ]`}
				</text>
				<text
					fg={theme.colors.mutedForeground}
					flexShrink={1}
					truncate
					wrapMode="none"
				>
					y confirm · n/Esc cancel · Tab switch
				</text>
			</box>
		</box>
	);
}
