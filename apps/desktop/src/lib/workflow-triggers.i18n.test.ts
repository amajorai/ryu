import { expect, it } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { ScheduledJob } from "@/src/lib/api/schedules.ts";
import { triggerTooltip } from "./workflow-triggers.tsx";

const MINUTE_MS = 60_000;

const JA: Record<string, string> = {
	"Runs every {every} · next {nextRun}": "{every} ごとに実行 · 次回 {nextRun}",
	"Runs manually": "手動で実行",
	"Runs on an app event (none selected)": "アプリイベントで実行（未選択）",
};

const japanese: LiteralMessage = (source, values) =>
	formatMessage(JA[source] ?? source, values);

/**
 * A job whose hourly schedule next fires 12 minutes 20 seconds from now, so
 * both the floored locale phrase and the rounded English form read 12.
 */
function hourlyJobDueSoon(): ScheduledJob {
	return {
		lastRunAt: new Date(Date.now() - 48 * MINUTE_MS + 20_000).toISOString(),
	} as ScheduledJob;
}

it("phrases the next run in Japanese, not as an English 'in 12m'", () => {
	const tip = triggerTooltip(
		{ type: "schedule", every: "1h" },
		hourlyJobDueSoon(),
		japanese,
		"ja"
	);
	expect(tip).toBe("1h ごとに実行 · 次回 12 分後");
	expect(tip).not.toContain("in 12m");
});

it("uses the German relative phrase for the next run", () => {
	const tip = triggerTooltip(
		{ type: "schedule", every: "1h" },
		hourlyJobDueSoon(),
		undefined,
		"de"
	);
	expect(tip).toBe("Runs every 1h · next in 12 Minuten");
});

it("keeps the compact English next run in English", () => {
	const tip = triggerTooltip(
		{ type: "schedule", every: "1h" },
		hourlyJobDueSoon(),
		undefined,
		"en"
	);
	expect(tip).toBe("Runs every 1h · next in 12m");
});

it("translates the manual and unselected-event fallbacks", () => {
	expect(triggerTooltip({ type: "manual" }, null, japanese, "ja")).toBe(
		"手動で実行"
	);
	expect(
		triggerTooltip({ type: "event", event: "" }, null, japanese, "ja")
	).toBe("アプリイベントで実行（未選択）");
});
