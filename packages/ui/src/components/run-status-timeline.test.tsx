import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	RunStatusTimeline,
	RunStatusTimelineLegend,
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
