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
	Download01Icon,
	PauseIcon,
	PlayIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { InstallProgressButton } from "@ryu/blocks/desktop/install-button";
import { Button } from "@ryu/ui/components/button.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useState } from "react";

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
	// Hover/focus "arms" the rest-state pill into its destructive/secondary action.
	const [armed, setArmed] = useState(false);

	if (affordance) {
		return <>{affordance}</>;
	}

	if (!installed) {
		return (
			<InstallProgressButton
				className={className}
				idleVariant="secondary"
				installing={busy}
				onClick={onInstall}
				percent={percent}
			>
				<HugeiconsIcon className="size-3.5" icon={Download01Icon} />
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

	// Resolve the rest label and the armed (hover/focus) label + action + look.
	// Three morphs, no nested ternaries:
	//   enabled            → "Enabled"  → Disable   (outline)
	//   disabled/installed + onUninstall → rest → "Uninstall" (destructive)
	//   disabled + onEnable only          → "Disabled" → "Enable" (default)
	const hasEnableConcept = enabled !== undefined;
	const isEnabled = enabled === true;

	let restLabel = "Installed";
	if (hasEnableConcept) {
		restLabel = isEnabled ? "Enabled" : "Disabled";
	}

	let armedLabel: string;
	let armedAction: (() => void) | undefined;
	let armedIcon: IconSvgElement;
	let armedVariant: "outline" | "destructive" | "default";
	let busyLabel: string;
	if (isEnabled) {
		armedLabel = "Disable";
		armedAction = onDisable;
		armedIcon = PauseIcon;
		armedVariant = "outline";
		busyLabel = "Disabling…";
	} else if (onUninstall) {
		armedLabel = "Uninstall";
		armedAction = onUninstall;
		armedIcon = Delete01Icon;
		armedVariant = "destructive";
		busyLabel = "Removing…";
	} else {
		armedLabel = "Enable";
		armedAction = onEnable;
		armedIcon = PlayIcon;
		armedVariant = "default";
		busyLabel = "Enabling…";
	}

	let label = restLabel;
	if (busy) {
		label = busyLabel;
	} else if (armed) {
		label = armedLabel;
	}

	return (
		<Button
			className={className}
			disabled={busy}
			onBlur={() => setArmed(false)}
			onClick={armedAction}
			onFocus={() => setArmed(true)}
			onMouseEnter={() => setArmed(true)}
			onMouseLeave={() => setArmed(false)}
			size="sm"
			variant={armed ? armedVariant : "secondary"}
		>
			{busy ? (
				<Spinner className="size-4" />
			) : (
				<HugeiconsIcon
					className={armed ? "size-3.5" : "size-3.5 text-success"}
					icon={armed ? armedIcon : CheckmarkCircle02Icon}
				/>
			)}
			{label}
		</Button>
	);
}
