import type { BentoDrawings } from "../../card.ts";
import { drawing as briefToOutline } from "./brief-to-outline.tsx";
import { drawing as contentGapAnalysis } from "./content-gap-analysis.tsx";
import { drawing as draftIntoYourCms } from "./draft-into-your-cms.tsx";
import { drawing as repurposeIntoANewsletter } from "./repurpose-into-a-newsletter.tsx";
import { drawing as researchedBlogPost } from "./researched-blog-post.tsx";
import { drawing as whitepaperAndReportSections } from "./whitepaper-and-report-sections.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Researched blog post": researchedBlogPost,
	"Brief to outline": briefToOutline,
	"Whitepaper and report sections": whitepaperAndReportSections,
	"Repurpose into a newsletter": repurposeIntoANewsletter,
	"Content gap analysis": contentGapAnalysis,
	"Draft into your CMS": draftIntoYourCms,
};
