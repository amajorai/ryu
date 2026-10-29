import type { BentoDrawings } from "../../card.ts";
import { drawing as candidateOutreach } from "./candidate-outreach.tsx";
import { drawing as interviewPrepAndDebriefs } from "./interview-prep-and-debriefs.tsx";
import { drawing as interviewScheduling } from "./interview-scheduling.tsx";
import { drawing as jobDescriptionAndRubricDrafting } from "./job-description-and-rubric-drafting.tsx";
import { drawing as pipelineStatusReports } from "./pipeline-status-reports.tsx";
import { drawing as resumeScreening } from "./resume-screening.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Resume screening": resumeScreening,
	"Interview scheduling": interviewScheduling,
	"Candidate outreach": candidateOutreach,
	"Job description and rubric drafting": jobDescriptionAndRubricDrafting,
	"Interview prep and debriefs": interviewPrepAndDebriefs,
	"Pipeline status reports": pipelineStatusReports,
};
