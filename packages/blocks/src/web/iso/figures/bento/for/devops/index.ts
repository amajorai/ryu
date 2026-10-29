import type { BentoDrawings } from "../../card.ts";
import { drawing as configDriftChecks } from "./config-drift-checks.tsx";
import { drawing as fixABrokenPipeline } from "./fix-a-broken-pipeline.tsx";
import { drawing as incidentTriage } from "./incident-triage.tsx";
import { drawing as infraAsCodeEdits } from "./infra-as-code-edits.tsx";
import { drawing as postmortemDrafts } from "./postmortem-drafts.tsx";
import { drawing as runbookAutomation } from "./runbook-automation.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Incident triage": incidentTriage,
	"Fix a broken pipeline": fixABrokenPipeline,
	"Infra as code edits": infraAsCodeEdits,
	"Config drift checks": configDriftChecks,
	"Runbook automation": runbookAutomation,
	"Postmortem drafts": postmortemDrafts,
};
