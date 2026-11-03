"use client";

import { useLiteralMessages, useLocalizedText } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { type ReactNode, useId, useState } from "react";

/** One category filter: its label, its row count and its server-rendered panel. */
export interface ProductsIndexTab {
	readonly count: number;
	readonly id: string;
	readonly label: string;
	readonly panel: ReactNode;
}

const ALL_ID = "all";

/** A literal string through the catalog; the hook's ReactNode is a string here. */
function useLiteral(value: string): string {
	const localized = useLocalizedText(value, { literal: true });
	return typeof localized === "string" ? localized : value;
}

function FilterButton({
	count,
	id,
	label,
	onSelect,
	pressed,
}: {
	count: number;
	id: string;
	label: string;
	onSelect: (id: string) => void;
	pressed: boolean;
}) {
	return (
		<button
			aria-pressed={pressed}
			className={cn(
				"flex min-h-10 shrink-0 items-center gap-2 rounded-full px-4 font-medium text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				pressed
					? "bg-foreground text-background"
					: "bg-muted/50 text-muted-foreground hover:text-foreground"
			)}
			data-products-index-filter={id}
			onClick={() => onSelect(id)}
			type="button"
		>
			<span>{label}</span>
			<span
				className={cn(
					"font-mono text-xs tabular-nums",
					pressed ? "text-background/70" : "text-muted-foreground"
				)}
			>
				{count}
			</span>
		</button>
	);
}

/**
 * "1 product", "5 products" as one ICU plural, so the visitor's plural rules
 * pick the form. A client island because the server tables render the same
 * count and the DOM localizer only rewrites simple `{name}` templates.
 */
export function ProductCount({ count }: { count: number }) {
	const tl = useLiteralMessages();
	return (
		<>{tl("{count, plural, one {# product} other {# products}}", { count })}</>
	);
}

/**
 * The /products category filter: a group of toggle buttons ("All" first), and
 * a live count of the products shown. Every category's table is rendered on
 * the server and switched with `hidden`, so all rows stay in the HTML for
 * crawlers and for visitors without JavaScript (who see "All"). Each category
 * section names itself with its own heading, so nothing points at a button.
 */
export function ProductsIndexTabs({
	tabs,
	label = "Filter products by category",
}: {
	tabs: readonly ProductsIndexTab[];
	/** Accessible name of the filter group. */
	label?: string;
}) {
	const tl = useLiteralMessages();
	const [filter, setFilter] = useState<string>(ALL_ID);
	const statusId = useId();
	const groupLabel = useLiteral(label);
	const allLabel = useLiteral("All");
	const total = tabs.reduce((sum, tab) => sum + tab.count, 0);
	const shown =
		filter === ALL_ID
			? total
			: (tabs.find((tab) => tab.id === filter)?.count ?? 0);

	return (
		<div>
			<div
				aria-describedby={statusId}
				aria-label={groupLabel}
				className="-mx-6 flex gap-2 overflow-x-auto px-6 pb-1"
				role="group"
			>
				<FilterButton
					count={total}
					id={ALL_ID}
					label={allLabel}
					onSelect={setFilter}
					pressed={filter === ALL_ID}
				/>
				{tabs.map((tab) => (
					<FilterButton
						count={tab.count}
						id={tab.id}
						key={tab.id}
						label={tl(tab.label)}
						onSelect={setFilter}
						pressed={filter === tab.id}
					/>
				))}
			</div>
			<p
				aria-live="polite"
				className="mt-3 font-mono text-muted-foreground text-xs"
				data-products-index-status=""
				id={statusId}
			>
				<ProductCount count={shown} />
			</p>
			<div className="mt-10 space-y-16 md:mt-12 md:space-y-20">
				{tabs.map((tab) => (
					<div
						className="min-w-0"
						data-products-index-panel={tab.id}
						hidden={filter !== ALL_ID && filter !== tab.id}
						key={tab.id}
					>
						{tab.panel}
					</div>
				))}
			</div>
		</div>
	);
}
