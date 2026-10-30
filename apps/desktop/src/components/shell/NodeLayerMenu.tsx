// apps/desktop/src/components/shell/NodeLayerMenu.tsx
//
// The presentational shell for one swappable "layer" of a node in the node
// selector dropdown: services (Core / Gateway / Shadow / Island), the resident
// Chat, the run-alongside engines (Audio / image / embeddings), the
// Audio, Voice Recognition, and Speech Processing engines, plus the sandbox
// backend.
//
// Every layer renders as the same submenu so the dropdown reads as one system:
//
//   ┌ trigger ─────────────────────────────┐
//   │ Chat               ● llama.cpp b9670 │──▸ ┌ submenu ──────────────┐
//   └──────────────────────────────────────┘    │ llama.cpp     b9670   │ header
//                                               │ Running · 2.1 GB      │
//                                               ├───────────────────────┤
//                                               │ ▶ Start / ■ Stop      │ actions
//                                               │ ⤓ Update              │
//                                               ├───────────────────────┤
//                                               │ INSTALLED             │
//                                               │ ✓ llama.cpp           │ swap
//                                               │   Ollama              │
//                                               ├───────────────────────┤
//                                               │ NOT INSTALLED         │
//                                               │ ⤓ vLLM                │ install
//                                               └───────────────────────┘
//
// This component is deliberately dumb — it owns layout, pending labels and the
// "don't close the menu while mutating" behaviour, nothing else. Each call site
// decides the SEMANTICS of its layer and passes only the slots that apply:
//
//   - services      → header + actions (start/stop, and update for Core/Gateway)
//   - Chat          → header + installed (swap) + available (install); NO
//                     start/stop, because the chat slot is swap-managed, not a
//                     sidecar toggle (see ENGINE_GROUPS in NodeSelector)
//   - run-alongside → header + actions (start/stop) + uninstall; these engines
//                     are NOT mutually exclusive, so they get no swap list
//   - Audio/Voice Recognition/Speech Processing → header + installed (swap) +
//     available (install)
//   - sandbox       → header + installed (swap); backends are node capabilities,
//                     not installables
//
// In the expanded node dialog (`useNodeSurface() === "panel"`) the same props
// render as an iOS-Settings row that pushes a full subpage instead of a submenu:
// the header becomes the first card, actions and option lists become their own
// grouped sections, and the selection is ticked on the right.
//
// No layer fabricates an "Update" it cannot honour: engine downloads are pinned
// to a compile-time target and move with the app, so only the services pass
// `onUpdate`.

