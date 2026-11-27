"use client";

import { MinusSignIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages, useOptionalI18n } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import { buttonVariants } from "@ryu/ui/components/button.tsx";
import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { pricingFormat } from "./data/standalone-pricing.ts";
import { landingContainerClass } from "./landing-typography.ts";
import {
	type ComparisonCell,
	type ComparisonOptions,
	type ComparisonPlanId,
	type ComparisonSection,
	comparisonPlans,
	comparisonSeats,
	comparisonSections,
	recommendedComparisonPlan,
} from "./pricing-comparison.ts";
import { priceRow } from "./pricing-comparison-rows.ts";
import { SectionHeading } from "./sections.tsx";

/** Below this width the table shows one plan at a time (Tailwind `md`). */
const ONE_PLAN_QUERY = "(max-width: 767px)";

/**
 * The header row stays under the site header while the table scrolls: the
 * section sets `--pricing-sticky-top` to the height of whatever is pinned to
 * the top of the window. The table is flat, with no borders: the header row
 * is a band on the raised (`muted`) shade, opaque so it hides the rows that
 * scroll under it.
 */
const STICKY_HEAD = "sticky top-[var(--pricing-sticky-top,0px)] z-20 bg-muted";

/**
 * The bottom edge of the bar pinned to the top of the window (the site
 * header), or 0 when nothing is pinned there. Read from the page, so the
 * table needs no knowledge of the host's header.
 */
function pinnedTopHeight(table: Element): number {
	const stack = document.elementsFromPoint?.(window.innerWidth / 2, 1) ?? [];
	for (const element of stack) {
		if (table.contains(element)) {
			continue;
		}
		const position = getComputedStyle(element).position;
		if (position === "sticky" || position === "fixed") {
			return Math.max(0, Math.round(element.getBoundingClientRect().bottom));
		}
	}
	return 0;
}

/** The recommended column sits on the raised shade from the header band down. */
const RECOMMENDED_COLUMN = "bg-muted";

/** Groups whose fold state the reader has flipped. */
const NO_TOGGLED: ReadonlySet<string> = new Set();

function CellValue({ value }: { value: ComparisonCell }) {
	if (value === true) {
		return (
			<>
				<span className="mx-auto flex size-5 items-center justify-center rounded-full bg-primary/10">
					<HugeiconsIcon
						aria-hidden="true"
						className="size-3.5 text-primary"
						icon={Tick02Icon}
						strokeWidth={2.5}
					/>
				</span>
				<span className="sr-only">Included</span>
			</>
		);
	}
	if (value === false) {
		return (
			<>
				<HugeiconsIcon
					aria-hidden="true"
					className="mx-auto size-4 text-muted-foreground/50"
					icon={MinusSignIcon}
					strokeWidth={2}
				/>
				<span className="sr-only">Not included</span>
			</>
		);
	}
	return <span className="tabular-nums">{value}</span>;
}

function ComparisonGroup({
	columnCount,
	columnClass,
	onToggle,
	open,
	planIds,
	section,
}: {
	columnClass: (plan: ComparisonPlanId) => string | false;
	columnCount: number;
	onToggle: () => void;
	open: boolean;
	planIds: readonly ComparisonPlanId[];
	section: ComparisonSection;
}) {
	return (
		<tbody data-comparison-section={section.id}>
			<tr>
				<th className="p-0 pt-3" colSpan={columnCount} scope="colgroup">
					<button
						aria-expanded={open}
						className="flex min-h-11 w-full items-center justify-between gap-3 px-4 text-start font-medium text-muted-foreground text-xs uppercase tracking-wide transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
						onClick={onToggle}
						type="button"
					>
						{section.title}
						<ChevronDown
							aria-hidden="true"
							className={cn(
								"size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none",
								open && "rotate-180"
							)}
						/>
					</button>
				</th>
			</tr>
			{section.rows.map((row) => (
				<tr data-comparison-row={row.id} hidden={!open} key={row.id}>
					<th
						className="px-4 py-3 text-start align-middle font-normal"
						scope="row"
					>
						<span className="block text-sm">{row.label}</span>
						{row.hint ? (
							<span className="mt-0.5 block text-pretty text-muted-foreground text-xs leading-snug">
								{row.hint}
							</span>
						) : null}
					</th>
					{planIds.map((plan) => (
						<td
							className={cn(
								"px-3 py-3 text-center align-middle text-sm",
								columnClass(plan)
							)}
							data-plan={plan}
							key={plan}
						>
							<CellValue value={row.values[plan]} />
						</td>
					))}
				</tr>
			))}
		</tbody>
	);
}

/**
 * "Compare plans": the detailed feature table under the pricing cards. Its
 * columns are the cards on screen for the selected audience (see
 * `comparisonPlans`), and every value comes from `./pricing-comparison.ts`.
 *
 * A real `<table>`: column headers are `scope="col"`, each feature label is a
 * `scope="row"` header, and each group title is a `scope="colgroup"` header
 * holding the button that folds the group. The header row, with each plan's
 * name and price, stays in view while the rows scroll. The page never scrolls
 * sideways: a phone shows one plan at a time, picked with the plan switcher,
 * and opens with only the first group unfolded.
 */
