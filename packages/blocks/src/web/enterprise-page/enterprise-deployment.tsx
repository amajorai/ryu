import { cn } from "@ryu/ui/lib/utils";
import { docsHref } from "../data/resources.tsx";
import { landingSectionClass } from "../landing-typography.ts";
import { LinkArrow } from "../link-arrow.tsx";
import { ScrollRegion } from "../product-page/sections/scroll-region.tsx";
import { SECTION_ANCHOR_CLASS } from "../product-page/sections/section-nav.tsx";
import {
	ProductSectionHeader,
	sectionSurfaceClass,
} from "../product-page/sections/section-shell.tsx";
import {
	DEPLOYMENT_OPTIONS,
	DEPLOYMENT_ROWS,
} from "./enterprise-deployment-data.ts";
import { ENTERPRISE_DOCS } from "./enterprise-sources.ts";

const DEPLOYMENT_CAPTION =
	"Ryu Cloud, a Self-hosted Ryu Node, and a Private/Full Ryu Deployment compared";

const DEPLOYMENT_LINKS = [
	{ label: "How the open-core split works", path: ENTERPRISE_DOCS.openCore },
	{ label: "Ryu products and infra", path: ENTERPRISE_DOCS.infra },
] as const;

const linkClass =
	"group inline-flex min-h-10 items-center gap-1.5 font-medium text-foreground text-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Below md: one tinted card per option, its rows as a definition list, so a
 * phone never has to scroll a three-column table sideways.
 */
function DeploymentCards() {
	return (
		<ol
			className="grid gap-4 md:hidden"
			data-testid="enterprise-deployment-cards"
		>
			{DEPLOYMENT_OPTIONS.map((option, index) => (
				<li
					className={cn(sectionSurfaceClass, "p-6")}
					data-product-card=""
					key={option.id}
				>
					<p className="font-mono text-muted-foreground text-xs tabular-nums">
						{String(index + 1).padStart(2, "0")}
					</p>
					<h3 className="mt-2 font-heading font-medium text-base text-foreground">
						{option.name}
					</h3>
					<p className="mt-1 text-muted-foreground text-sm">{option.summary}</p>
					<dl className="mt-5 flex flex-col gap-4">
						{DEPLOYMENT_ROWS.map((row) => (
							<div className="flex flex-col gap-1" key={row.label}>
								<dt className="text-muted-foreground text-xs">{row.label}</dt>
								<dd className="text-pretty text-foreground text-sm leading-relaxed">
									{row.cells[index]?.text}
								</dd>
							</div>
						))}
					</dl>
				</li>
			))}
		</ol>
	);
}

/**
 * Ryu Cloud, a Self-hosted Ryu Node and a Private/Full Ryu Deployment side by
 * side: a real table (column and row headers) from md up, cards below it.
 */
export function EnterpriseDeployment() {
	return (
		<section
			className={cn(landingSectionClass, SECTION_ANCHOR_CLASS)}
			data-testid="enterprise-deployment"
			id="deployment"
		>
			<ProductSectionHeader
				kicker="Deployment"
				subtitle="Choose Ryu Cloud, run a Self-hosted Ryu Node, or operate the full private deployment."
				title="Run it where your policy says"
			/>
			<DeploymentCards />
			<ScrollRegion className="hidden md:block" label={DEPLOYMENT_CAPTION}>
				<table
					className="w-full min-w-xl border-collapse text-start text-sm"
					data-column-count={DEPLOYMENT_OPTIONS.length}
				>
					<caption className="sr-only">{DEPLOYMENT_CAPTION}</caption>
					<thead>
						<tr className="border-border border-b align-bottom">
							<th className="w-1/5 py-4 pe-6" scope="col">
								<span className="sr-only">Compare</span>
							</th>
							{DEPLOYMENT_OPTIONS.map((option, index) => (
								<th
									className="px-4 py-4 font-normal"
									data-deployment-option={option.id}
									key={option.id}
									scope="col"
								>
									<span className="block font-mono text-muted-foreground text-xs tabular-nums">
										{String(index + 1).padStart(2, "0")}
									</span>
									<span className="mt-2 block font-heading font-medium text-base text-foreground">
										{option.name}
									</span>
									<span className="mt-1 block text-muted-foreground text-sm">
										{option.summary}
									</span>
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{DEPLOYMENT_ROWS.map((row) => (
							<tr className="border-border border-b align-top" key={row.label}>
								<th
									className="py-4 pe-6 font-normal text-muted-foreground"
									scope="row"
								>
									{row.label}
								</th>
								{row.cells.map((cell, index) => (
									<td
										className="text-pretty px-4 py-4 text-foreground leading-relaxed"
										// Cells are positional: they line up with DEPLOYMENT_OPTIONS.
										key={DEPLOYMENT_OPTIONS[index]?.id ?? index}
									>
										{cell.text}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</ScrollRegion>
			<ul className="mt-8 flex flex-wrap gap-x-8 gap-y-2">
				{DEPLOYMENT_LINKS.map((link) => (
					<li key={link.path}>
						<a
							className={linkClass}
							href={docsHref(link.path)}
							rel="noopener noreferrer"
							target="_blank"
						>
							{link.label}
							<LinkArrow className="text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:rtl:-translate-x-0.5" />
						</a>
					</li>
				))}
			</ul>
		</section>
	);
}
