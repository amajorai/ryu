import type { BentoDrawings } from "../../card.ts";
import { drawing as fixAFailingBuild } from "./fix-a-failing-build.tsx";
import { drawing as implementAFeature } from "./implement-a-feature.tsx";
import { drawing as resumeAPastSession } from "./resume-a-past-session.tsx";
import { drawing as reviewAPullRequest } from "./review-a-pull-request.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Implement a feature": implementAFeature,
	"Fix a failing build": fixAFailingBuild,
	"Review a pull request": reviewAPullRequest,
	"Resume a past session": resumeAPastSession,
};
