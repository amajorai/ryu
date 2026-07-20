"use client";

// The shared chrome for the expanded island panel: a status header with the
// Inbox tab, an optional "Done" affordance, and the close button. The chat /
// inbox views render inside this shell.
//
// The `ExpandedView` union still carries `marketplace` + `settings` because the
// storyboard (apps/storyboard) documents those panel bodies; the live island no
// longer offers them as tabs (Store + Settings moved to the desktop app), so
// they are absent from `TABS` below but remain valid view values.
//
// Presentational only: the live ExpandedPanel supplies the active view + the tab
// and close handlers; standalone it renders the header with no-op actions.

import { Button } from "@ryu/ui/components/button";
import type { ReactNode } from "react";

export type ExpandedView = "chat" | "inbox" | "marketplace" | "settings";

export interface ExpandedPanelShellProps {
	children?: ReactNode;
	onClose?: () => void;
	onHome?: () => void;
	onSelect?: (view: ExpandedView) => void;
	view?: ExpandedView;
}

const TABS: ReadonlyArray<{ label: string; target: ExpandedView }> = [
	{ target: "inbox", label: "Inbox" },
];

const noop = (): void => {
	// Static-render default; the live panel injects the real navigation.
};

export function ExpandedPanelShell({
	view = "chat",
	children,
	onHome,
	onSelect = noop,
	onClose = noop,
}: ExpandedPanelShellProps) {
	return (
		<div className="flex h-full w-full flex-col gap-3 overflow-y-auto p-1">
			<header className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<span className="size-2 rounded-full bg-emerald-400" />
					<h1 className="font-semibold text-neutral-100 text-sm">Ryu Island</h1>
				</div>
				<div className="flex items-center gap-1.5">
					{onHome ? (
						<Button
							className="bg-white/10 text-neutral-200 hover:bg-white/20"
							onClick={onHome}
							size="xs"
							variant="ghost"
						>
							Home
						</Button>
					) : null}
					{TABS.map((tab) => (
						<Button
							className={
								view === tab.target
									? "bg-white/20 text-neutral-100 hover:bg-white/20"
									: "bg-white/10 text-neutral-200 hover:bg-white/20"
							}
							key={tab.target}
							onClick={() => onSelect(tab.target)}
							size="xs"
							variant="ghost"
						>
							{tab.label}
						</Button>
					))}
					{view === "chat" ? null : (
						<Button
							className="bg-white/10 text-neutral-200 hover:bg-white/20"
							onClick={() => onSelect("chat")}
							size="xs"
							variant="ghost"
						>
							Done
						</Button>
					)}
					<Button
						aria-label="Close panel"
						className="bg-white/10 text-neutral-200 hover:bg-white/20"
						onClick={onClose}
						size="icon-xs"
						variant="ghost"
					>
						✕
					</Button>
				</div>
			</header>
			{children}
		</div>
	);
}
