// apps/desktop/src/components/usage-rail/usage-rail-tone.ts
//
// The tone of a usage reading, by how much is used: calm, then amber from 70%,
// then red from 90%. The same thresholds as the other usage meters, so a ring
// and a picker badge never disagree about one account.

const WARNING_FROM = 70;
const CRITICAL_FROM = 90;

export type UsageTone = "calm" | "critical" | "warning";

export function usageTone(usedPercent: number): UsageTone {
	if (usedPercent >= CRITICAL_FROM) {
		return "critical";
	}
	return usedPercent >= WARNING_FROM ? "warning" : "calm";
}

const TONE_CLASSES: Record<
	UsageTone,
	{ arc: string; fill: string; track: string }
> = {
	calm: {
		arc: "stroke-success",
		fill: "bg-success",
		track: "bg-success/20",
	},
	critical: {
		arc: "stroke-destructive",
		fill: "bg-destructive",
		track: "bg-destructive/20",
	},
	warning: {
		arc: "stroke-warning",
		fill: "bg-warning",
		track: "bg-warning/20",
	},
};

/** The stroke of a ring arc and the fill and track of a card bar. */
export function usageToneClasses(usedPercent: number): {
	arc: string;
	fill: string;
	track: string;
} {
	return TONE_CLASSES[usageTone(usedPercent)];
}
