import Link from "next/link";
import {
	type Product,
	type ProductCategory,
	productCategories,
	productStatusLabel,
	productsByCategory,
} from "./data/products.tsx";
import { landingSubheadlineClass } from "./landing-typography.ts";
import { nextLinkHref } from "./next-link-href.ts";
import { SectionTitle } from "./section-title.tsx";

/** One line per group, drawn from the taglines of the available products inside it. */
const GROUP_LINES: Record<ProductCategory, string> = {
	Workspaces: "Give real work to agents from your desktop and browser.",
	Build: "Build your own agents, workflows, and tools.",
	Platform: "The runtime, gateway, and managed cloud every agent runs on.",
	"Agent APIs": "Email inboxes your own product can give its agents.",
};

/**
 * Categories shown inside another group on this index. A one-product "Agent APIs"
 * group reads as a stub, so its available products join Platform here; the
 * catalogue categories themselves are unchanged.
 */
const MERGED_INTO: Partial<Record<ProductCategory, ProductCategory>> = {
	"Agent APIs": "Platform",
};

/** Platform's line once the agent APIs sit inside it. */
const PLATFORM_WITH_APIS_LINE =
	"The runtime, gateway, managed cloud, and agent APIs your product builds on.";

/** Bot and Agent have their own short routes; everything else is under /products. */
const SHORT_ROUTES = new Map([
	["bot", "/bot"],
	["agent", "/agent"],
]);

export function productHref(product: Product): string {
	return SHORT_ROUTES.get(product.slug) ?? `/products/${product.slug}`;
}

function isAvailable(product: Product): boolean {
	return productStatusLabel(product) === undefined;
}

const linkClass =
	"group block rounded-sm outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring";

const quietLineLinkClass =
	"text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2";

function ProductName({ product }: { product: Product }) {
	return (
		<>
			<span className="font-heading font-medium text-base text-foreground underline-offset-4 group-hover:underline">
				{product.name}
			</span>
			<span
				aria-hidden="true"
				className="ml-1 text-muted-foreground transition-colors group-hover:text-foreground"
			>
				→
			</span>
		</>
	);
}

/** An available product: its name and one-line tagline. */
function ProductLink({ product }: { product: Product }) {
	return (
		<li>
			<Link className={linkClass} href={nextLinkHref(productHref(product))}>
				<ProductName product={product} />
				<span className="mt-1.5 block text-pretty text-[15px] text-muted-foreground leading-relaxed">
					{product.tagline}
				</span>
			</Link>
		</li>
	);
}

function ProductGroup({
	line,
	products,
	title,
}: {
	line: string;
	products: readonly Product[];
	title: string;
}) {
	return (
		<div data-product-group={title}>
			<SectionTitle title={title} />
			<p className={landingSubheadlineClass}>{line}</p>
			<ul className="mt-10 grid gap-x-12 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
				{products.map((product) => (
					<ProductLink key={product.slug} product={product} />
				))}
			</ul>
		</div>
	);
}

/**
 * Products the /download page already offers as installable (it links the
 * Chrome Web Store listing), so the closing line does not present them as
 * still to come.
 */
const LISTED_ELSEWHERE = new Set(["chrome-extension"]);

/** How many early-access products the closing line names before "and more". */
const EARLY_ACCESS_NAMED = 4;

/**
 * One quiet sentence for everything not yet generally available, built from
 * the early-access products; the rest stay reachable from the header nav.
 */
function EarlyAccessLine({ products }: { products: readonly Product[] }) {
	const named = products.slice(0, EARLY_ACCESS_NAMED);
	if (named.length === 0) {
		return null;
	}
	const more = products.length > named.length;
	return (
		<p
			className="text-pretty text-[15px] text-muted-foreground leading-relaxed"
			data-product-group="Early access"
		>
			Also in early access:{" "}
			{named.map((product, index) => (
				<span key={product.slug}>
					<Link
						className={quietLineLinkClass}
						href={nextLinkHref(productHref(product))}
					>
						{product.name}
					</Link>
					{index < named.length - 1 || more ? ", " : "."}
				</span>
			))}
			{more ? "and more." : null}
		</p>
	);
}

/** The two paid plans, linked once under the catalogue. */
function PlansLine() {
	return (
		<p
			className="text-pretty text-[15px] text-muted-foreground leading-relaxed"
			data-product-group="Plans"
		>
			Plans:{" "}
			<Link className={quietLineLinkClass} href="/pro">
				Ryu Pro
			</Link>
			,{" "}
			<Link className={quietLineLinkClass} href="/teams">
				Ryu Teams
			</Link>
			.
		</p>
	);
}

interface OverviewGroup {
	category: ProductCategory;
	line: string;
	products: Product[];
}

/** Available products per shown group, with merged categories folded in. */
function overviewGroups(
	visible: (product: Product) => boolean
): OverviewGroup[] {
	const groups = new Map<ProductCategory, OverviewGroup>();
	for (const category of productCategories) {
		const target = MERGED_INTO[category] ?? category;
		const available = productsByCategory(category)
			.filter(visible)
			.filter(isAvailable);
		const group = groups.get(target) ?? {
			category: target,
			line: GROUP_LINES[target],
			products: [],
		};
		group.products.push(...available);
		if (target === "Platform" && category !== target && available.length > 0) {
			group.line = PLATFORM_WITH_APIS_LINE;
		}
		groups.set(target, group);
	}
	return [...groups.values()].filter((group) => group.products.length > 0);
}

/**
 * The /products index. Each group lists only what people can use today; the
 * early-access products and the plans follow the last group as quiet lines.
 */
export function ProductsOverview({
	hiddenSlugs = [],
}: {
	/**
	 * Product slugs the host has not rolled out (for example a standalone
	 * service whose rollout flag is off). They are left out of the listing; the
	 * product data itself is never edited to hide one.
	 */
	hiddenSlugs?: readonly string[];
}) {
	const hidden = new Set(hiddenSlugs);
	const visible = (product: Product) => !hidden.has(product.slug);
	const earlyAccess = productCategories.flatMap((category) =>
		productsByCategory(category)
			.filter(visible)
			.filter(
				(product) =>
					product.status === "early-access" &&
					!LISTED_ELSEWHERE.has(product.slug)
			)
	);
	return (
		<div>
			<div className="space-y-20 md:space-y-28">
				{overviewGroups(visible).map((group) => (
					<ProductGroup
						key={group.category}
						line={group.line}
						products={group.products}
						title={group.category}
					/>
				))}
			</div>
			<div className="mt-10 space-y-2">
				<EarlyAccessLine products={earlyAccess} />
				<PlansLine />
			</div>
		</div>
	);
}
