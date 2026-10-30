/* @jsxImportSource @opentui/react */
// The shell's chrome around the workspace: layout persistence, the hidden
// sidebar's rail and the bottom status bar. Split out of App.tsx.

import type { Renderable } from "@opentui/core";
import { type ReactNode, useRef, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { DEFAULT_HINT_PRIORITY, globalHints } from "./core/keymap.ts";
import type { ProductMode } from "./core/productMode.ts";
import { SIDEBAR_ROOT_ID } from "./sidebar/Sidebar.tsx";
import { useSelectionSafeActivate } from "./ui/clipboard.ts";
import { type KeyHint, StatusBar } from "./ui/StatusBar.tsx";
import { useActiveStatus } from "./ui/StatusContext.tsx";
import { useToast } from "./ui/toast.tsx";
import { WorkspaceProvider } from "./workspace/WorkspaceContext.tsx";
import { fileWorkbenchPersistence } from "./workspace/workbenchPersistence.ts";

// Global hints come from GLOBAL_KEYMAP (core/keymap.ts). Priorities decide what
// survives a narrow terminal (lower is kept first): the palette and quit always
// stay; the focused surface's hints rank right after them.
/** Surface hints rank after palette, quit and F1 (0, 1, 1.2) and ahead of the
 * other globals (2+); a surface's own priorities only order its hints within
 * this band. */
const SURFACE_HINT_PRIORITY = 1.5;
const SURFACE_HINT_SPREAD = 1000;
/** The node/mode text shows in full once palette, quit and the surface's hints
 * fit, ahead of the secondary globals (^T, ^W, ^N, ^⇧M, F1) - those stay one ^K away. */
const LEFT_STATUS_PRIORITY = 1.9;

/** The workspace, with its layout saved to the Ryu home directory when the
 *  entry point asks for it. A failed save is reported once and the session
 *  keeps running from memory. Embedded and test renders stay in memory. */
export function PersistentWorkspaceProvider({
	children,
	persist,
}: {
	children: ReactNode;
	persist: boolean;
}) {
	const { notify } = useToast();
	const notifyRef = useRef(notify);
	notifyRef.current = notify;
	const [persistence] = useState(() =>
		persist
			? fileWorkbenchPersistence({
					onError: (message) => notifyRef.current(message, "error"),
				})
			: undefined
	);
	return (
		<WorkspaceProvider persistence={persistence}>{children}</WorkspaceProvider>
	);
}

/** Whether a mouse target sits inside the sidebar's root box. */
export function isInsideSidebar(target: Renderable | null): boolean {
	for (let node = target; node; node = node.parent) {
		if (node.id === SIDEBAR_ROOT_ID) {
			return true;
		}
	}
	return false;
}

/** The one-column rail a hidden sidebar leaves behind; a click shows it again
 * (herdr's collapsed sidebar). */
export function SidebarRail({ onShow }: { onShow: () => void }) {
	const theme = useTheme();
	const activate = useSelectionSafeActivate();
	// A tinted strip reads as a collapsed panel edge rather than a prompt marker
	// beside the pane's first line; the whole strip is the click target.
	return (
		<box
			backgroundColor={theme.colors.muted}
			flexDirection="column"
			flexShrink={0}
			paddingTop={1}
			width={1}
			{...activate(onShow)}
		>
			<text fg={theme.colors.mutedForeground} selectable={false}>
				›
			</text>
		</box>
	);
}

/** The shell's bottom bar: global hints merged with the focused surface's
 * contribution. Its own component so a surface publishing hints or the busy
 * clock re-renders only the bar, not the whole shell. */
export function ShellStatusBar({
	left,
	leftSuffix,
	mode,
}: {
	left: string;
	/** The focused region, kept visible when the left text is trimmed. */
	leftSuffix?: string;
	mode: ProductMode;
}) {
	const status = useActiveStatus();
	const globals: KeyHint[] = globalHints(mode);
	const surfaceHints = (status?.hints ?? []).map((hint) => ({
		...hint,
		priority:
			SURFACE_HINT_PRIORITY +
			(hint.priority ?? DEFAULT_HINT_PRIORITY) / SURFACE_HINT_SPREAD,
	}));
	return (
		<StatusBar
			busy={status?.busy}
			hints={[...surfaceHints, ...globals]}
			left={status?.left ?? left}
			leftPriority={LEFT_STATUS_PRIORITY}
			leftSuffix={leftSuffix}
		/>
	);
}
