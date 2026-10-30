// apps/desktop/src/components/shell/NodeLayerMenu-option-rows.tsx
//
// The per-option rows of a NodeLayerMenu: the dropdown row and its panel twin.

import {
	Delete02Icon,
	Download04Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { DropdownMenuItem } from "@ryu/ui/components/dropdown-menu.tsx";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";
import { AutoScrollText } from "./AutoScrollText.tsx";
import type { LayerOption, LayerSelectionMode } from "./NodeLayerMenu-types.ts";
import { PanelRow } from "./NodePanelNav.tsx";

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

export function OptionRow({
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
	const tl = useLiteralMessages();

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
					className="size-3 shrink-0 text-muted-foreground/70"
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
				<span className="shrink-0 text-muted-foreground/70 text-xs">
					{option.busyLabel ?? busyWording(kind, mode, active)}
				</span>
			) : (
				detail && (
					<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
						{detail}
					</span>
				)
			)}
			{option.uninstall && !option.disabled && (
				<button
					aria-label={tl("Uninstall {label}", { label: option.label })}
					className="shrink-0 rounded-md p-0.5 text-muted-foreground/70 hover:bg-destructive/10 hover:text-status-destructive disabled:opacity-50"
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
export function PanelOptionRow({
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
	const tl = useLiteralMessages();

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
						aria-label={tl("Uninstall {label}", { label: option.label })}
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
