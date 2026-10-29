// apps/desktop/src/components/chat/BoxCostChip.tsx
//
// The credits UX of a session Box: a compact cost chip (`$0.0123 · 18 min`),
// a low-credit warning, and the banner shown when the Box stopped because the
// credits ran out. Every number comes from Core, which reads it from the
// Gateway's own metering tick (accrued cost, rate, balance). The desktop never
// prices a Box itself.
//
// The warning follows the ManagedNodeWallet pattern (NodeSelector.tsx): a
// warning-tinted row whose action opens the credits settings.

import { Alert02Icon, DollarCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { SessionBoxView } from "@/src/lib/api/session-box.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";

const SIZE_LABELS = {
	small: "Small",
	default: "Default",
	large: "Large",
} as const;

/** `$0.0123` under a dollar, `$1.23` from a dollar up. */
export function formatBoxCost(microUsd: number): string {
	const usd = Math.max(0, microUsd) / 1_000_000;
	return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/** `<1 min`, `18 min`, or `1 h 05 min`. */
export function formatBoxRunningTime(seconds: number): string {
	const minutes = Math.floor(Math.max(0, seconds) / 60);
	if (minutes < 1) {
		return "<1 min";
	}
	if (minutes < 60) {
		return `${minutes} min`;
	}
	const hours = Math.floor(minutes / 60);
	return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
}

function chipTitle(box: SessionBoxView): string {
	const lines: string[] = ["Box session compute"];
	if (box.size) {
		lines.push(`Size: ${SIZE_LABELS[box.size]}`);
	}
	if (box.ratePerHourMicroUsd !== null) {
		lines.push(`Rate: ${formatBoxCost(box.ratePerHourMicroUsd)} per hour`);
	}
	if (box.minutesRemaining !== null) {
		lines.push(`About ${box.minutesRemaining} min of credit left`);
	}
	if (box.placement?.location) {
		lines.push(`Location: ${box.placement.location}`);
	}
	return lines.join("\n");
}

/** A Box that is starting or running, i.e. one whose run can accrue cost. */
function isRunning(box: SessionBoxView): boolean {
	return box.state === "provisioning" || box.state === "ready";
}

/**
 * The chip text for one Box, or `null` to render nothing.
 *
 * Core reports `0` for a run the Gateway has not ticked yet, so until the
 * first accrual arrives a running Box reads `starting` instead of a
 * misleading `$0.0000`. A parked or stopped Box has no run to price: with
 * nothing accrued it shows no chip at all.
 */
export function boxCostLabel(box: SessionBoxView): string | null {
	if (box.accruedMicroUsd === null && box.runningSeconds === null) {
		return null;
	}
	const accrued = box.accruedMicroUsd ?? 0;
	if (accrued <= 0) {
		return isRunning(box) ? "starting" : null;
	}
	return `${formatBoxCost(accrued)} · ${formatBoxRunningTime(box.runningSeconds ?? 0)}`;
}

/**
 * The running cost and time of one Box. Renders nothing before Core meters it,
 * and `starting` until the Gateway's first tick accrues a cost.
 */
export function BoxCostChip({
	box,
	className,
}: {
	box: SessionBoxView;
	className?: string;
}) {
	const label = boxCostLabel(box);
	if (label === null) {
		return null;
	}
	return (
		<span
			className={cn(
				"type-compact inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 tabular-nums",
				box.warning === "none"
					? "bg-muted text-muted-foreground"
					: "bg-warning/10 text-status-warning",
				box.warning === "critical" &&
					"bg-destructive/10 text-status-destructive",
				className
			)}
			data-box-pending={label === "starting" ? "" : undefined}
			data-box-warning={box.warning}
			data-testid="box-cost-chip"
			title={chipTitle(box)}
		>
			<HugeiconsIcon className="size-3 shrink-0" icon={DollarCircleIcon} />
			{label}
		</span>
	);
}

const STOP_MESSAGES: Record<string, string> = {
	balance:
		"This session's Box stopped because your credits ran out. Its work is saved; top up to resume.",
	budget:
		"This session's Box stopped because a spending budget was reached. Its work is saved.",
	accounting:
		"This session's Box stopped because its usage could not be recorded. Its work is saved.",
	suspended:
		"This session's Box stopped because billing for the organization is suspended.",
};

/** Stop reasons that are about money, where a top-up is the way forward. */
const TOP_UP_REASONS = new Set(["balance", "suspended"]);

/**
 * The low-credit warning while a Box runs, or the exhaustion banner after it
 * stopped for lack of credit. Renders nothing otherwise.
 */
export function BoxCreditBanner({ box }: { box: SessionBoxView }) {
	const openSettings = useSettingsDialog((state) => state.openSettings);
	const tl = useLiteralMessages();
	const stopMessage = box.stopReason ? STOP_MESSAGES[box.stopReason] : null;
	const stopped = box.state === "parked" || box.state === "stopped";
	let message: string | null = null;
	let critical = false;
	let topUp = false;
	if (stopped && stopMessage) {
		message = stopMessage;
		critical = true;
		topUp = TOP_UP_REASONS.has(box.stopReason ?? "");
	} else if (!stopped && box.warning === "critical") {
		message =
			box.minutesRemaining === null
				? "Credits are almost out. This session's Box stops when they run out."
				: tl(
						"Credits are almost out: about {minutesRemaining} min of Box time left. The Box stops when they run out.",
						{ minutesRemaining: box.minutesRemaining }
					);
		critical = true;
		topUp = true;
	} else if (!stopped && box.warning === "low") {
		message =
			box.minutesRemaining === null
				? "Credits are running low for this session's Box."
				: tl(
						"Credits are running low: about {minutesRemaining} min of Box time left.",
						{ minutesRemaining: box.minutesRemaining }
					);
		topUp = true;
	}
	if (!message) {
		return null;
	}
	return (
		<div
			className={cn(
				"flex min-w-0 items-center gap-2 rounded-xl border px-2 py-1 text-xs",
				critical
					? "border-destructive/30 bg-destructive/10 text-status-destructive"
					: "border-warning/30 bg-warning/10 text-status-warning"
			)}
			data-testid="box-credit-banner"
			role={critical ? "alert" : "status"}
		>
			<HugeiconsIcon className="shrink-0" icon={Alert02Icon} size={13} />
			<span className="min-w-0 flex-1">{message}</span>
			{topUp ? (
				<Button
					onClick={() => openSettings("credits")}
					size="sm"
					type="button"
					variant="ghost"
				>
					Top up
				</Button>
			) : null}
		</div>
	);
}
