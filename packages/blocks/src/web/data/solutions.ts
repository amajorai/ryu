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

export const EARLY_ACCESS: CtaLink = {
	label: "Get Early Access",
	href: "https://j14.notion.site/2940023f0e838023810ce36edf2e3893?pvs=105",
	external: true,
};
export const BOOK_DEMO: CtaLink = {
	label: "Book a Demo",
	href: "https://cal.com/jiaweing/ryu-demo",
	external: true,
};
export const DOWNLOAD: CtaLink = { label: "Download", href: "/download" };

/* Types ------------------------------------------------------------ */

export type SolutionCategory =
	| "Sales & Marketing"
	| "Finance & Risk"
	| "Legal & Compliance"
	| "People & Operations"
	| "Language & Content"
	| "Engineering & Product"
	| "Industries";

export interface SolutionHighlight {
	description: string;
	title: string;
}

export interface SolutionUseCase {
	description: string;
	title: string;
}

export interface SolutionFaq {
	a: string;
	q: string;
}

export interface Solution {
	category: SolutionCategory;
	ctaNote: string;
	ctaSubtitle: string;
	ctaTitle: string;
	examplePrompts: string[];
	faq: SolutionFaq[];
	heroEyebrow: string;
	heroSubtitle: string;
	heroTitle: string;
	highlights: SolutionHighlight[];
	/** lucide-react icon name, resolved in components/solutions/sections.tsx */
	icon: string;
	intro: string;
	name: string;
	navLabel: string;
	slug: string;
	tagline: string;
	useCases: SolutionUseCase[];
	/** product/visuals key, resolved via compare's visualFor() */
	visualKey: string;
}

/* Data ------------------------------------------------------------- */
/* Each role is a pure JSON file in src/data/solutions.               */
/* New entries are appended here once their JSON file exists.         */

export const solutions: Solution[] = [
	// Sales & Marketing
	sol_sales as Solution,
	sol_marketing as Solution,
	sol_customer_support as Solution,
	sol_customer_success as Solution,
	sol_growth as Solution,
	// Finance & Risk
	sol_accounting as Solution,
	sol_finance as Solution,
	sol_insurance as Solution,
	sol_tax as Solution,
	sol_bookkeeping as Solution,
	// Legal & Compliance
	sol_legal as Solution,
	sol_compliance as Solution,
	sol_paralegal as Solution,
	// People & Operations
	sol_hr as Solution,
	sol_recruiting as Solution,
	sol_executive_assistant as Solution,
	sol_operations as Solution,
	sol_procurement as Solution,
	// Language & Content
	sol_translation as Solution,
	sol_content_writing as Solution,
	sol_copywriting as Solution,
	sol_editing as Solution,
	// Engineering & Product
	sol_software_engineer as Solution,
	sol_data_analyst as Solution,
	sol_data_science as Solution,
	sol_devops as Solution,
	sol_qa as Solution,
	sol_product_management as Solution,
	sol_design as Solution,
	sol_it_support as Solution,
	// Industries
	sol_real_estate as Solution,
	sol_healthcare as Solution,
	sol_education as Solution,
	sol_consulting as Solution,
	sol_research as Solution,
];

/* Helpers ---------------------------------------------------------- */

export const solutionMap: Record<string, Solution> = Object.fromEntries(
	solutions.map((s) => [s.slug, s])
);

export function getSolution(slug: string): Solution | undefined {
	return solutionMap[slug];
}

export const solutionCategories: SolutionCategory[] = [
	"Sales & Marketing",
	"Finance & Risk",
	"Legal & Compliance",
	"People & Operations",
	"Language & Content",
	"Engineering & Product",
	"Industries",
];

export function solutionsByCategory(category: SolutionCategory): Solution[] {
	return solutions.filter((s) => s.category === category);
}
