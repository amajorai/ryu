import { cn } from "@ryu/ui/lib/utils";
import Link from "next/link";
import { getProduct } from "../data/products.tsx";
import { landingSectionClass } from "../landing-typography.ts";
import { nextLinkHref } from "../next-link-href.ts";
import { productHref } from "../products-overview.tsx";
import { NumberedSteps, SectionHeading } from "../sections.tsx";
import type { ProductAudience, ProductExplainer } from "./explainer-types.ts";

// The explainer sections a product page carries around its capabilities, each
// rendered only when the product's explainer sets it (see ./explainers.ts).

const itemTitleClass = "font-heading font-medium text-base text-foreground";
const itemDescriptionClass =
	"text-muted-foreground text-[15px] leading-relaxed";

/** Splits a paragraph after its first sentence, so the lead can stand out. */
function leadSentence(statement: string): [string, string] {
	const match = statement.match(/^(.+?[.!?:])\s+(.*)$/s);
	return match ? [match[1] ?? statement, match[2] ?? ""] : [statement, ""];
}

/** "What it is": one large paragraph, its first sentence in the foreground. */
export function ProductStatement({ statement }: { statement: string }) {
	const [lead, rest] = leadSentence(statement);
	return (
		<section
			aria-labelledby="product-statement-heading"
			className={landingSectionClass}
			data-testid="product-statement"
		>
			<h2
				className="font-medium text-muted-foreground text-sm"
				id="product-statement-heading"
			>
				What it is
			</h2>
			<p className="mt-6 max-w-4xl text-balance font-heading font-medium text-2xl text-foreground leading-snug tracking-[-0.02em] md:text-3xl md:leading-snug">
				{lead}
				{rest ? <span className="text-muted-foreground"> {rest}</span> : null}
			</p>
		</section>
	);
}

export function ProductHowItWorks({
	steps,
	title = "How it works",
}: {
	steps: NonNullable<ProductExplainer["steps"]>;
	title?: string;
}) {
	return (
		<section className={landingSectionClass} data-testid="product-how-it-works">
			<SectionHeading title={title} />
			<NumberedSteps steps={[...steps]} />
		</section>
	);
}

export function ProductBuiltFor({
	audiences,
}: {
	audiences: readonly ProductAudience[];
}) {
	return (
		<section className={landingSectionClass} data-testid="product-built-for">
			<SectionHeading title="Built for" />
			<ul
				className={cn(
					"grid gap-x-12 gap-y-10 border-border border-t pt-10 sm:grid-cols-2",
					audiences.length >= 3 && "lg:grid-cols-3"
				)}
			>
				{audiences.map((audience) => (
					<li key={audience.title}>
						<h3 className={itemTitleClass}>{audience.title}</h3>
						<p className={cn("mt-2", itemDescriptionClass)}>
							{audience.description}
						</p>
					</li>
				))}
			</ul>
		</section>
	);
}

/** Related products as quiet ruled rows: name, tagline, arrow. */
export function ProductWorksWith({ slugs }: { slugs: readonly string[] }) {
	const related = slugs.flatMap((slug) => {
		const product = getProduct(slug);
		return product ? [product] : [];
	});
	if (related.length === 0) {
		return null;
	}
	return (
		<section className={landingSectionClass} data-testid="product-works-with">
			<SectionHeading title="Works with" />
			<ul className="border-border border-t">
				{related.map((product) => (
					<li className="border-border border-b" key={product.slug}>
						<Link
							className="group grid gap-1 py-5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[12rem_1fr_auto] sm:items-baseline sm:gap-8"
							data-cuelume-hover="tick"
							href={nextLinkHref(productHref(product))}
						>
							<span className={itemTitleClass}>{product.name}</span>
							<span className={itemDescriptionClass}>{product.tagline}</span>
							<span
								aria-hidden="true"
								className="hidden text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground sm:inline"
							>
								→
							</span>
						</Link>
					</li>
				))}
			</ul>
		</section>
	);
}
