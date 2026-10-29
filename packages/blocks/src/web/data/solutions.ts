import { z } from "zod";
import type { CtaLink } from "../sections.tsx";
import sol_accounting from "./solutions/accounting.json" with { type: "json" };
import sol_bookkeeping from "./solutions/bookkeeping.json" with {
	type: "json",
};
import sol_compliance from "./solutions/compliance.json" with { type: "json" };
import sol_consulting from "./solutions/consulting.json" with { type: "json" };
import sol_content_writing from "./solutions/content-writing.json" with {
	type: "json",
};
import sol_copywriting from "./solutions/copywriting.json" with {
	type: "json",
};
import sol_customer_success from "./solutions/customer-success.json" with {
	type: "json",
};
import sol_customer_support from "./solutions/customer-support.json" with {
	type: "json",
};
import sol_data_analyst from "./solutions/data-analyst.json" with {
	type: "json",
};
import sol_data_science from "./solutions/data-science.json" with {
	type: "json",
};
import sol_design from "./solutions/design.json" with { type: "json" };
import sol_devops from "./solutions/devops.json" with { type: "json" };
import sol_editing from "./solutions/editing.json" with { type: "json" };
import sol_education from "./solutions/education.json" with { type: "json" };
import sol_executive_assistant from "./solutions/executive-assistant.json" with {
	type: "json",
};
import sol_finance from "./solutions/finance.json" with { type: "json" };
import sol_growth from "./solutions/growth.json" with { type: "json" };
import sol_healthcare from "./solutions/healthcare.json" with { type: "json" };
import sol_hr from "./solutions/hr.json" with { type: "json" };
import sol_insurance from "./solutions/insurance.json" with { type: "json" };
import sol_it_support from "./solutions/it-support.json" with { type: "json" };
import sol_legal from "./solutions/legal.json" with { type: "json" };
import sol_marketing from "./solutions/marketing.json" with { type: "json" };
import sol_operations from "./solutions/operations.json" with { type: "json" };
import sol_paralegal from "./solutions/paralegal.json" with { type: "json" };
import sol_procurement from "./solutions/procurement.json" with {
	type: "json",
};
import sol_product_management from "./solutions/product-management.json" with {
	type: "json",
};
import sol_qa from "./solutions/qa.json" with { type: "json" };
import sol_real_estate from "./solutions/real-estate.json" with {
	type: "json",
};
import sol_recruiting from "./solutions/recruiting.json" with { type: "json" };
import sol_research from "./solutions/research.json" with { type: "json" };
import sol_sales from "./solutions/sales.json" with { type: "json" };
import sol_software_engineer from "./solutions/software-engineer.json" with {
	type: "json",
};
import sol_tax from "./solutions/tax.json" with { type: "json" };
import sol_translation from "./solutions/translation.json" with {
	type: "json",
};

/* Shared CTAs (mirror comparisons.ts / products.tsx) --------------- */

export const EARLY_ACCESS = {
	label: "Get early access",
	href: "https://j14.notion.site/2940023f0e838023810ce36edf2e3893?pvs=105" as const,
	external: true,
} satisfies CtaLink;
export const BOOK_DEMO = {
	label: "Book a demo",
	href: "https://cal.com/amajor/ryu-demo",
	external: true,
} as const satisfies CtaLink;
export const DOWNLOAD = {
	label: "Download",
	href: "/download" as const,
} satisfies CtaLink;

/* Types ------------------------------------------------------------ */

export interface SolutionUseCase {
	description: string;
	title: string;
}

export interface SolutionFaq {
	a: string;
	q: string;
}

export interface Solution {
	faq: SolutionFaq[];
	heroTitle: string;
	/** lucide-react icon name, resolved in solutions-sections.tsx */
	icon: string;
	name: string;
	/** Plural audience for roles named after a person ("paralegals"). */
	pluralPhrase?: string;
	slug: string;
	tagline: string;
	useCases: SolutionUseCase[];
	/** product/visuals key, resolved via compare's visualFor() */
	visualKey: string;
}

