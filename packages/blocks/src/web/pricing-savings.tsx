"use client";

import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { Checkbox } from "@ryu/ui/components/checkbox";
import { Input } from "@ryu/ui/components/input";
import { NumberTicker } from "@ryu/ui/components/number-ticker";
import PageHeader from "@ryu/ui/components/page-header.tsx";
import { formatCurrency } from "@ryu/ui/lib/number-format.ts";
import { useMemo, useState } from "react";
import {
	annualTotalPrice,
	effectiveMonthlyPrice,
	TEAMS_MIN_SEATS,
} from "./pricing.tsx";

/**
 * The "what is this work worth" calculator — the Notion-style band that
 * sits under the pricing grid: tick the subscriptions you already pay for, add
 * the work you would otherwise hire for, and it totals the annual bill against
 * the selected Ryu agent allowance.
 *
 * Presentational: every number it needs is either in the tool catalog below or
 * injected as a prop, and the seat count is CONTROLLED by the page so this and
 * the seat steppers on the plan cards can never disagree.
 */

const MONTHS_PER_YEAR = 12;
/** Transparent denominator for turning a loaded monthly hire into hours. */
const STANDARD_WORK_MONTH_HOURS = 160;

/** A subscription a Ryu plan stands in for. */
interface ReplaceableTool {
	/** Grouping header this tool renders under. */
	readonly category: string;
	/** Ticked on first render — the stack a typical buyer already pays for. */
	readonly defaultOn: boolean;
	readonly id: string;
	/** List price in whole USD per month. */
	readonly monthlyUsd: number;
	readonly name: string;
	/**
	 * True when the price is charged per person; false for a workspace-wide
	 * (flat) plan that does not scale with the seat count.
	 */
	readonly perSeat: boolean;
	/** What Ryu does instead — one short clause. */
	readonly replacedBy: string;
}

/**
 * PUBLIC LIST PRICES as of 2026-07, in USD, taken from each vendor's own
 * pricing page and rounded to whole dollars. They are marketing inputs, not
 * billing inputs — nothing here is charged — but they DRIFT, so re-check them
 * when this section is next touched. Where a vendor lists both a monthly and a
 * cheaper annual rate we use the MONTHLY rate, since that is what the
 * comparison's "billed monthly" competitor column means.
 */
const REPLACEABLE_TOOLS: readonly ReplaceableTool[] = [
	{
		id: "chatgpt-plus",
		name: "ChatGPT Plus",
		category: "AI assistants",
		monthlyUsd: 20,
		perSeat: true,
		defaultOn: true,
		replacedBy: "Apps, Bot, and workflows in one subscription",
	},
	{
		id: "claude-pro",
		name: "Claude Pro",
		category: "AI assistants",
		monthlyUsd: 20,
		perSeat: true,
		defaultOn: true,
		replacedBy: "Ask Ryu to run and change the workflow",
	},
	{
		id: "perplexity-pro",
		name: "Perplexity Pro",
		category: "AI assistants",
		monthlyUsd: 20,
		perSeat: true,
		defaultOn: false,
		replacedBy: "Research inside the workflow",
	},
	{
		id: "cursor-pro",
		name: "Cursor Pro",
		category: "Coding agents",
		monthlyUsd: 20,
		perSeat: true,
		defaultOn: true,
		replacedBy: "Coding work you can review",
	},
	{
		id: "copilot-business",
		name: "GitHub Copilot Business",
		category: "Coding agents",
		monthlyUsd: 19,
		perSeat: true,
		defaultOn: false,
		replacedBy: "Coding workflows for the team",
	},
	{
		id: "notion-business",
		name: "Notion Business",
		category: "Docs & knowledge",
		monthlyUsd: 24,
		perSeat: true,
		defaultOn: true,
		replacedBy: "Records your workflows can use",
	},
	{
		id: "granola",
		name: "Granola Business",
		category: "Meetings",
		monthlyUsd: 18,
		perSeat: true,
		defaultOn: false,
		replacedBy: "Meeting notes your team can review",
	},
	{
		id: "otter-business",
		name: "Otter Business",
		category: "Meetings",
		monthlyUsd: 20,
		perSeat: true,
		defaultOn: false,
		replacedBy: "Meeting notes and follow-up tasks",
	},
	{
		id: "superhuman",
		name: "Superhuman",
		category: "Email",
		monthlyUsd: 30,
		perSeat: true,
		defaultOn: false,
		replacedBy: "Inbox workflows your team can review",
	},
	{
		id: "zapier-pro",
		name: "Zapier Professional",
		category: "Automation",
		monthlyUsd: 49,
		perSeat: false,
		defaultOn: true,
		replacedBy: "Workflow apps you can change by asking Ryu",
	},
	{
		id: "make-pro",
		name: "Make Pro",
		category: "Automation",
		monthlyUsd: 19,
		perSeat: false,
		defaultOn: false,
		replacedBy: "Workflow apps on your Ryu server",
	},
	{
		id: "midjourney",
		name: "Midjourney Standard",
		category: "Creative",
		monthlyUsd: 30,
		perSeat: true,
		defaultOn: false,
		replacedBy: "Creative workflows in the same workspace",
	},
	{
		id: "elevenlabs",
		name: "ElevenLabs Creator",
		category: "Creative",
		monthlyUsd: 22,
		perSeat: false,
		defaultOn: false,
		replacedBy: "Voice and transcription in the workflow",
	},
	{
		id: "agent-host",
		name: "VPS for 24/7 agents",
		category: "Infrastructure",
		monthlyUsd: 25,
		perSeat: false,
		defaultOn: false,
		replacedBy: "Managed Ryu capacity for apps and workflows",
	},
];

