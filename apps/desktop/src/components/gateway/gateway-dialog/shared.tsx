import { SquareLock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { formatNumber as formatSharedNumber } from "@ryu/ui/lib/number-format.ts";
import { SettingsCard } from "@/src/components/settings/shared/settings-items.tsx";
import type { ProviderCircuitState } from "@/src/lib/api/gateway.ts";
import { StatTile, StatusText } from "../quiet.tsx";

/**
 * Banner shown atop a policy section when the caller lacks `gateway.configure`.
 * The write controls in that section are also disabled; this explains why.
 */
export function PolicyReadOnlyBanner() {
	return (
		<SettingsCard className="flex h-8 items-center gap-2 text-muted-foreground text-sm">
			<HugeiconsIcon className="size-4 shrink-0" icon={SquareLock01Icon} />
			<span className="truncate">
				Read-only. Ask a workspace admin for{" "}
				<span className="font-mono text-xs">gateway.configure</span>.
			</span>
		</SettingsCard>
	);
}

export function formatNumber(value: number): string {
	return formatSharedNumber(value);
}

export function formatPercent(rate: number): string {
	return `${(rate * 100).toFixed(1)}%`;
}

/**
 * One stat inside a metrics `SettingsCard`. No surface of its own: that card is
 * the only box, so a row of stats reads as one card, not tiles in a card.
 */
export function MetricTile({ label, value }: { label: string; value: string }) {
	return <StatTile label={label} value={value} />;
}

/**
 * A provider's circuit as quiet status text. A closed circuit is the normal
 * state and renders nothing; only an open or half-open breaker speaks up.
 */
export function CircuitStatus({
	state,
}: {
	state: ProviderCircuitState | undefined;
}) {
	const tl = useLiteralMessages();
	if (!state || state.circuit === "closed") {
		return null;
	}
	return (
		<StatusText tone={state.circuit === "open" ? "destructive" : "warning"}>
			{circuitBadgeLabel(state, tl)}
		</StatusText>
	);
}

export function circuitBadgeLabel(
	state: ProviderCircuitState | undefined,
	tl: LiteralMessage
): string {
	if (!state) {
		return "Up";
	}
	if (state.circuit === "open") {
		return state.openForSecs === null
			? "Open"
			: tl("Open ({openForSecs}s)", { openForSecs: String(state.openForSecs) });
	}
	if (state.circuit === "half_open") {
		return "Half-open";
	}
	return "Up";
}
