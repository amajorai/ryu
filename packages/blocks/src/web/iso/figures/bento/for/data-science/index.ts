import type { BentoDrawings } from "../../card.ts";
import { drawing as experimentWriteUps } from "./experiment-write-ups.tsx";
import { drawing as exploratoryAnalysis } from "./exploratory-analysis.tsx";
import { drawing as featureEngineering } from "./feature-engineering.tsx";
import { drawing as literatureGrounding } from "./literature-grounding.tsx";
import { drawing as modelEvaluation } from "./model-evaluation.tsx";
import { drawing as reproducibilityChecks } from "./reproducibility-checks.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Exploratory analysis": exploratoryAnalysis,
	"Feature engineering": featureEngineering,
	"Model evaluation": modelEvaluation,
	"Experiment write-ups": experimentWriteUps,
	"Literature grounding": literatureGrounding,
	"Reproducibility checks": reproducibilityChecks,
};
