import {
	formatCurrency,
	formatCount as formatSharedCount,
} from "@ryu/ui/lib/number-format.ts";
import type { ProfileFeatureUnlock } from "./profile-settings-types.ts";

export const SECONDS_PER_HOUR = 3600;

const joinedDateFormatter = new Intl.DateTimeFormat("en-US", {
	month: "long",
	year: "numeric",
});

export const formatCompact = (value: number): string =>
	formatSharedCount(value) ?? "—";

export const formatCost = (microUsd: number): string => {
	const dollars = microUsd / 1_000_000;
	if (dollars < 0.01 && dollars > 0) {
		return "<$0.01";
	}
	return formatCurrency(dollars, "USD", {
		maximumFractionDigits: dollars >= 10 ? 0 : 2,
	});
};

export const formatHourUtc = (hour: string | null | undefined): string =>
	hour ? `${hour}:00 UTC` : "Not enough data";

export const formatJoined = (joinedAt?: string): string | null => {
	if (!joinedAt) {
		return null;
	}
	const parsed = new Date(joinedAt);
	if (Number.isNaN(parsed.getTime())) {
		return null;
	}
	return joinedDateFormatter.format(parsed);
};

export const tierBadgeVariant = (
	tier: ProfileFeatureUnlock["tier"]
): "default" | "secondary" | "outline" => {
	if (tier === "paid") {
		return "default";
	}
	if (tier === "progressive") {
		return "secondary";
	}
	return "outline";
};

export const tierLabel = (tier: ProfileFeatureUnlock["tier"]): string => {
	if (tier === "paid") {
		return "Paid";
	}
	if (tier === "progressive") {
		return "Points";
	}
	return "Included";
};