import { PlayIcon, StopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SettingsTint } from "@ryu/blocks/desktop/settings-nav.tsx";
import {
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils.ts";
import { AutoScrollText } from "./AutoScrollText.tsx";
import { OptionRow, PanelOptionRow } from "./NodeLayerMenu-option-rows.tsx";
import type {
	LayerAction,
	LayerRunState,
	NodeLayerMenuProps,
} from "./NodeLayerMenu-types.ts";
import {
	PanelGroup,
	PanelPageLink,
	PanelRow,
	PanelSection,
	PanelStaticRow,
	useNodeSurface,
} from "./NodePanelNav.tsx";

export type {
	LayerAction,
	LayerOption,
	LayerRunState,
	LayerSelectionMode,
	NodeLayerMenuProps,
} from "./NodeLayerMenu-types.ts";

const DOT_CLASS = {
	on: "bg-success",
	off: "bg-destructive",
	unknown: "bg-muted-foreground/30",
} satisfies Record<"on" | "off" | "unknown", string>;

function dotState(running: LayerRunState): "on" | "off" | "unknown" {
	if (running === null || running === undefined) {
		return "unknown";
	}
	return running ? "on" : "off";
}

/** Version badge text. Build stamps that already carry their own letter prefix
 *  (llama.cpp's `b9670`) must not be re-prefixed into "vb9670" — only a bare
 *  numeric version gets the `v`. */
function versionLabel(version: string): string {
	return /^\d/.test(version) ? `v${version}` : version;
}

/** Shared "start" / "stop" actions, so every toggleable layer words it the same. */
export function startStopAction(
	running: LayerRunState,
	toggle: (next: boolean) => Promise<void> | void
): LayerAction {
	const isRunning = running === true;
	return {
		id: isRunning ? "stop" : "start",
		label: isRunning ? "Stop" : "Start",
		busyLabel: isRunning ? "Stopping…" : "Starting…",
		icon: isRunning ? StopIcon : PlayIcon,
		tone: isRunning ? "destructive" : "default",
		run: () => toggle(!isRunning),
	};
}

/** Tile color per action tone, from Settings' closed tint palette. */
const ACTION_TINT = {
	default: "blue",
	warning: "orange",
	destructive: "red",
} satisfies Record<NonNullable<LayerAction["tone"]>, SettingsTint>;

function SectionLabel({ children }: { children: ReactNode }) {
	return (
		<p className="px-2 pt-1 pb-0.5 font-medium text-muted-foreground/70 text-xs">
			{children}
		</p>
	);
}

export function NodeLayerMenu({
	actions = [],
	available = [],
	caption,
	children,
	currentLabel,
	icon,
	installed = [],
	label,
	running,
	selectionMode = "swap",
	trailing,
	version,
}: NodeLayerMenuProps) {
	// One pending key for the whole submenu: mutations on the same layer are
	// mutually exclusive (you cannot start an engine while swapping off it), so a
	// single in-flight slot keeps the menu honest instead of racing itself.
	const [pending, setPending] = useState<string | null>(null);
	const surface = useNodeSurface();

	const run = (key: string, task: () => Promise<void> | void) => {
		if (pending !== null) {
			return;
		}
		setPending(key);
		Promise.resolve(task())
			.catch(() => {
				// Every call site surfaces its own failure (toast / status re-poll);
				// the menu only owns clearing the spinner.
			})
			.finally(() => setPending(null));
	};

	// A singleton layer names itself on both slots ("Core" / "Core"), so it shows
	// its live detail on the trigger instead of echoing its own label.
	const triggerRight =
		trailing ?? (currentLabel === label ? null : currentLabel);

	if (surface === "panel") {
		return (
			<PanelPageLink
				icon={icon}
				label={label}
				title={label}
				trailing={
					<>
						{running !== undefined && (
							<span
								aria-hidden
								className={cn(
									"size-1.5 shrink-0 rounded-full",
									DOT_CLASS[dotState(running)]
								)}
							/>
						)}
						{triggerRight ? (
							<span className="min-w-0 truncate text-sm" title={triggerRight}>
								{triggerRight}
							</span>
						) : null}
						{version && (
							<span className="shrink-0 text-xs tabular-nums">
								{versionLabel(version)}
							</span>
						)}
					</>
				}
			>
				<PanelSection footer={caption ?? undefined}>
					<PanelStaticRow>
						<span
							className="min-w-0 flex-1 truncate font-medium"
							title={currentLabel}
						>
							{currentLabel}
						</span>
						{running !== undefined && (
							<span
								aria-hidden
								className={cn(
									"size-2 shrink-0 rounded-full",
									DOT_CLASS[dotState(running)]
								)}
							/>
						)}
						{version && (
							<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
								{versionLabel(version)}
							</span>
						)}
					</PanelStaticRow>
					{actions.map((action) => {
						const busy = pending === `action:${action.id}`;
						return (
							<PanelRow
								disabled={pending !== null}
								icon={action.icon}
								key={action.id}
								onClick={() => run(`action:${action.id}`, action.run)}
								tint={ACTION_TINT[action.tone ?? "default"]}
								tone={
									action.tone === "destructive" || action.tone === "warning"
										? action.tone
										: "accent"
								}
							>
								{busy ? (action.busyLabel ?? action.label) : action.label}
							</PanelRow>
						);
					})}
				</PanelSection>
				{installed.length > 0 && (
					<PanelSection
						title={
							selectionMode === "toggle"
								? "Installed · tap to start or stop"
								: "Installed"
						}
					>
						{installed.map((option) => (
							<PanelOptionRow
								key={option.name}
								kind="installed"
								mode={selectionMode}
								onRun={run}
								option={option}
								pending={pending}
							/>
						))}
					</PanelSection>
				)}
				{available.length > 0 && (
					<PanelSection title="Not installed">
						{available.map((option) => (
							<PanelOptionRow
								key={option.name}
								kind="available"
								mode={selectionMode}
								onRun={run}
								option={option}
								pending={pending}
							/>
						))}
					</PanelSection>
				)}
				{children ? <PanelGroup>{children}</PanelGroup> : null}
			</PanelPageLink>
		);
	}

	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger purpose="layer-selection">
				{icon && (
					<HugeiconsIcon
						className="size-3 shrink-0 text-muted-foreground/70"
						icon={icon}
					/>
				)}
				<span className="shrink-0 text-muted-foreground">{label}</span>
				{/* Right-aligned cluster. The dot reports the state of the CURRENT
				    SELECTION named in this group ("kokoro 82m", "v0.1.4"), not of the
				    layer slot on the left — so it leads the group instead of the row.
				    Docked at the row's left edge it read as a status for "Speech" the
				    label, a whole column away from the thing it actually describes. */}
				<span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
					{running !== undefined && (
						<span
							aria-hidden
							className={cn(
								"size-1.5 shrink-0 rounded-full",
								DOT_CLASS[dotState(running)]
							)}
						/>
					)}
					{triggerRight ? (
						<AutoScrollText
							className="min-w-0 text-right text-muted-foreground/70"
							title={triggerRight}
						>
							{triggerRight}
						</AutoScrollText>
					) : null}
					{version && (
						<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
							{versionLabel(version)}
						</span>
					)}
				</span>
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="w-64 min-w-64">
				{/* Header: WHAT is selected right now, and how it is doing. */}
				<div className="px-2 pt-1.5 pb-1">
					<div className="flex items-baseline gap-2">
						<AutoScrollText
							className="min-w-0 flex-1 font-medium text-xs"
							title={currentLabel}
						>
							{currentLabel}
						</AutoScrollText>
						{version && (
							<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
								{versionLabel(version)}
							</span>
						)}
					</div>
					<p className="truncate text-muted-foreground/70 text-xs">
						{caption ?? label}
					</p>
				</div>
				{actions.map((action) => {
					const busy = pending === `action:${action.id}`;
					return (
						<DropdownMenuItem
							closeOnClick={false}
							density="compact"
							disabled={pending !== null}
							key={action.id}
							onClick={() => run(`action:${action.id}`, action.run)}
							purpose="layer-action"
							spacing="comfortable"
							tone={
								action.tone === "destructive" ? "destructive" : "foreground"
							}
						>
							{action.icon && (
								<HugeiconsIcon
									className={cn(
										"size-3 shrink-0",
										action.tone === "warning" && "text-status-warning"
									)}
									icon={action.icon}
								/>
							)}
							<span
								className={cn(
									"flex-1",
									action.tone === "warning" && "text-status-warning"
								)}
							>
								{busy ? (action.busyLabel ?? action.label) : action.label}
							</span>
						</DropdownMenuItem>
					);
				})}
				{installed.length > 0 && (
					<>
						<SectionLabel>
							{selectionMode === "toggle" ? "Installed · running" : "Installed"}
						</SectionLabel>
						{installed.map((option) => (
							<OptionRow
								key={option.name}
								kind="installed"
								mode={selectionMode}
								onRun={run}
								option={option}
								pending={pending}
							/>
						))}
					</>
				)}
				{available.length > 0 && (
					<>
						<SectionLabel>Not installed</SectionLabel>
						{available.map((option) => (
							<OptionRow
								key={option.name}
								kind="available"
								mode={selectionMode}
								onRun={run}
								option={option}
								pending={pending}
							/>
						))}
					</>
				)}
				{children}
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}
