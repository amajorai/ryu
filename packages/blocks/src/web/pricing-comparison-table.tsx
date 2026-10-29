import { MinusSignIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type ComparisonCell,
	type ComparisonOptions,
	comparisonPlans,
	comparisonSeats,
	comparisonSections,
} from "./pricing-comparison.ts";

/** The sticky first column keeps row labels in view while plans scroll. */
const STICKY_COLUMN =
	"sticky left-0 z-10 bg-background shadow-[1px_0_0_var(--color-border)]";

function CellValue({ value }: { value: ComparisonCell }) {
	if (value === true) {
		return (
			<>
				<HugeiconsIcon
					aria-hidden="true"
					className="mx-auto size-4 text-primary"
					icon={Tick02Icon}
					strokeWidth={2}
				/>
				<span className="sr-only">Included</span>
			</>
		);
	}
	if (value === false) {
		return (
			<>
				<HugeiconsIcon
					aria-hidden="true"
					className="mx-auto size-4 text-muted-foreground/60"
					icon={MinusSignIcon}
					strokeWidth={2}
				/>
				<span className="sr-only">Not included</span>
			</>
		);
	}
	return <span className="tabular-nums">{value}</span>;
}

/**
 * "Compare plans": the detailed feature table under the pricing cards. Its
 * columns are the cards on screen for the selected audience (see
 * `comparisonPlans`), and every value comes from `./pricing-comparison.ts`.
 *
 * A real `<table>`: column headers are `scope="col"`, each feature label is a
 * `scope="row"` header, and each section title is a `scope="colgroup"` header.
 * On narrow screens the table scrolls inside its own container with the label
 * column pinned, so the page itself never scrolls sideways.
 */
export function PricingComparisonTable(props: ComparisonOptions) {
	const tl = useLiteralMessages();
	const plans = comparisonPlans(props);
	const sections = comparisonSections(props);
	const seats = comparisonSeats(props.seats);
	const isOrganization = props.audience === "business";

	return (
		<section
			aria-labelledby="plan-comparison-heading"
			className="mx-auto mb-16 max-w-6xl"
			data-testid="pricing-comparison"
			id="compare-plans"
		>
			<h2
				className="font-medium text-2xl tracking-tight md:text-3xl"
				id="plan-comparison-heading"
			>
				Compare plans
			</h2>
			<p className="mt-3 max-w-3xl text-muted-foreground text-sm leading-relaxed sm:text-base">
				{isOrganization
					? tl(
							"Every limit and feature side by side. Organization prices and credits are shown for {seats} seats.",
							{ seats: String(seats) }
						)
					: "Every limit and feature side by side."}
			</p>
			<div className="mt-6 overflow-hidden rounded-2xl border border-border/60">
				<Table className="min-w-[40rem] table-fixed">
					<TableCaption className="sr-only">
						{isOrganization
							? "Feature comparison of organization plans"
							: "Feature comparison of individual plans"}
					</TableCaption>
					<TableHeader>
						<TableRow appearance="header">
							<TableHead
								className={cn(STICKY_COLUMN, "w-44 sm:w-64")}
								scope="col"
							>
								<span className="sr-only">Feature</span>
							</TableHead>
							{plans.map((plan) => (
								<TableHead
									className="whitespace-normal text-center"
									key={plan.id}
									scope="col"
								>
									{plan.name}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					{sections.map((section) => (
						<TableBody data-comparison-section={section.id} key={section.id}>
							<TableRow appearance="header" className="bg-muted/40">
								<TableHead
									className="h-10 text-muted-foreground text-xs uppercase tracking-wide"
									colSpan={plans.length + 1}
									scope="colgroup"
								>
									<span className="sticky left-3">{section.title}</span>
								</TableHead>
							</TableRow>
							{section.rows.map((row) => (
								<TableRow
									appearance="header"
									data-comparison-row={row.id}
									key={row.id}
								>
									<TableHead
										className={cn(
											STICKY_COLUMN,
											"h-auto whitespace-normal py-3 font-normal"
										)}
										scope="row"
									>
										<span className="block text-sm">{row.label}</span>
										{row.hint ? (
											<span className="mt-0.5 block text-muted-foreground text-xs">
												{row.hint}
											</span>
										) : null}
									</TableHead>
									{plans.map((plan) => (
										<TableCell
											className="whitespace-normal text-center"
											data-plan={plan.id}
											key={plan.id}
										>
											<CellValue value={row.values[plan.id]} />
										</TableCell>
									))}
								</TableRow>
							))}
						</TableBody>
					))}
				</Table>
			</div>
		</section>
	);
}
