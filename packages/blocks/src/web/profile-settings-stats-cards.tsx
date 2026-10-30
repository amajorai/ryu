"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { Check, Coins, Info, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { SettingsCard } from "../desktop/settings-items.tsx";
import { formatCompact } from "./profile-settings-stats-format.ts";
import type { ProfileFeatureUnlock } from "./profile-settings-types.ts";

export function HeroStat({
	hint,
	label,
	value,
}: {
	/** Optional explanation of the number, shown as a tooltip on an info
	 *  trigger and read by screen readers as part of the stat. */
	hint?: string;
	label: string;
	value: string;
}) {
	const tl = useLiteralMessages();
	return (
		<SettingsCard className="flex flex-col gap-1">
			<span className="truncate font-heading font-medium text-foreground text-lg tabular-nums">
				{value}
			</span>
			<span className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
				<span className="truncate" title={label}>
					{label}
				</span>
				{hint ? (
					// The web app has no root tooltip provider, so each hint
					// brings its own (as `StatusBadge` does).
					<TooltipProvider delay={0}>
						<Tooltip>
							<TooltipTrigger
								render={
									<button
										aria-label={tl("About {label}: {hint}", {
											label: label.toLowerCase(),
											hint,
										})}
										className="shrink-0 rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										type="button"
									/>
								}
							>
								<Info aria-hidden="true" className="size-3" />
							</TooltipTrigger>
							<TooltipContent>{hint}</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				) : null}
			</span>
		</SettingsCard>
	);
}

export function ChartCard({
	children,
	icon,
	title,
}: {
	children: ReactNode;
	icon: ReactNode;
	title: string;
}) {
	return (
		<SettingsCard>
			<div className="mb-2 flex items-center gap-2 font-medium text-sm">
				{icon}
				{title}
			</div>
			{children}
		</SettingsCard>
	);
}

export function UnlockAction({
	feature,
	isUnlocked,
	pointsBalance,
	isUnlocking,
	onUnlock,
}: {
	feature: ProfileFeatureUnlock;
	isUnlocked: boolean;
	pointsBalance: number;
	isUnlocking: boolean;
	onUnlock?: (key: string) => void;
}) {
	const tl = useLiteralMessages();
	const cost = feature.pointsCost ?? 0;
	const canAfford = pointsBalance >= cost;

	if (isUnlocked) {
		return (
			<span className="inline-flex items-center gap-1 font-medium text-primary text-xs">
				<Check className="size-3" />
				Unlocked
			</span>
		);
	}

	if (feature.tier === "progressive") {
		return (
			<Button
				disabled={!canAfford}
				loading={isUnlocking}
				onClick={() => onUnlock?.(feature.key)}
				size="sm"
				variant={canAfford ? "default" : "outline"}
			>
				{isUnlocking ? (
					"Unlocking…"
				) : (
					<>
						<Coins className="size-3" />
						{canAfford
							? tl("Unlock · {cost} pts", { cost: formatCompact(cost) })
							: tl("Need {cost} pts", { cost: formatCompact(cost) })}
					</>
				)}
			</Button>
		);
	}

	if (feature.tier === "paid") {
		return (
			<span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
				<Lock className="size-3" />
				{feature.requiresPlan?.length
					? tl("Included with {plans}", {
							plans: feature.requiresPlan.join(", "),
						})
					: "Included with a paid plan"}
			</span>
		);
	}

	return null;
}