/**
 * A cost an agent platform displaces that is NOT a software subscription.
 *
 * THE TOOL LIST ALONE UNDERSELLS THE PRODUCT, and by a wide margin. Ticking
 * every subscription above tops out at a few hundred dollars a month, because
 * that is what SOFTWARE costs — while the work those agents actually do is
 * priced in salaries, retainers and hours. A buyer comparing us against Notion
 * and Zapier is answering "which tools do we replace"; the question that
 * persuades is "what would you pay to get this done without us", and its answer
 * is an order of magnitude larger.
 *
 * These rows are EDITABLE, unlike the tool list, and that difference is
 * deliberate. A vendor's list price is a fact we can look up and be held to; an
 * SDR's loaded cost is the buyer's own number, varies by market by a factor of
 * three, and would read as a made-up claim if we asserted it. So we seed a
 * defensible default and let them correct it — the figure they typed is the one
 * they believe, which is the only figure that moves a decision.
 */
interface DisplacedCost {
	readonly category: string;
	/** Seeded monthly USD — a starting point, not a claim. */
	readonly defaultMonthlyUsd: number;
	/** Ticked on first render. Off by default: these are large numbers, and a
	 * calculator that opens by asserting a $6,000/mo saving reads as a sales
	 * trick rather than an estimate. The buyer opts in to each one. */
	readonly defaultOn: boolean;
	/** Where the default comes from, so the number is arguable rather than magic. */
	readonly hint: string;
	readonly id: string;
	readonly name: string;
	/** What Ryu does instead — one short clause. */
	readonly replacedBy: string;
}

/**
 * Seeded at deliberately CONSERVATIVE figures (2026 US mid-market), because the
 * calculator's credibility is worth more than its headline. Each is a monthly
 * cost the buyer edits to their own reality.
 */