const solutionFieldsSchema = z.object({
	faq: z.array(z.object({ a: z.string(), q: z.string() })),
	heroTitle: z.string(),
	icon: z.string(),
	name: z.string(),
	pluralPhrase: z.string().optional(),
	slug: z.string(),
	tagline: z.string(),
	useCases: z.array(z.object({ description: z.string(), title: z.string() })),
	visualKey: z.string(),
}) satisfies z.ZodType<Solution>;
// Bundled content is validated at its import boundary; retain the original
// JSON objects and nested arrays used by the static page catalog.
const solutionRecordSchema = z.custom<Solution>(
	(value) => solutionFieldsSchema.safeParse(value).success
);
const solutionRowsSchema = z.custom<Solution[]>(
	(value) => z.array(solutionRecordSchema).safeParse(value).success
);

/* Data ------------------------------------------------------------- */
/* Each role is a pure JSON file in ./solutions.                      */
/* New entries are appended here once their JSON file exists.         */

export const solutions = solutionRowsSchema.parse([
	sol_sales,
	sol_marketing,
	sol_growth,
	sol_customer_support,
	sol_customer_success,
	sol_content_writing,
	sol_copywriting,
	sol_editing,
	sol_translation,
	sol_finance,
	sol_accounting,
	sol_bookkeeping,
	sol_tax,
	sol_insurance,
	sol_legal,
	sol_paralegal,
	sol_compliance,
	sol_hr,
	sol_recruiting,
	sol_operations,
	sol_executive_assistant,
	sol_procurement,
	sol_real_estate,
	sol_healthcare,
	sol_education,
	sol_consulting,
	sol_research,
	sol_software_engineer,
	sol_devops,
	sol_qa,
	sol_it_support,
	sol_data_analyst,
	sol_data_science,
	sol_product_management,
	sol_design,
]);

/* Groups (the /for index) ------------------------------------------ */

export const SOLUTION_GROUPS = [
	{
		title: "Go-to-market",
		slugs: [
			"sales",
			"marketing",
			"growth",
			"customer-support",
			"customer-success",
		],
	},
	{
		title: "Writing",
		slugs: ["content-writing", "copywriting", "editing", "translation"],
	},
	{
		title: "Finance & Legal",
		slugs: [
			"finance",
			"accounting",
			"bookkeeping",
			"tax",
			"legal",
			"paralegal",
			"compliance",
		],
	},
	{
		title: "Operations & People",
		slugs: [
			"hr",
			"recruiting",
			"operations",
			"executive-assistant",
			"procurement",
			"consulting",
			"research",
		],
	},
	{
		title: "Engineering & Data",
		slugs: [
			"software-engineer",
			"devops",
			"qa",
			"it-support",
			"data-analyst",
			"data-science",
			"product-management",
			"design",
		],
	},
	{
		title: "Industries",
		slugs: ["healthcare", "real-estate", "education", "insurance"],
	},
] as const satisfies readonly { slugs: readonly string[]; title: string }[];

export type SolutionGroupTitle = (typeof SOLUTION_GROUPS)[number]["title"];

/* Helpers ---------------------------------------------------------- */

export const solutionMap: Record<string, Solution> = Object.fromEntries(
	solutions.map((s) => [s.slug, s])
);

export function getSolution(slug: string): Solution | undefined {
	return solutionMap[slug];
}

/** The /for index groups, each resolved to its roles in display order. */
export function solutionGroups(): {
	solutions: Solution[];
	title: SolutionGroupTitle;
}[] {
	return SOLUTION_GROUPS.map((group) => ({
		title: group.title,
		solutions: group.slugs.flatMap((slug) => {
			const solution = solutionMap[slug];
			return solution ? [solution] : [];
		}),
	}));
}

/**
 * The role name for use mid-sentence: lowercased, except acronyms and
 * internally capitalised words ("IT Support" → "IT support", "DevOps").
 */
export function solutionPhrase(name: string): string {
	return name
		.split(" ")
		.map((word) => (/[A-Z]/.test(word.slice(1)) ? word : word.toLowerCase()))
		.join(" ");
}

/**
 * Who the role page addresses mid-sentence: the authored plural for roles
 * named after a person ("paralegals"), otherwise "<role> teams".
 */
export function solutionAudience(
	solution: Pick<Solution, "name" | "pluralPhrase">
): string {
	return solution.pluralPhrase ?? `${solutionPhrase(solution.name)} teams`;
}
