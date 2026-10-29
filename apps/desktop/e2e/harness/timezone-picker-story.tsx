// Standalone browser story for the REAL Appearance → "Date & time" row
// (`src/components/settings/TimezoneSetting.tsx`), which is the app's only
// consumer of the shared `Combobox`. A searchable ~450-item list is exactly the
// shape that half-works when the item stringifier is wrong — the trigger shows
// a label but filtering matches nothing, or vice versa — so it earns a real
// browser rather than a render test.
//
// The row is mounted beside a live timestamp formatted through the same
// `formatDateTime` every surface in the app uses, so the spec can assert the
// preference actually reaches the formatters and not just the trigger.

import { createRoot } from "react-dom/client";
import { TimezoneSetting } from "@/src/components/settings/TimezoneSetting.tsx";
import { useTimezoneRevision } from "@/src/hooks/useTimezone.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import "../../src/index.css";

/** A fixed instant so the spec can assert an exact rendering per zone. */
const SAMPLE = Date.parse("2026-01-15T23:30:00.000Z");

function SampleStamp() {
	// Subscribes so the sample repaints the instant the zone changes — the same
	// contract the sidebar rows rely on.
	useTimezoneRevision();
	return (
		<p data-testid="sample-stamp">
			{formatDateTime(SAMPLE, {
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				hourCycle: "h23",
			})}
		</p>
	);
}

createRoot(document.getElementById("root")!).render(
	<div className="min-h-screen bg-background p-8 text-foreground">
		<div className="mx-auto w-[42rem]">
			<TimezoneSetting />
			<SampleStamp />
		</div>
	</div>
);
