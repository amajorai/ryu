import type { BentoDrawings } from "../../card.ts";
import { drawing as adHocDataQuestions } from "./ad-hoc-data-questions.tsx";
import { drawing as boardAndInvestorDecks } from "./board-and-investor-decks.tsx";
import { drawing as cashFlowAndRunway } from "./cash-flow-and-runway.tsx";
import { drawing as forecastAndModelBuilding } from "./forecast-and-model-building.tsx";
import { drawing as spendAndBudgetReview } from "./spend-and-budget-review.tsx";
import { drawing as varianceAndPerformanceAnalysis } from "./variance-and-performance-analysis.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Variance and performance analysis": varianceAndPerformanceAnalysis,
	"Forecast and model building": forecastAndModelBuilding,
	"Board and investor decks": boardAndInvestorDecks,
	"Cash flow and runway": cashFlowAndRunway,
	"Ad hoc data questions": adHocDataQuestions,
	"Spend and budget review": spendAndBudgetReview,
};
