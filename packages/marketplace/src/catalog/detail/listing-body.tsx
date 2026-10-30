import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Body pieces
// ---------------------------------------------------------------------------

/** A titled block in either column. One heading treatment for all ten realms. */
export function ListingSection({
	title,
	icon,
	action,
	children,
}: {
	title: ReactNode;
	icon?: IconSvgElement;
	/** Trailing control on the heading row (a "see all", a toggle). */
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="flex flex-col gap-2">
			<div className="flex items-center justify-between gap-2">
				<h3 className="flex items-center gap-1.5 font-medium text-sm">
					{icon ? (
						<HugeiconsIcon
							className="size-4 text-muted-foreground"
							icon={icon}
						/>
					) : null}
					{title}
				</h3>
				{action}
			</div>
			{children}
		</section>
	);
}

/** A section in the right rail: a section title over its rows. No fill and no
 *  outline; the rail is set off from the main column by whitespace alone, so the
 *  dialog never carries a card inside a card. */
export function ListingAsideCard({
	title,
	children,
}: {
	title?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section>
			{title ? <h3 className="mb-1 font-semibold text-sm">{title}</h3> : null}
			{children}
		</section>
	);
}

export interface ListingInfoRow {
	label: string;
	value: ReactNode;
}

/** The Information table. A label/value grid rather than the old two-column flex
 *  row, so a long value (a licence name, a homepage host) wraps under its label
 *  instead of squeezing it to two characters. */
export function ListingInfoGrid({ rows }: { rows: ListingInfoRow[] }) {
	if (rows.length === 0) {
		return null;
	}
	return (
		<dl className="flex flex-col text-sm">
			{rows.map((row) => (
				<div
					className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0"
					key={row.label}
				>
					<dt className="shrink-0 text-muted-foreground text-xs">
						{row.label}
					</dt>
					<dd className="min-w-0 truncate text-right font-medium text-xs">
						{row.value}
					</dd>
				</div>
			))}
		</dl>
	);
}
