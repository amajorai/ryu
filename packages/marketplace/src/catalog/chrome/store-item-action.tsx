// packages/marketplace/src/catalog/chrome/store-item-action.tsx
//
// The one Store action control every catalog card + detail header uses, so the
// affordance is identical across Apps, Plugins, Models, Skills, MCP, and Agents.
// It is the generalization of the models page's morph button:
//
//   • not installed          → an Install button (with live download %).
//   • installed, no enable    → "Installed" at rest, morphs to "Uninstall" on hover.
//   • installed + enabled     → "Enabled"   at rest, morphs to "Disable"   on hover.
//   • installed + disabled    → "Disabled"  at rest, morphs to "Uninstall" on hover.
//
// Sections without an enable/disable concept (Models per-file, Agents, MCP) pass
// `enabled={undefined}`; sections that have one (Apps, Skills) pass a boolean.

import {
	CheckmarkCircle02Icon,
	Delete01Icon,
	MoreHorizontalIcon,
	PauseIcon,
	PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { InstallProgressButton } from "@ryu/blocks/desktop/install-button.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";

export interface StoreItemActionProps {
	/** Rendered instead of the lifecycle buttons on a read-only surface (web). */
	affordance?: React.ReactNode;
	/** A lifecycle call is in flight — the control shows a spinner and disables. */
	busy?: boolean;
	className?: string;
	/** `undefined` = the item has no enable/disable concept (install/uninstall only). */
	enabled?: boolean;
	installed: boolean;
	/** Locked items (e.g. the flagship agent) can't be removed. */
	locked?: boolean;
	lockedLabel?: string;
	onDisable?: () => void;
	onEnable?: () => void;
	onInstall?: () => void;
	onUninstall?: () => void;
	/** Live install completion 0–100 (or null when the size is unknown). */
	percent?: number | null;
}

export default function StoreItemAction({
	installed,
	enabled,
	busy = false,
	percent = null,
	locked = false,
	lockedLabel = "Built in",
	onInstall,
	onUninstall,
	onEnable,
	onDisable,
	affordance,
	className,
}: StoreItemActionProps) {
	if (affordance) {
		return <>{affordance}</>;
	}

	if (!installed) {
		return (
			<InstallProgressButton
				className={className}
				idleVariant="default"
				installing={busy}
				onClick={onInstall}
				percent={percent}
			>
				Install
			</InstallProgressButton>
		);
	}

	if (locked) {
		return (
			<Button className={className} disabled size="sm" variant="secondary">
				<HugeiconsIcon
					className="size-3.5 text-success"
					icon={CheckmarkCircle02Icon}
				/>
				{lockedLabel}
			</Button>
		);
	}

	// Installed items collapse to a single 3-dot menu instead of a morphing pill,
	// so the row stays quiet at rest and the lifecycle actions (enable/disable +
	// uninstall) live behind one deliberate click. `enabled === undefined` means
	// the item has no enable/disable concept (Models per-file, Agents, MCP, and
	// Skills whose CLI can't toggle) — the menu then holds only Uninstall.
	const hasEnableConcept = enabled !== undefined;
	const isEnabled = enabled === true;

	// While a lifecycle call is in flight the trigger shows a spinner and locks,
	// so a second click can't race the first.
	if (busy) {
		return (
			<Button
				aria-label="Working…"
				className={className}
				disabled
				size="icon-sm"
				variant="ghost"
			>
				<Spinner className="size-4" />
			</Button>
		);
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label="Manage"
						className={className}
						size="icon-sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={MoreHorizontalIcon} />
					</Button>
				}
			/>
			<DropdownMenuContent align="end">
				{hasEnableConcept &&
					(isEnabled ? (
						<DropdownMenuItem onClick={onDisable}>
							<HugeiconsIcon className="size-4" icon={PauseIcon} />
							Disable
						</DropdownMenuItem>
					) : (
						<DropdownMenuItem onClick={onEnable}>
							<HugeiconsIcon className="size-4" icon={PlayIcon} />
							Enable
						</DropdownMenuItem>
					))}
				{onUninstall ? (
					<DropdownMenuItem onClick={onUninstall} variant="destructive">
						<HugeiconsIcon className="size-4" icon={Delete01Icon} />
						Uninstall
					</DropdownMenuItem>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