const DISPLACED_COSTS: readonly DisplacedCost[] = [
	{
		id: "hire-sdr",
		name: "An SDR or outbound rep",
		category: "Loaded cost of the next hire",
		defaultMonthlyUsd: 5000,
		defaultOn: false,
		hint: "Salary, benefits, payroll, and management overhead",
		replacedBy: "Workflows that research, draft, and follow up",
	},
	{
		id: "hire-support",
		name: "A support agent",
		category: "Loaded cost of the next hire",
		defaultMonthlyUsd: 4000,
		defaultOn: false,
		hint: "Salary, benefits, payroll, and management overhead",
		replacedBy: "Workflows that triage and draft replies",
	},
	{
		id: "hire-analyst",
		name: "A junior analyst or researcher",
		category: "Loaded cost of the next hire",
		defaultMonthlyUsd: 5500,
		defaultOn: false,
		hint: "Salary, benefits, payroll, and management overhead",
		replacedBy: "Research workflows that run on schedule",
	},
	{
		id: "hire-ops",
		name: "An ops or admin coordinator",
		category: "Loaded cost of the next hire",
		defaultMonthlyUsd: 4500,
		defaultOn: false,
		hint: "Salary, benefits, payroll, and management overhead",
		replacedBy: "Workflow apps for recurring operations",
	},
	{
		id: "hire-finance",
		name: "A bookkeeper or finance coordinator",
		category: "Loaded cost of the next hire",
		defaultMonthlyUsd: 3500,
		defaultOn: false,
		hint: "Salary, benefits, payroll, and management overhead",
		replacedBy: "Workflow apps that reconcile, classify, and report",
	},
	{
		id: "hire-customer-success",
		name: "A customer-success coordinator",
		category: "Loaded cost of the next hire",
		defaultMonthlyUsd: 4500,
		defaultOn: false,
		hint: "Salary, benefits, payroll, and management overhead",
		replacedBy: "Workflow apps that monitor accounts and draft follow-ups",
	},
	{
		id: "hire-qa",
		name: "A QA or data-entry operator",
		category: "Loaded cost of the next hire",
		defaultMonthlyUsd: 3500,
		defaultOn: false,
		hint: "Salary, benefits, payroll, and management overhead",
		replacedBy: "Workflow apps for checks and repetitive updates",
	},
	{
		id: "ops-hours",
		name: "Ops and admin time you already spend",
		category: "Hours you'd get back",
		defaultMonthlyUsd: 1600,
		defaultOn: false,
		hint: "About 10 hours a week at $40/hour, loaded",
		replacedBy: "The same work in a workflow",
	},
	{
		id: "support-tickets",
		name: "Tickets handled by hand",
		category: "Hours you'd get back",
		defaultMonthlyUsd: 1000,
		defaultOn: false,
		hint: "About 200 tickets a month at $5 each",
		replacedBy: "First-pass drafts for each ticket",
	},
	{
		id: "agency-content",
		name: "Content or research retainer",
		category: "Agencies and contractors",
		defaultMonthlyUsd: 3000,
		defaultOn: false,
		hint: "A typical small monthly retainer",
		replacedBy: "Drafts your team edits in Ryu",
	},
	{
		id: "agency-leadgen",
		name: "Lead-gen or list-building retainer",
		category: "Agencies and contractors",
		defaultMonthlyUsd: 2000,
		defaultOn: false,
		hint: "A typical small monthly retainer",
		replacedBy: "Research and enrichment in a workflow",
	},
	{
		id: "cac-tooling",
		name: "Outbound and sales tooling",
		category: "Going to market",
		defaultMonthlyUsd: 800,
		defaultOn: false,
		hint: "Sequencer, dialler and deliverability stack",
		replacedBy: "Sales workflows on your Ryu server",
	},
	{
		id: "data-enrichment",
		name: "Data and enrichment subscriptions",
		category: "Going to market",
		defaultMonthlyUsd: 1200,
		defaultOn: false,
		hint: "Apollo, Clay, ZoomInfo and similar",
		replacedBy: "Web research and enrichment in the workflow",
	},
	{
		id: "own-api-keys",
		name: "API keys you'd buy directly",
		category: "Keys you'd otherwise hold",
		defaultMonthlyUsd: 400,
		defaultOn: false,
		hint: "What you'd put on your own OpenAI, Anthropic and search accounts",
		// The keyless pass-through story: the models are billed at cost, so this
		// line is not "cheaper keys" — it is the same spend, minus the accounts,
		// the cards, the rate limits and the per-vendor minimums.
		replacedBy: "Managed models and tools in one subscription",
	},
];

/** Both groups share one row shape for totalling; only the UI differs. */
const DISPLACED_CATEGORIES: readonly {
	name: string;
	items: readonly DisplacedCost[];
}[] = DISPLACED_COSTS.reduce<{ name: string; items: DisplacedCost[] }[]>(
	(groups, cost) => {
		const existing = groups.find((group) => group.name === cost.category);
		if (existing) {
			existing.items.push(cost);
			return groups;
		}
		groups.push({ name: cost.category, items: [cost] });
		return groups;
	},
	[]
);

const DEFAULT_DISPLACED_SELECTION = new Set(
	DISPLACED_COSTS.filter((cost) => cost.defaultOn).map((cost) => cost.id)
);

/** Seeded amounts, keyed by id, before the buyer edits any of them. */
const DEFAULT_DISPLACED_AMOUNTS: Readonly<Record<string, number>> =
	Object.fromEntries(
		DISPLACED_COSTS.map((cost) => [cost.id, cost.defaultMonthlyUsd])
	);

