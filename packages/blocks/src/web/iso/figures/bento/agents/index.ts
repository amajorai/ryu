import type { BentoDrawings } from "../card.ts";
import { drawing as oneModelPerJob } from "./one-model-per-job.tsx";
import { drawing as promptVersionsKept } from "./prompt-versions-kept.tsx";
import { drawing as shareAsAnApp } from "./share-as-an-app.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"One model per job": oneModelPerJob,
	"Prompt versions kept": promptVersionsKept,
	"Share as an App": shareAsAnApp,
};
