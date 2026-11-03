import Link from "next/link";
import { docsHref } from "../../data/resources.tsx";
import { LinkArrow } from "../../link-arrow.tsx";
import { nextLinkHref } from "../../next-link-href.ts";
import type {
	ProductRelatedKind,
	ProductRelatedLink,
} from "../profile-types.ts";
import {
	ProductSection,
	ProductSectionHeader,
	sectionChipClass,
} from "./section-shell.tsx";

export const RELATED_KIND_LABELS: Readonly<Record<ProductRelatedKind, string>> =
	{
		guide: "Guide",
		help: "Help",
		blog: "Blog",
		docs: "Docs",
	};

const rowClass =
	"group grid gap-2 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[6rem_1fr_auto] sm:items-center sm:gap-6";

function RelatedRow({ link }: { link: ProductRelatedLink }) {
	const body = (
		<>
			<span>
				<span className={sectionChipClass}>
					{RELATED_KIND_LABELS[link.kind]}
				</span>
			</span>
			<span className="font-medium text-foreground text-sm md:text-base">
				{link.label}
			</span>
			<LinkArrow className="hidden text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground sm:inline-block group-hover:rtl:-translate-x-0.5" />
		</>
	);
	if (link.kind === "docs") {
		return (
			<a
				className={rowClass}
				href={docsHref(link.href)}
				rel="noopener noreferrer"
				target="_blank"
			>
				{body}
			</a>
		);
	}
	return (
		<Link className={rowClass} href={nextLinkHref(link.href)}>
			{body}
		</Link>
	);
}

/** Curated further reading (guides, help articles, posts, docs) as ruled rows. */
export function ProductRelatedLinks({
	links,
}: {
	links: readonly ProductRelatedLink[];
}) {
	if (links.length === 0) {
		return null;
	}
	return (
		<ProductSection testId="product-related">
			<ProductSectionHeader size="small" title="Related reading" />
			<ul className="border-border border-t">
				{links.map((link) => (
					<li className="border-border border-b" key={link.href}>
						<RelatedRow link={link} />
					</li>
				))}
			</ul>
		</ProductSection>
	);
}