/**
 * Upper bound on an edited amount. Not a UX nicety: the totals feed a
 * percentage and a bar width, and a buyer who pastes a salary in cents (or
 * leans on a key) would otherwise render a "you'd save 99.9%" headline that
 * discredits the whole section.
 */
const MAX_DISPLACED_MONTHLY_USD = 1_000_000;

/** The catalog grouped into the order the categories first appear. */
const TOOL_CATEGORIES: readonly {
	name: string;
	tools: readonly ReplaceableTool[];
}[] = REPLACEABLE_TOOLS.reduce<{ name: string; tools: ReplaceableTool[] }[]>(
	(groups, tool) => {
		const existing = groups.find((group) => group.name === tool.category);
		if (existing) {
			existing.tools.push(tool);
			return groups;
		}
		groups.push({ name: tool.category, tools: [tool] });
		return groups;
	},
	[]
);

const DEFAULT_SELECTION = new Set(
	REPLACEABLE_TOOLS.filter((tool) => tool.defaultOn).map((tool) => tool.id)
);

/** Whole-dollar USD ("$1,170"). */
const usd = (value: number): string =>
	formatCurrency(value, "USD", { maximumFractionDigits: 0 });

/** USD that keeps cents when there are any ("$19.50", but "$20"). */
const usdWithCents = (value: number): string =>
	formatCurrency(value, "USD", { maximumFractionDigits: 2 });

/** Included AI usage is a fixed plan pool, not an agent-count multiplier. */

/**
 * The comparison bar: two stacked tracks, the wider one being whatever costs
 * more. Purely decorative — the figures above it carry the real information —
 * so it is `aria-hidden` and the totals are read out in text.
 */
function ComparisonBars({
	stackAnnual,
	ryuAnnual,
}: {
	stackAnnual: number;
	ryuAnnual: number;
}) {
	const widest = Math.max(stackAnnual, ryuAnnual, 1);
	const stackWidth = Math.round((stackAnnual / widest) * 100);
	const ryuWidth = Math.round((ryuAnnual / widest) * 100);
	return (
		<div aria-hidden className="mt-6 space-y-3">
			<div>
				<div className="mb-1 flex justify-between text-xs">
					<span className="text-muted-foreground">Your current tools</span>
					<span className="font-heading font-medium tabular-nums">
						{usd(stackAnnual)}/yr
					</span>
				</div>
				<div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
					<div
						className="h-full rounded-full bg-muted-foreground/40 transition-[width] duration-500 ease-out"
						style={{ width: `${stackWidth}%` }}
					/>
				</div>
			</div>
			<div>
				<div className="mb-1 flex justify-between text-xs">
					<span className="text-muted-foreground">Ryu</span>
					<span className="font-heading font-medium tabular-nums">
						{usd(ryuAnnual)}/yr
					</span>
				</div>
				<div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
					<div
						className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
						style={{ width: `${ryuWidth}%` }}
					/>
				</div>
			</div>
		</div>
	);
}

/** One tickable tool row. */
function ToolRow({
	tool,
	seats,
	selected,
	onToggle,
}: {
	tool: ReplaceableTool;
	seats: number;
	selected: boolean;
	onToggle: (id: string, next: boolean) => void;
}) {
	const monthly = tool.perSeat ? tool.monthlyUsd * seats : tool.monthlyUsd;
	const inputId = `ryu-savings-${tool.id}`;
	return (
		<div className="flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-muted/50">
			<Checkbox
				checked={selected}
				className="mt-0.5"
				id={inputId}
				onCheckedChange={(next) => onToggle(tool.id, next === true)}
			/>
			<label className="min-w-0 flex-1 cursor-pointer" htmlFor={inputId}>
				<span className="block font-medium text-sm">{tool.name}</span>
				<span className="block text-muted-foreground text-xs">
					{tool.replacedBy}
				</span>
			</label>
			<span className="min-w-0 max-w-[55%] shrink-0 text-right">
				<span className="block font-heading font-medium text-sm tabular-nums">
					{usd(monthly)}
					<span className="text-muted-foreground text-xs">/mo</span>
				</span>
				<span className="block break-words text-muted-foreground text-xs">
					{tool.perSeat ? (
						<>
							<span className="font-heading tabular-nums">
								{usd(tool.monthlyUsd)}
							</span>
							/seat
						</>
					) : (
						"flat rate"
					)}
				</span>
			</span>
		</div>
	);
}

