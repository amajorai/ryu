import type { BentoDrawings } from "../../card.ts";
import { drawing as adHocDataPulls } from "./ad-hoc-data-pulls.tsx";
import { drawing as dashboardSummaries } from "./dashboard-summaries.tsx";
import { drawing as dataQualityChecks } from "./data-quality-checks.tsx";
import { drawing as metricInvestigation } from "./metric-investigation.tsx";
import { drawing as queryExplanation } from "./query-explanation.tsx";
import { drawing as recurringReports } from "./recurring-reports.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Ad hoc data pulls": adHocDataPulls,
	"Metric investigation": metricInvestigation,
	"Dashboard summaries": dashboardSummaries,
	"Data quality checks": dataQualityChecks,
	"Recurring reports": recurringReports,
	"Query explanation": queryExplanation,
};
