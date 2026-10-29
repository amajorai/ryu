import type { BentoDrawings } from "../../card.ts";
import { drawing as adVariationSets } from "./ad-variation-sets.tsx";
import { drawing as campaignCopyInOneWorkflow } from "./campaign-copy-in-one-workflow.tsx";
import { drawing as emailSubjectLines } from "./email-subject-lines.tsx";
import { drawing as landingPageCopy } from "./landing-page-copy.tsx";
import { drawing as productAndFeatureNaming } from "./product-and-feature-naming.tsx";
import { drawing as toneAndLengthRewrites } from "./tone-and-length-rewrites.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Ad variation sets": adVariationSets,
	"Landing page copy": landingPageCopy,
	"Email subject lines": emailSubjectLines,
	"Product and feature naming": productAndFeatureNaming,
	"Tone and length rewrites": toneAndLengthRewrites,
	"Campaign copy in one workflow": campaignCopyInOneWorkflow,
};