/** One tickable displaced-cost row, with the amount editable in place. */
function DisplacedCostRow({
	cost,
	amount,
	selected,
	onToggle,
	onAmountChange,
}: {
	amount: number;
	cost: DisplacedCost;
	onAmountChange: (id: string, next: number) => void;
	onToggle: (id: string, next: boolean) => void;
	selected: boolean;
}) {
	const inputId = `ryu-displaced-${cost.id}`;
	const amountId = `ryu-displaced-amount-${cost.id}`;
	return (
		<div className="flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-muted/50">
			<Checkbox
				checked={selected}
				className="mt-0.5"
				id={inputId}
				onCheckedChange={(next) => onToggle(cost.id, next === true)}
			/>
			<label className="min-w-0 flex-1 cursor-pointer" htmlFor={inputId}>
				<span className="block font-medium text-sm">{cost.name}</span>
				<span className="block text-muted-foreground text-xs">
					{cost.replacedBy}
				</span>
			</label>
			<span className="min-w-0 max-w-[55%] shrink-0 text-right">
				{/* The label is visually hidden rather than absent: the input is a bare
				    number next to a name, which a screen reader would read as an
				    unlabelled spinbutton. */}
				<label className="sr-only" htmlFor={amountId}>
					Monthly cost of {cost.name} in US dollars
				</label>
				<span className="flex items-center justify-end gap-1">
					<span className="font-heading text-muted-foreground text-sm">$</span>
					<Input
						className="h-8 w-24 text-right font-heading text-sm tabular-nums"
						id={amountId}
						inputMode="numeric"
						max={MAX_DISPLACED_MONTHLY_USD}
						min={0}
						onChange={(event) =>
							onAmountChange(cost.id, Number(event.target.value))
						}
						type="number"
						value={amount}
					/>
					<span className="text-muted-foreground text-xs">/mo</span>
				</span>
				<span className="mt-0.5 block break-words text-muted-foreground text-xs">
					{cost.hint}
				</span>
			</span>
		</div>
	);
}

/**
 * Total cost savings from replacing a stack of point tools with one Ryu plan.
 *
 * `agentCount` and `monthlyPriceUsd` come from the Teams offer on the pricing page.
 * The calculator never invents a seat minimum or multiplies the fixed included
 * credit pool by the number of agents.
 */
