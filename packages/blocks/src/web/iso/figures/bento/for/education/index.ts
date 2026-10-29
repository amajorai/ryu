import type { BentoDrawings } from "../../card.ts";
import { drawing as curriculumQuestions } from "./curriculum-questions.tsx";
import { drawing as feedbackDrafts } from "./feedback-drafts.tsx";
import { drawing as lessonPlanning } from "./lesson-planning.tsx";
import { drawing as materialAdaptation } from "./material-adaptation.tsx";
import { drawing as parentCommunication } from "./parent-communication.tsx";
import { drawing as practiceAndQuizGeneration } from "./practice-and-quiz-generation.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Lesson planning": lessonPlanning,
	"Practice and quiz generation": practiceAndQuizGeneration,
	"Feedback drafts": feedbackDrafts,
	"Material adaptation": materialAdaptation,
	"Curriculum questions": curriculumQuestions,
	"Parent communication": parentCommunication,
};
