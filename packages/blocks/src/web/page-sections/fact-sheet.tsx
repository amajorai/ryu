import { cn } from "@ryu/ui/lib/utils";
import Link from "next/link";
import type { ReactNode } from "react";
import { nextLinkHref } from "../next-link-href.ts";

/** One label/value pair. `external` opens the link in a new tab. */
export interface FactSheetFact {
	readonly external?: boolean;
	readonly href?: string;
	readonly label: string;
	readonly value: string;
}

const COLUMN_CLASSES = {
	2: "sm:grid-cols-2",
	3: "sm:grid-cols-2 lg:grid-cols-3",
	4: "sm:grid-cols-2 lg:grid-cols-4",
} as const;

export type FactSheetColumns = keyof typeof COLUMN_CLASSES;

const linkClass =
	"underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function FactValue({ fact }: { fact: FactSheetFact }): ReactNode {
	if (!fact.href) {
		return fact.value;
	}
	if (fact.external) {
		return (
			<a
				className={linkClass}
				href={fact.href}
				rel="noopener noreferrer"
				target="_blank"
			>
				{fact.value}
			</a>
		);
	}
	return (
		<Link className={linkClass} href={nextLinkHref(fact.href)}>
			{fact.value}
		</Link>
	);
}

/**
 * A spec sheet: ruled label/value cells in a responsive grid, as a `<dl>`.
 * Callers own the surrounding `<section>`; the optional title is a small muted
 * heading (h2 by default) so the values carry the weight. Renders nothing for
 * an empty list.
 */
export function FactSheet({
	facts,
	title,
	headingLevel: Heading = "h2",
	columns = 3,
	testId,
	className,
}: {
	facts: readonly FactSheetFact[];
	title?: string;
	headingLevel?: "h2" | "h3";
	columns?: FactSheetColumns;
	testId?: string;
	className?: string;
}) {
	if (facts.length === 0) {
		return null;
	}
	return (
		<div className={className} data-testid={testId}>
			{title ? (
				<Heading className="font-medium text-muted-foreground text-sm">
					{title}
				</Heading>
			) : null}
			<dl
				className={cn(
					"grid gap-x-10 border-border border-t",
					title && "mt-6",
					COLUMN_CLASSES[columns]
				)}
			>
				{facts.map((fact) => (
					<div
						className="flex min-w-0 flex-col gap-1.5 border-border border-b py-5"
						// A `data-slot` keeps the row rule: public-pages.css strips
						// borders from unslotted content divs.
						data-slot="fact-sheet-row"
						key={fact.label}
					>
						<dt className="text-muted-foreground text-sm">{fact.label}</dt>
						<dd className="text-pretty break-words font-heading font-medium text-base text-foreground leading-snug">
							<FactValue fact={fact} />
						</dd>
					</div>
				))}
			</dl>
		</div>
	);
}
