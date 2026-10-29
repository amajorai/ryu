import type { Cpu } from "lucide-react";
import type { ReactNode } from "react";
import type { ProductFigureId } from "../product-figure.tsx";
import type { BentoItem, CtaLink, FeatureSplit } from "../sections.tsx";

/** Canonical product taxonomy, shared with the nav and the /products index. */
export type ProductCategory =
	| "Workspaces"
	| "Build"
	| "Platform"
	| "Agent APIs";

/** Pre-release label for products that are not generally available. */
export type ProductStatus = "early-access" | "coming-soon";

export interface Product {
	bento: {
		title: string;
		subtitle?: string;
		items: BentoItem[];
	};
	category: ProductCategory;
	cta: {
		title: string;
		subtitle: string;
		primaryCta: CtaLink;
		secondaryCta?: CtaLink;
		note?: string;
	};
	faq?: { q: string; a: string }[];
	/** An interactive anatomy figure shown full width after the hero. */
	figure?: ProductFigureId;
	hero: {
		eyebrow: string;
		title: string;
		subtitle: string;
		primaryCta: CtaLink;
		secondaryCta?: CtaLink;
		visual: ReactNode;
	};
	Icon: typeof Cpu;
	name: string;
	navLabel: string;
	overviewVisual?: ReactNode;
	slug: string;
	splits?: FeatureSplit[];
	standalone?: boolean;
	status?: ProductStatus;
	tagline: string;
}