export function PricingSavingsCalculator({
	isYearly = false,
	monthlyPriceUsd = 250,
	includedCreditUsd = 50,
	agentCount = TEAMS_MIN_SEATS,
	seatCount,
	planName = "Teams",
	plansHref = "#plans",
}: {
	/** Shared monthly AI-credit pool for the selected contracted agent count. */
	includedCreditUsd?: number;
	isYearly?: boolean;
	/** Legacy name retained for callers; it now represents member seats. */
	agentCount?: number;
	/** Preferred member-seat name for new callers. */
	seatCount?: number;
	/** Monthly quote at the selected allowance. */
	monthlyPriceUsd?: number;
	planName?: string;
	/** Where "Compare plans" points; the default assumes the pricing page. */
	plansHref?: string;
}) {
	const [selected, setSelected] = useState<Set<string>>(
		() => new Set(DEFAULT_SELECTION)
	);
	const [displacedSelected, setDisplacedSelected] = useState<Set<string>>(
		() => new Set(DEFAULT_DISPLACED_SELECTION)
	);
	const [displacedAmounts, setDisplacedAmounts] = useState<
		Record<string, number>
	>(() => ({ ...DEFAULT_DISPLACED_AMOUNTS }));

	const safeAgentCount = Math.max(
		TEAMS_MIN_SEATS,
		Math.floor(seatCount ?? agentCount)
	);
	// Per-seat software scales with the selected team size. Hires and contractor
	// costs below are already whole-organization figures, so they stay flat.
	const peopleCount = safeAgentCount;

	const toggle = (id: string, next: boolean) => {
		setSelected((prev) => {
			const draft = new Set(prev);
			if (next) {
				draft.add(id);
			} else {
				draft.delete(id);
			}
			return draft;
		});
	};

	const toggleDisplaced = (id: string, next: boolean) => {
		setDisplacedSelected((prev) => {
			const draft = new Set(prev);
			if (next) {
				draft.add(id);
			} else {
				draft.delete(id);
			}
			return draft;
		});
	};

	const setDisplacedAmount = (id: string, next: number) => {
		// Clamped, and NaN-guarded: an emptied field yields `Number("") === 0`,
		// but a partially typed one can yield NaN, which would poison the total
		// and render every downstream figure as "$NaN".
		const safe = Number.isFinite(next)
			? Math.min(Math.max(Math.round(next), 0), MAX_DISPLACED_MONTHLY_USD)
			: 0;
		setDisplacedAmounts((prev) => ({ ...prev, [id]: safe }));
	};

	const {
		hireAnchorMonthly,
		hireAnchorSharePct,
		hireEquivalentHours,
		stackAnnual,
		ryuAnnual,
		savings,
		savingsPct,
	} = useMemo(() => {
		const toolsMonthly = REPLACEABLE_TOOLS.filter((tool) =>
			selected.has(tool.id)
		).reduce(
			(total, tool) =>
				total +
				(tool.perSeat ? tool.monthlyUsd * peopleCount : tool.monthlyUsd),
			0
		);
		// Displaced costs are FLAT, never multiplied by seats. They are already
		// whole-org figures — one SDR, one retainer — so scaling them by the seat
		// count would multiply a salary by the size of the team paying it.
		const displacedMonthly = DISPLACED_COSTS.filter((cost) =>
			displacedSelected.has(cost.id)
		).reduce(
			(total, cost) =>
				total + (displacedAmounts[cost.id] ?? cost.defaultMonthlyUsd),
			0
		);
		const stackMonthly = toolsMonthly + displacedMonthly;
		const hireAnchorMonthly = DISPLACED_COSTS.filter(
			(cost) =>
				cost.category === "Loaded cost of the next hire" &&
				displacedSelected.has(cost.id)
		).reduce(
			(total, cost) =>
				total + (displacedAmounts[cost.id] ?? cost.defaultMonthlyUsd),
			0
		);
		const hireHourlyCost = hireAnchorMonthly / STANDARD_WORK_MONTH_HOURS;
		// Competitors are totalled at their MONTHLY list rate over a year; Ryu is
		// totalled at whichever term the page's billing toggle is on, so the yearly
		// toggle's two free months show up in the comparison.
		const stackYear = stackMonthly * MONTHS_PER_YEAR;
		const ryuYear = isYearly
			? annualTotalPrice(monthlyPriceUsd)
			: monthlyPriceUsd * MONTHS_PER_YEAR;
		const saved = stackYear - ryuYear;
		return {
			hireAnchorMonthly,
			hireAnchorSharePct:
				hireAnchorMonthly > 0
					? Math.round((monthlyPriceUsd / hireAnchorMonthly) * 100)
					: null,
			hireEquivalentHours:
				hireHourlyCost > 0
					? Math.round(monthlyPriceUsd / hireHourlyCost)
					: null,
			stackAnnual: stackYear,
			ryuAnnual: ryuYear,
			savings: saved,
			savingsPct: stackYear > 0 ? Math.round((saved / stackYear) * 100) : 0,
		};
	}, [
		selected,
		displacedSelected,
		displacedAmounts,
		monthlyPriceUsd,
		isYearly,
	]);

	const nothingSelected = selected.size === 0 && displacedSelected.size === 0;
	const ryuMonthlyPrice = effectiveMonthlyPrice(monthlyPriceUsd, isYearly);

	return (
		<section className="mx-auto mb-16 max-w-7xl">
			{/* The same title/subtitle pair the page opens with, so this section reads
			    as part of the page rather than as a differently-styled island. `as="h2"`
			    is load-bearing: the routed page already owns the `h1`. */}
			<PageHeader
				as="h2"
				className="mb-8 text-center"
				subtitle="Select the tools you pay for and add the people, hours, or retainers you would otherwise pay for. Edit each number to match your business."
				title="Compare what you buy today with one Ryu subscription."
			/>

			<div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_360px]">
				{/* Both cost groups share the left column; the savings panel sticks
				    in the right one. Wrapped rather than left to grid auto-placement,
				    which would have put the second card BESIDE the first and pushed
				    the sticky panel onto a second row. */}
				<div className="space-y-8">
					<Card>
						<CardHeader>
							<CardTitle className="text-lg">
								Software you pay for today
							</CardTitle>
							<CardDescription>
								Per-seat tools multiply by the selected seats; flat-rate tools
								stay at their listed price.
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-6">
							{TOOL_CATEGORIES.map((category) => (
								<div key={category.name}>
									<p className="mb-1 px-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">
										{category.name}
									</p>
									{category.tools.map((tool) => (
										<ToolRow
											key={tool.id}
											onToggle={toggle}
											seats={peopleCount}
											selected={selected.has(tool.id)}
											tool={tool}
										/>
									))}
								</div>
							))}
						</CardContent>
					</Card>

					{/* The second group, and the one that carries the argument. The card
					    above answers "which tools do we replace"; this one answers "what
					    would you pay to get this done without us", which is where the
					    number stops being a rounding error on a software budget. Kept as a
					    separate card, and separately opt-in, so the tool comparison stays
					    honest on its own — a buyer who trusts only the list prices can
					    ignore this entirely and still get a defensible figure. */}
					<Card>
						<CardHeader>
							<CardTitle className="text-lg">
								People and services you would otherwise pay for
							</CardTitle>
							<CardDescription>
								Add a hire, contractor, or overtime cost you would otherwise
								pay. Edit the number to match your business.
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-6">
							{DISPLACED_CATEGORIES.map((category) => (
								<div key={category.name}>
									<p className="mb-1 px-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">
										{category.name}
									</p>
									{category.items.map((cost) => (
										<DisplacedCostRow
											amount={
												displacedAmounts[cost.id] ?? cost.defaultMonthlyUsd
											}
											cost={cost}
											key={cost.id}
											onAmountChange={setDisplacedAmount}
											onToggle={toggleDisplaced}
											selected={displacedSelected.has(cost.id)}
										/>
									))}
								</div>
							))}
						</CardContent>
					</Card>
				</div>

				<div className="lg:sticky lg:top-24 lg:self-start">
					<Card>
						<CardHeader>
							<CardTitle className="text-lg">Your estimated cost</CardTitle>
							<CardDescription>
								Ryu {planName} at{" "}
								<span className="font-heading tabular-nums">
									{usd(ryuMonthlyPrice)}
								</span>
								/mo for {safeAgentCount}{" "}
								{safeAgentCount === 1 ? "seat" : "seats"}
								{isYearly ? ", billed yearly" : ""}.
							</CardDescription>
						</CardHeader>
						<CardContent>
							<p className="text-muted-foreground text-xs">
								Your included AI credits are pooled across the organization.
							</p>

							{hireAnchorMonthly > 0 ? (
								<div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs">
									<p className="font-medium text-foreground">
										Your current capacity cost
									</p>
									<p className="mt-1 text-muted-foreground">
										At {usd(hireAnchorMonthly)}/mo fully loaded, {planName} is
										about <strong>{hireAnchorSharePct ?? 0}%</strong> of that
										monthly capacity — roughly{" "}
										<strong>{hireEquivalentHours ?? 0} hours</strong> at the
										same 160-hour work month.
									</p>
								</div>
							) : null}

							{nothingSelected ? (
								<p className="mt-6 text-muted-foreground text-sm">
									Select the tools, people, or contractors you pay for today to
									compare the total.
								</p>
							) : (
								<>
									<div className="mt-6 flex items-baseline">
										<NumberTicker
											className="font-heading font-semibold text-4xl tabular-nums"
											prefix={savings < 0 ? "-$" : "$"}
											value={Math.abs(savings)}
										/>
										<span className="ml-1 text-muted-foreground">/year</span>
									</div>
									<p className="mt-1 text-muted-foreground text-sm">
										{savings > 0
											? `On these assumptions, Ryu is ${savingsPct}% lower than the selected costs.`
											: "On these assumptions, Ryu costs more than the selected costs. Edit the assumptions before you decide."}
									</p>
									<ComparisonBars
										ryuAnnual={ryuAnnual}
										stackAnnual={stackAnnual}
									/>
								</>
							)}

							<Button
								className="mt-6 w-full"
								nativeButton={false}
								render={<a href={plansHref} />}
							>
								Compare plans
							</Button>
							<p className="mt-3 text-muted-foreground text-xs">
								Your {planName} subscription includes{" "}
								<span className="font-heading tabular-nums">
									{usdWithCents(includedCreditUsd)}
								</span>
								/mo shared AI credit pool. Managed model usage draws from that
								pool; any top-ups are separate.
							</p>
						</CardContent>
					</Card>
				</div>
			</div>
		</section>
	);
}
