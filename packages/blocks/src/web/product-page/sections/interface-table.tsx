import { cn } from "@ryu/ui/lib/utils";
import Link from "next/link";
import type { ReactNode } from "react";
import { nextLinkHref } from "../../next-link-href.ts";
import type { ProductInterfaceRow } from "../profile-types.ts";
import {
	ProductSection,
	ProductSectionHeader,
	sectionChipClass,
	sectionKickerClass,
} from "./section-shell.tsx";

const linkClass =
	"underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function InterfaceName({ row }: { row: ProductInterfaceRow }): ReactNode {
	if (!row.href) {
		return row.name;
	}
	if (/^https?:/.test(row.href)) {
		return (
			<a
				className={linkClass}
				href={row.href}
				rel="noopener noreferrer"
				target="_blank"
			>
				{row.name}
			</a>
		);
	}
	return (
		<Link className={linkClass} href={nextLinkHref(row.href)}>
			{row.name}
		</Link>
	);
}

/** "Available" needs no label; an unreleased interface says so in words. */
function InterfaceStatus({ row }: { row: ProductInterfaceRow }) {
	if (row.status !== "not-published") {
		return null;
	}
	return (
		<span className="mt-2 block text-muted-foreground text-xs">
			<span className="font-medium text-foreground">Not published yet.</span>{" "}
			{row.note}
		</span>
	);
}

/**
 * "Ways to call it": every interface a service exposes (REST, MCP, SDK, CLI,
 * webhooks). `compact` renders a stacked list for a half-width column; the
 * default is a full table with the kind, name and what it is for.
 */
export function ProductInterfaceTable({
	rows,
	title = "Ways to call it",
	compact = false,
}: {
	rows: readonly ProductInterfaceRow[];
	title?: string;
	compact?: boolean;
}) {
	if (rows.length === 0) {
		return null;
	}
	if (compact) {
		return (
			<ProductSection testId="product-interfaces">
				<h2 className={cn(sectionKickerClass, "mb-4")}>{title}</h2>
				<ul className="border-border border-t">
					{rows.map((row) => (
						<li
							className="grid gap-2 border-border border-b py-4 sm:grid-cols-[7rem_1fr] sm:gap-4"
							data-interface-kind={row.kind}
							key={`${row.kind}-${row.name}`}
						>
							<span>
								<span className={sectionChipClass}>{row.kind}</span>
							</span>
							<span className="min-w-0">
								<span className="block font-medium text-foreground text-sm">
									<InterfaceName row={row} />
								</span>
								<span className="mt-1 block text-pretty text-muted-foreground text-sm leading-relaxed">
									{row.summary}
								</span>
								<InterfaceStatus row={row} />
							</span>
						</li>
					))}
				</ul>
			</ProductSection>
		);
	}
	return (
		<ProductSection testId="product-interfaces">
			<ProductSectionHeader kicker="Interfaces" title={title} />
			<div
				aria-label={title}
				className="overflow-x-auto rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				role="region"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: the table scrolls sideways on phones and holds no focusable element, so keyboard users focus the frame to scroll it (WCAG 2.1.1).
				tabIndex={0}
			>
				<table className="w-full min-w-xl border-border border-t text-start text-sm">
					<caption className="sr-only">{title}</caption>
					<thead>
						<tr className="border-border border-b text-muted-foreground">
							<th className="w-32 py-3 pe-6 font-medium" scope="col">
								Kind
							</th>
							<th className="py-3 pe-6 font-medium" scope="col">
								Interface
							</th>
							<th className="py-3 font-medium" scope="col">
								What it is for
							</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr
								className="border-border border-b align-top"
								data-interface-kind={row.kind}
								key={`${row.kind}-${row.name}`}
							>
								<td className="py-4 pe-6">
									<span className={sectionChipClass}>{row.kind}</span>
								</td>
								<th
									className="py-4 pe-6 font-medium text-foreground"
									scope="row"
								>
									<InterfaceName row={row} />
								</th>
								<td className="text-pretty py-4 text-muted-foreground leading-relaxed">
									{row.summary}
									<InterfaceStatus row={row} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</ProductSection>
	);
}
