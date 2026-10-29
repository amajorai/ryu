import type { BentoDrawings } from "../../card.ts";
import { drawing as bugReproduction } from "./bug-reproduction.tsx";
import { drawing as coverageGapAnalysis } from "./coverage-gap-analysis.tsx";
import { drawing as edgeCaseDiscovery } from "./edge-case-discovery.tsx";
import { drawing as endToEndFlows } from "./end-to-end-flows.tsx";
import { drawing as testPlanFromAFeature } from "./test-plan-from-a-feature.tsx";
import { drawing as unitAndIntegrationTests } from "./unit-and-integration-tests.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Test plan from a feature": testPlanFromAFeature,
	"Unit and integration tests": unitAndIntegrationTests,
	"Edge case discovery": edgeCaseDiscovery,
	"Bug reproduction": bugReproduction,
	"End-to-end flows": endToEndFlows,
	"Coverage gap analysis": coverageGapAnalysis,
};
