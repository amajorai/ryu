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

import {
	Delete02Icon,
	Download04Icon,
	PlayIcon,
	StopIcon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
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
import {
	PanelGroup,
	PanelPageLink,
	PanelRow,
	PanelSection,
	PanelStaticRow,
	useNodeSurface,
} from "./NodePanelNav.tsx";

/**
 * Run state of a layer:
 *   `true`/`false` — up / down (green / red dot);
 *   `null`         — probed but unknown, or not relevant yet (neutral dot);
 *   omitted        — the layer HAS no run state (a pure preference, like the
 *                    nested voice picker), so no dot is drawn at all. A grey dot
 *                    on something that cannot run reads as "broken".
 */
export type LayerRunState = boolean | null;

/** A top-of-submenu verb: Start / Stop / Update / Restart / Launch. */
export interface LayerAction {
	/** Rendered while `run()` is in flight ("Starting…"). Falls back to `label`. */
	busyLabel?: string;
	icon?: IconSvgElement;
	/** Stable key for the pending state — also the React key. */
	id: string;
	label: string;
	run: () => Promise<void> | void;
	/** Warning tone for Update, destructive for anything that tears state down. */
	tone?: "default" | "warning" | "destructive";
}

/** One swappable / installable option inside a layer's submenu. */
export interface LayerOption {
	/** Ticked: the current selection in a `swap` layer, running in a `toggle` one. */
	active?: boolean;
	/** Shown while `select()` is in flight; defaults to the layer's mode wording. */
	busyLabel?: string;
	/** Right-aligned caption — version, "running", a size, whatever fits. */
	detail?: string | null;
	disabled?: boolean;
	/** Why it is disabled (e.g. "not supported on macOS") — shown as the detail. */
	disabledReason?: string | null;
	label: string;
	/** Stable key: the catalog/engine/backend name. */
	name: string;
	/** Picking this option (swap to it, or install it when `available`). */
	select: () => Promise<void> | void;
	/** Optional uninstall for an installed option; omitted → no uninstall. */
	uninstall?: () => Promise<void> | void;
}

/**
 * How the installed list behaves — this is the ONE place a layer declares its
 * backend semantics, and it must match Core:
 *
 *   `swap`   — mutually exclusive. Exactly one option is active; picking another
 *              moves the layer onto it (Chat, sandbox backend, Audio, Voice Recognition).
 *   `toggle` — independent. Every option runs (or not) on its own; the tick means
 *              "running", and picking one starts/stops just that engine. The
 *              run-alongside engines (speech / image / embeddings) are this — they
 *              have no "current selection" to swap between.
 */
export type LayerSelectionMode = "swap" | "toggle";

export interface NodeLayerMenuProps {
	actions?: LayerAction[];
	/** Options the node does NOT have yet — picking one installs it. */
	available?: LayerOption[];
	/** Sub-caption under the submenu header: "Running · 2.1 GB", "Stopped". */
	caption?: string | null;
	/** Extra rows appended to the submenu (e.g. a nested voice picker). */
	children?: ReactNode;
	/** What the trigger row shows on the right: the current selection's name. */
	currentLabel: string;
	icon?: IconSvgElement;
	/** Options already on the node — picking one swaps the layer onto it. */
	installed?: LayerOption[];
	/** The layer's name, shown on the trigger row: "Chat", "Core". */
	label: string;
	running?: LayerRunState;
	/** Semantics of `installed` — see {@link LayerSelectionMode}. Default `swap`. */
	selectionMode?: LayerSelectionMode;
	/** Trigger-row right-hand caption. Defaults to `currentLabel` when it differs
	 *  from `label` (a singleton layer like "Core" names itself, so it passes a
	 *  live detail — "2.1 GB · 4%" — instead of repeating its own name). */
	trailing?: string | null;
	/** Version of the CURRENT selection, badged on the trigger + header. */
	version?: string | null;
}

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

/** Default in-flight wording per list, when the option doesn't override it. */
function busyWording(
	kind: "installed" | "available",
	mode: LayerSelectionMode,
	active: boolean
): string {
	if (kind === "available") {
		return "Installing…";
	}
	if (mode === "toggle") {
		return active ? "Stopping…" : "Starting…";
	}
	return "Switching…";
}

function OptionRow({
	option,
	kind,
	mode,
	pending,
	onRun,
}: {
	kind: "installed" | "available";
	mode: LayerSelectionMode;
	onRun: (key: string, task: () => Promise<void> | void) => void;
	option: LayerOption;
	pending: string | null;
}) {
	const selectKey = `${kind}:${option.name}`;
	const uninstallKey = `uninstall:${option.name}`;
	const busy = pending === selectKey;
	const uninstalling = pending === uninstallKey;
	const detail = option.disabled
		? (option.disabledReason ?? option.detail)
		: option.detail;
	const active = option.active ?? false;

	return (
		<DropdownMenuItem
			closeOnClick={false}
			density="compact"
			disabled={option.disabled || pending !== null}
			onClick={() => onRun(selectKey, option.select)}
			purpose="layer-action"
			spacing="comfortable"
		>
			{kind === "installed" ? (
				<span className="flex size-3 shrink-0 items-center justify-center">
					{active ? (
						<HugeiconsIcon
							className="size-3 text-primary"
							icon={Tick02Icon}
							strokeWidth={2.5}
						/>
					) : (
						// A toggle layer has no single "current" row, so an idle engine
						// keeps an explicit off-dot rather than an empty gutter.
						mode === "toggle" && (
							<span
								aria-hidden
								className="size-1.5 rounded-full bg-muted-foreground/30"
							/>
						)
					)}
				</span>
			) : (
				<HugeiconsIcon
					className="size-3 shrink-0 text-muted-foreground/60"
					icon={Download04Icon}
				/>
			)}
			<AutoScrollText
				className={cn("min-w-0 flex-1", active && "font-medium")}
				title={option.label}
			>
				{option.label}
			</AutoScrollText>
			{busy ? (
				<span className="type-compact shrink-0 text-muted-foreground/60">
					{option.busyLabel ?? busyWording(kind, mode, active)}
				</span>
			) : (
				detail && (
					<span className="type-compact shrink-0 text-muted-foreground/50 tabular-nums">
						{detail}
					</span>
				)
			)}
			{option.uninstall && !option.disabled && (
				<button
					aria-label={`Uninstall ${option.label}`}
					className="shrink-0 rounded-md p-0.5 text-muted-foreground/50 hover:bg-destructive/10 hover:text-status-destructive disabled:opacity-50"
					disabled={pending !== null}
					onClick={(e) => {
						// Uninstall is a row-local action: never let it bubble into the
						// row's own "select this option" handler.
						e.preventDefault();
						e.stopPropagation();
						const task = option.uninstall;
						if (task) {
							onRun(uninstallKey, task);
						}
					}}
					title={uninstalling ? "Uninstalling…" : "Uninstall"}
					type="button"
				>
					<HugeiconsIcon className="size-3" icon={Delete02Icon} />
				</button>
			)}
		</DropdownMenuItem>
	);
}

/** Panel-surface twin of {@link OptionRow}: a full-width row, the selection
 *  ticked on the right, uninstall as a sibling button (never nested in the row). */
function PanelOptionRow({
	option,
	kind,
	mode,
	pending,
	onRun,
}: {
	kind: "installed" | "available";
	mode: LayerSelectionMode;
	onRun: (key: string, task: () => Promise<void> | void) => void;
	option: LayerOption;
	pending: string | null;
}) {
	const selectKey = `${kind}:${option.name}`;
	const uninstallKey = `uninstall:${option.name}`;
	const busy = pending === selectKey;
	const uninstalling = pending === uninstallKey;
	const detail = option.disabled
		? (option.disabledReason ?? option.detail)
		: option.detail;
	const active = option.active ?? false;

	let status: ReactNode = null;
	if (busy) {
		status = (
			<span className="shrink-0 font-normal text-muted-foreground text-sm">
				{option.busyLabel ?? busyWording(kind, mode, active)}
			</span>
		);
	} else if (kind === "installed" && active) {
		status = (
			<HugeiconsIcon
				aria-label={mode === "toggle" ? "Running" : "Selected"}
				className="size-4 shrink-0 text-primary"
				icon={Tick02Icon}
				strokeWidth={2.5}
			/>
		);
	} else if (kind === "installed" && mode === "toggle") {
		// A toggle layer has no single selection, so an idle engine says so —
		// a blank trailing edge read as "nothing here" rather than "stopped".
		status = (
			<span className="shrink-0 font-normal text-muted-foreground text-sm">
				Off
			</span>
		);
	}

	return (
		<PanelRow
			current={kind === "installed" && mode === "swap" ? active : undefined}
			disabled={option.disabled || pending !== null}
			icon={kind === "available" ? Download04Icon : undefined}
			onClick={() => onRun(selectKey, option.select)}
			pressed={kind === "installed" && mode === "toggle" ? active : undefined}
			sideAction={
				option.uninstall && !option.disabled ? (
					<button
						aria-label={`Uninstall ${option.label}`}
						className="relative z-10 shrink-0 rounded-md p-1 text-muted-foreground/70 hover:bg-destructive/10 hover:text-status-destructive disabled:opacity-50"
						disabled={pending !== null}
						onClick={() => {
							const task = option.uninstall;
							if (task) {
								onRun(uninstallKey, task);
							}
						}}
						title={uninstalling ? "Uninstalling…" : "Uninstall"}
						type="button"
					>
						<HugeiconsIcon className="size-4" icon={Delete02Icon} />
					</button>
				) : undefined
			}
			tint="blue"
			trailing={status}
			value={detail}
		>
			{option.label}
		</PanelRow>
	);
}

/** Tile color per action tone, from Settings' closed tint palette. */
const ACTION_TINT = {
	default: "blue",
	warning: "orange",
	destructive: "red",
} satisfies Record<NonNullable<LayerAction["tone"]>, SettingsTint>;

function SectionLabel({ children }: { children: ReactNode }) {
	return (
		<p className="type-micro px-2 pt-1 pb-0.5 font-medium text-muted-foreground/40">
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
							<span className="type-compact shrink-0 tabular-nums">
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
							<span className="type-compact shrink-0 text-muted-foreground tabular-nums">
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
						className="size-3 shrink-0 text-muted-foreground/60"
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
						<span className="type-compact shrink-0 text-muted-foreground/50 tabular-nums">
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
							<span className="type-compact shrink-0 text-muted-foreground/50 tabular-nums">
								{versionLabel(version)}
							</span>
						)}
					</div>
					<p className="type-compact truncate text-muted-foreground/60">
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
