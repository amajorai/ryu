import { cn } from "@ryu/ui/lib/utils";
import type {
	ProductStatusItem,
	ProductStatusBoard as StatusBoard,
} from "../profile-types.ts";
import { ProductSection, ProductSectionHeader } from "./section-shell.tsx";

export type StatusColumnId = "today" | "planned" | "not-planned";

/** Column headings. Planned work is labelled as not a commitment, per the roadmap docs. */
export const STATUS_COLUMN_TITLES: Readonly<Record<StatusColumnId, string>> = {
	today: "Available today",
	planned: "Planned (not a commitment)",
	"not-planned": "Not planned",
};

const COLUMN_MARKERS: Readonly<Record<StatusColumnId, string>> = {
	today: "bg-foreground",
	planned: "border border-foreground border-dashed",
	"not-planned": "border border-muted-foreground",
};

function StatusColumn({
	id,
	items,
}: {
	id: StatusColumnId;
	items: readonly ProductStatusItem[];
}) {
	return (
		<li
			className={cn(
				"flex min-w-0 flex-col rounded-2xl p-6",
				id === "today" ? "bg-muted/60" : "bg-muted/25"
			)}
			data-product-card=""
			data-product-card-tone={id === "today" ? undefined : "quiet"}
			data-status-column={id}
		>
			<h3 className="flex items-center gap-2.5 font-heading font-medium text-base text-foreground">
				<span
					aria-hidden="true"
					className={cn("size-2.5 shrink-0 rounded-full", COLUMN_MARKERS[id])}
				/>
				{STATUS_COLUMN_TITLES[id]}
			</h3>
			<ul className="mt-5 space-y-3">
				{items.map((item) => (
					<li
						className={cn(
							"text-pretty text-sm leading-relaxed",
							id === "today" ? "text-foreground" : "text-muted-foreground"
						)}
						key={item.text}
					>
						{item.text}
					</li>
				))}
			</ul>
		</li>
	);
}

/**
 * Preview products are honest about where they stand: what works today, what
 * the docs list as planned, and (where the docs say so) what is not planned.
 */
export function ProductStatusBoard({ status }: { status: StatusBoard }) {
	const columns: { id: StatusColumnId; items: readonly ProductStatusItem[] }[] =
		[
			{ id: "today", items: status.today },
			{ id: "planned", items: status.planned },
			{ id: "not-planned", items: status.notPlanned ?? [] },
		];
	const shown = columns.filter((column) => column.items.length > 0);
	if (shown.length === 0) {
		return null;
	}
	return (
		<ProductSection testId="product-status-board">
			<ProductSectionHeader kicker="Status" title="Where it stands" />
			<ul
				className={cn(
					"grid gap-3",
					shown.length >= 2 && "md:grid-cols-2",
					shown.length >= 3 && "lg:grid-cols-3"
				)}
			>
				{shown.map((column) => (
					<StatusColumn id={column.id} items={column.items} key={column.id} />
				))}
			</ul>
		</ProductSection>
	);
}
