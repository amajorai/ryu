import { describe, expect, it } from "bun:test";
import { messageIdForLiteral } from "@ryu/i18n/core";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	RunStatusTimeline,
	RunStatusTimelineLegend,
	runStatusHourLabel,
} from "./run-status-timeline.tsx";

const START_AT = Date.parse("2026-08-30T00:00:00.000Z");
const END_AT = Date.parse("2026-08-31T00:00:00.000Z");

describe("RunStatusTimeline", () => {
	it("renders colored runs on a labeled 24-hour axis", () => {
		const markup = renderToStaticMarkup(
			<RunStatusTimeline
				ariaLabel="Run status for August 30"
				endAt={END_AT}
				entries={[
					{
						endAt: START_AT + 5 * 60 * 60 * 1000 + 10 * 60 * 1000,
						id: "success",
						label: "Morning digest succeeded",
						startAt: START_AT + 5 * 60 * 60 * 1000,
						status: "success",
					},
					{
						endAt: START_AT + 12 * 60 * 60 * 1000 + 5 * 60 * 1000,
						id: "failure",
						label: "Health check failed",
						startAt: START_AT + 12 * 60 * 60 * 1000,
						status: "failure",
					},
					{
						id: "scheduled",
						label: "Weekly report scheduled",
						startAt: START_AT + 18 * 60 * 60 * 1000,
						status: "scheduled",
					},
				]}
				showScale
				startAt={START_AT}
			/>
		);

		expect(markup).toContain('data-slot="run-status-timeline"');
		expect(markup).toContain('aria-label="Run status for August 30"');
		expect(markup).toContain("bg-success");
		expect(markup).toContain("bg-destructive");
		expect(markup).toContain("bg-warning");
		expect(markup).toContain("00:00");
		expect(markup).toContain("24:00");
		expect(markup).toContain('title="Morning digest succeeded"');
	});

	it("renders the shared status legend labels", () => {
		const markup = renderToStaticMarkup(
			<RunStatusTimelineLegend
				statuses={["success", "failure", "scheduled", "waiting"]}
			/>
		);

		expect(markup).toContain('aria-label="Run status legend"');
		expect(markup).toContain("Succeeded");
		expect(markup).toContain("Failed");
		expect(markup).toContain("Scheduled");
		expect(markup).toContain("Awaiting input");
	});
});

it("does not perform now-marker arithmetic for runtime values outside the visible window", () => {
	for (const nowAt of [
		undefined,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		START_AT,
		END_AT,
		Symbol("invalid clock"),
		{
			valueOf() {
				throw new Error("Clock must not be coerced");
			},
		},
	]) {
		// SAFETY: This adversarial runtime test deliberately violates the numeric prop contract to prove the marker never coerces rejected values.
		const element = RunStatusTimeline({
			ariaLabel: "Timeline",
			startAt: START_AT,
			endAt: END_AT,
			entries: [],
			nowAt: nowAt as number,
		});
		const markup = renderToStaticMarkup(element);
		expect(markup).not.toContain("bg-foreground/70");
	}
	const markup = renderToStaticMarkup(
		<RunStatusTimeline
			ariaLabel="Timeline"
			endAt={END_AT}
			entries={[]}
			nowAt={(START_AT + END_AT) / 2}
			startAt={START_AT}
		/>
	);
	expect(markup).toContain("--timeline-left:50%");
	expect(markup).toContain("bg-foreground/70");
});

describe("RunStatusTimeline direction and hour labels", () => {
	it("keeps the time axis left-to-right inside a right-to-left page", () => {
		const markup = renderToStaticMarkup(
			<div dir="rtl">
				<RunStatusTimeline
					ariaLabel="Timeline"
					endAt={END_AT}
					entries={[
						{
							endAt: START_AT + 30 * 60 * 1000,
							id: "midnight",
							label: "Midnight run succeeded",
							startAt: START_AT,
							status: "success",
						},
					]}
					showScale
					startAt={START_AT}
				/>
			</div>
		);

		const wrapper = markup.match(
			/<div[^>]*data-slot="run-status-timeline"[^>]*>/
		);
		expect(wrapper?.[0]).toContain('dir="ltr"');
		// The run at hour 0 starts at the left edge, and the first scale label
		// (on the left edge under the isolated LTR axis) is midnight.
		expect(markup).toContain("--timeline-left:0%");
		const labels = [...markup.matchAll(/<span>([^<]+)<\/span>/g)].map(
			(match) => match[1]
		);
		expect(labels).toEqual(["00:00", "06:00", "12:00", "18:00", "24:00"]);
	});

	it("formats hour labels with the locale's separator and digits", () => {
		// English keeps its 24-hour axis, unchanged.
		expect(runStatusHourLabel("en", 0)).toBe("00:00");
		expect(runStatusHourLabel("en-US", 18)).toBe("18:00");
		expect(runStatusHourLabel("en-US", 24)).toBe("24:00");
		expect(runStatusHourLabel("de", 6)).toBe("06:00");
		expect(runStatusHourLabel("ja", 24)).toBe("24:00");
		expect(runStatusHourLabel("fi", 24)).toBe("24.00");
		expect(runStatusHourLabel("ar-EG", 6)).toBe("٠٦:٠٠");
		expect(runStatusHourLabel("ar-EG", 24)).toBe("٢٤:٠٠");
		expect(runStatusHourLabel("fa-IR", 0)).toBe("۰۰:۰۰");
		expect(runStatusHourLabel("fa-IR", 24)).toBe("۲۴:۰۰");
	});

	it("keeps the empty-state summary for screen readers", () => {
		const markup = renderToStaticMarkup(
			<RunStatusTimeline
				ariaLabel="Timeline"
				endAt={END_AT}
				entries={[]}
				startAt={START_AT}
			/>
		);
		expect(markup).toContain("No runs recorded in this 24-hour period.");
	});
});

const EMPTY_SUMMARY = "No runs recorded in this 24-hour period.";
const ARABIC_PACK = {
	baseLocale: "ar-EG",
	direction: "rtl" as const,
	id: "community/run-status-timeline-ar",
	locale: "ar-EG",
	messages: { [messageIdForLiteral(EMPTY_SUMMARY)]: "لا توجد عمليات" },
	name: "Run status timeline",
	schemaVersion: 1 as const,
	version: "1.0.0",
};

it("renders an Arabic pack's summary and digits on a left-to-right axis", () => {
	const markup = renderToStaticMarkup(
		<I18nProvider initialPackId={ARABIC_PACK.id} packs={[ARABIC_PACK]}>
			<RunStatusTimeline
				ariaLabel="Timeline"
				endAt={END_AT}
				entries={[]}
				showScale
				startAt={START_AT}
			/>
		</I18nProvider>
	);
	expect(markup).toContain("لا توجد عمليات");
	expect(markup).not.toContain(EMPTY_SUMMARY);
	expect(markup).toContain('dir="ltr"');
	expect(markup).toContain("<span>٠٠:٠٠</span>");
	expect(markup).toContain("<span>٢٤:٠٠</span>");
});
