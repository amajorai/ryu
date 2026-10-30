// One entry of the Stats settings tab's unlockable-feature catalog.

import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import type { UnlockCatalogEntry } from "@/src/lib/api/profile.ts";
import { formatNumber } from "./StatsTab-format.ts";

interface UnlockCardProps {
	entry: UnlockCatalogEntry;
	isPending: boolean;
	isUnlocked: boolean;
	onUnlock: () => void;
	pointsBalance: number;
}

export function UnlockCard({
	entry,
	isPending,
	isUnlocked,
	onUnlock,
	pointsBalance,
}: UnlockCardProps) {
	const tl = useLiteralMessages();
	const requiresPlan = (entry.requiresPlan?.length ?? 0) > 0;
	const cost = entry.pointsCost ?? 0;
	const affordable = cost > 0 && pointsBalance >= cost;

	const renderAction = () => {
		if (isUnlocked) {
			return (
				<span className="flex items-center gap-1.5 text-muted-foreground text-sm">
					<HugeiconsIcon icon={Tick02Icon} size={14} />
					Unlocked
				</span>
			);
		}
		if (entry.tier === "paid" && requiresPlan) {
			return (
				<span className="text-muted-foreground text-sm">
					{tl("Requires {plans}", {
						plans: entry.requiresPlan?.join(", ") ?? "",
					})}
				</span>
			);
		}
		if (entry.tier === "progressive" && entry.autoUnlockAtLevel) {
			return (
				<span className="text-muted-foreground text-sm">
					{tl("Unlocks at level {level}", {
						level: String(entry.autoUnlockAtLevel),
					})}
				</span>
			);
		}
		if (cost > 0) {
			return (
				<Button
					disabled={!affordable || isPending}
					onClick={onUnlock}
					size="sm"
					variant="outline"
				>
					{isPending
						? "Unlocking…"
						: tl("Unlock · {cost} pts", { cost: formatNumber(cost) })}
				</Button>
			);
		}
		return null;
	};

	return (
		// One flush row: title and a one-line description, the state or action
		// at the right, a hairline to the next row.
		<div className="flex min-h-12 items-center justify-between gap-6 border-border border-b py-3 last:border-b-0">
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="text-sm">{entry.title}</span>
				<span className="text-detail text-muted-foreground">
					{entry.description}
				</span>
			</div>
			<div className="shrink-0">{renderAction()}</div>
		</div>
	);
}