export function PricingComparisonTable(props: ComparisonOptions) {
	const tl = useLiteralMessages();
	const locale = useOptionalI18n()?.locale;
	const plans = comparisonPlans(props);
	const sections = comparisonSections(props, tl, locale);
	const seats = comparisonSeats(props.seats);
	const isOrganization = props.audience === "business";
	const recommended = recommendedComparisonPlan(props);
	const prices = priceRow(props.isYearly ?? false, seats, {
		format: pricingFormat(locale),
		tl,
	}).values;
	const [pickedPlan, setPickedPlan] = useState<ComparisonPlanId | null>(null);
	const shownPlan =
		plans.find((plan) => plan.id === pickedPlan) ??
		plans.find((plan) => plan.id === recommended) ??
		plans[0];
	const [narrow, setNarrow] = useState(false);
	const [toggled, setToggled] = useState(NO_TOGGLED);

	// A phone opens with only the first group unfolded, so the table starts short.
	useEffect(() => {
		setNarrow(window.matchMedia?.(ONE_PLAN_QUERY).matches ?? false);
	}, []);

	// Keep the sticky header row clear of the site header, whatever its height.
	const sectionRef = useRef<HTMLElement>(null);
	useEffect(() => {
		const section = sectionRef.current;
		if (!section) {
			return;
		}
		let frame = 0;
		const measure = () => {
			frame = 0;
			section.style.setProperty(
				"--pricing-sticky-top",
				`${pinnedTopHeight(section)}px`
			);
		};
		const schedule = () => {
			frame ||= requestAnimationFrame(measure);
		};
		measure();
		window.addEventListener("scroll", schedule, { passive: true });
		window.addEventListener("resize", schedule);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener("scroll", schedule);
			window.removeEventListener("resize", schedule);
		};
	}, []);

	const toggle = (id: string) =>
		setToggled((current) => {
			const next = new Set(current);
			if (!next.delete(id)) {
				next.add(id);
			}
			return next;
		});
	/** A group's resting state (all open; first only on a phone), flipped once per toggle. */
	const isOpen = (id: string, index: number) =>
		(narrow ? index === 0 : true) !== toggled.has(id);
	const columnClass = (plan: ComparisonPlanId) =>
		cn(
			plan !== shownPlan?.id && "max-md:hidden",
			plan === recommended && RECOMMENDED_COLUMN
		);

	return (
		<section
			aria-label="Compare plans"
			className={cn(landingContainerClass, "scroll-mt-20 py-12 md:py-16")}
			data-testid="pricing-comparison"
			id="compare-plans"
			ref={sectionRef}
		>
			<SectionHeading
				className="mb-8 md:mb-10"
				subtitle={
					isOrganization
						? tl(
								"Every limit and feature side by side. Organization prices and credits are shown for {seats} seats.",
								{ seats: String(seats) }
							)
						: "Every limit and feature side by side."
				}
				title="Compare plans"
			/>
			<div
				className="mb-4 flex justify-center md:hidden"
				data-testid="pricing-comparison-plan-switcher"
			>
				<Tabs
					onValueChange={(value) =>
						// SAFETY: the triggers below are exactly `plans`, whose ids are ComparisonPlanId.
						setPickedPlan(value as ComparisonPlanId)
					}
					value={shownPlan?.id}
				>
					<TabsList
						aria-label="Plan"
						className="flex-wrap justify-center"
						manageLayout={false}
						variant="pills"
					>
						{plans.map((plan) => (
							<TabsTrigger key={plan.id} value={plan.id}>
								{plan.name}
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>
			</div>
			<div className="overflow-clip rounded-2xl bg-card">
				<table className="w-full table-fixed border-collapse text-sm">
					<caption className="sr-only">
						{isOrganization
							? "Feature comparison of organization plans"
							: "Feature comparison of individual plans"}
					</caption>
					{/* On a phone the hidden plan cells are display:none, so they leave
					    the table grid and the one plan on screen always sits in the
					    first plan column. The group rows still span every column, so
					    the phone zeroes the other plan columns by position; otherwise
					    they keep a share of the width and squeeze the shown plan. */}
					<colgroup>
						<col className="w-[52%] md:w-[30%]" />
						{plans.map((plan, index) => (
							<col className={cn(index > 0 && "max-md:w-0")} key={plan.id} />
						))}
					</colgroup>
					<thead>
						<tr>
							<th className={cn(STICKY_HEAD, "w-[52%] md:w-[30%]")} scope="col">
								<span className="sr-only">Feature</span>
							</th>
							{plans.map((plan) => (
								<th
									className={cn(
										STICKY_HEAD,
										"px-3 py-3 text-center align-top font-medium",
										columnClass(plan.id)
									)}
									data-plan={plan.id}
									key={plan.id}
									scope="col"
								>
									<span className="block text-base">{plan.name}</span>
									<span className="mt-0.5 block font-normal text-muted-foreground text-xs tabular-nums">
										{prices[plan.id]}
									</span>
									{plan.id === recommended ? (
										<Badge className="mt-1.5" radius="pill" variant="default">
											Recommended
										</Badge>
									) : null}
								</th>
							))}
						</tr>
					</thead>
					{sections.map((section, index) => (
						<ComparisonGroup
							columnClass={columnClass}
							columnCount={plans.length + 1}
							key={section.id}
							onToggle={() => toggle(section.id)}
							open={isOpen(section.id, index)}
							planIds={plans.map((plan) => plan.id)}
							section={section}
						/>
					))}
				</table>
			</div>
			<div
				className="mt-6 flex flex-col items-center justify-between gap-4 rounded-2xl bg-card px-6 py-6 text-center sm:flex-row sm:text-start"
				data-testid="pricing-compare-cta"
			>
				<p className="text-balance font-heading font-medium text-xl tracking-tight">
					Ready to pick a plan?
				</p>
				<div className="flex flex-wrap items-center justify-center gap-3">
					<a className={cn(buttonVariants({ variant: "mono" }))} href="#plans">
						Choose a plan
					</a>
					{isOrganization ? (
						<Link
							className={cn(buttonVariants({ variant: "ghost" }))}
							href="/contact"
						>
							Talk to sales
						</Link>
					) : null}
				</div>
			</div>
		</section>
	);
}
