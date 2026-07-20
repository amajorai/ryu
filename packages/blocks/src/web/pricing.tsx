"use client";

import { Button, buttonVariants } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { NumberTicker } from "@ryu/ui/components/number-ticker";
import {
	PlanBadge,
	type PlanTier,
	planTierConicGradient,
} from "@ryu/ui/components/plan-badge";
import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs";
import {
	ArrowLeft,
	Bot,
	Calendar,
	ChevronDown,
	Cloud,
	Coins,
	Cpu,
	Download,
	Key,
	Loader2,
	Mail,
	Monitor,
	Server,
	Shield,
	Star,
	Users,
	Wrench,
	Zap,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useState } from "react";

export type PricingPlanSlug =
	| "lifetime"
	| "pro-monthly"
	| "pro-yearly"
	| "max-monthly"
	| "max-yearly"
	| "teams-monthly"
	| "teams-yearly"
	// Ryu Cloud hosting tiers, e.g. "cloud-base" / "cloud-2x" / "cloud-3x". The
	// exact ids come from the tier catalog (`@ryu/auth/lib/cloud-tiers`), injected
	// by the page; this stays presentational.
	| `cloud-${string}`;

export type CurrentPricingPlan = "desktop-license" | "pro" | "max" | "teams";

/**
 * Display shape for a Ryu Cloud hosting tier row (injected by the page). Specs +
 * price come from the live Hetzner catalog with a markup, but the USER never sees
 * Hetzner/CX/CPX names — only CPU / RAM / SSD + a perf label. `monthlyAddUsd` is
 * the cost ON TOP of Max (0 for the free BASE node bundled with Max, flagged by
 * `includedWithMax`).
 */
export interface CloudHostingTier {
	readonly cores: number;
	readonly diskGb: number;
	/** Canonical tier id (BASE / 2X / 3X). */
	readonly id: string;
	/** True for the BASE node bundled free with the Max plan. */
	readonly includedWithMax: boolean;
	readonly memoryGb: number;
	/** Monthly add-on price on top of Max (USD). 0 for the included BASE node. */
	readonly monthlyAddUsd: number;
	readonly name: string;
	/** User-facing performance label ("Cost-optimized" | "Performance"). */
	readonly perfLabel: string;
	/** The checkout slug, e.g. "cloud-2x". BASE has no checkout (bundled with Max). */
	readonly slug: PricingPlanSlug;
}

const noop = () => {
	// presentational default; the live page injects real handlers
};

/** Annual billing gives two months free (pay for 10 of 12 months). */
const FREE_MONTHS_ON_ANNUAL = 2;
const MONTHS_PER_YEAR = 12;

/**
 * The price block for a recurring plan. Always shows the *monthly* figure with a
 * "/mo" suffix — on the yearly toggle it shows the per-month equivalent of the
 * annual price (two months free, i.e. billed for 10 of 12 months), with the true
 * annual total spelled out beneath. Anchoring on the smaller monthly number is
 * the standard SaaS psychology play. With monthly $39/$200 this lands the annual
 * totals on $390/$2000 (Pro/Max), matching the Polar yearly prices.
 */
function PriceBlock({
	monthly,
	isYearly,
	perSeat = false,
}: {
	monthly: number;
	isYearly: boolean;
	perSeat?: boolean;
}) {
	const annualTotal = monthly * (MONTHS_PER_YEAR - FREE_MONTHS_ON_ANNUAL);
	const perMonth = isYearly
		? Math.round(annualTotal / MONTHS_PER_YEAR)
		: monthly;
	const seat = perSeat ? "/seat" : "";
	return (
		<>
			<div className="mb-1 flex items-baseline">
				<NumberTicker
					className="font-semibold text-4xl"
					prefix="$"
					value={perMonth}
				/>
				<span className="ml-1 text-muted-foreground">{`${seat}/mo`}</span>
			</div>
			<p className="mb-6 text-muted-foreground text-xs">
				{isYearly
					? `Billed $${annualTotal}${seat}/year · 2 months free`
					: `Billed monthly${perSeat ? " · per seat" : ""} · cancel anytime`}
			</p>
		</>
	);
}

/** The monthly/yearly billing period toggle. */
export function PricingBillingToggle({
	isYearly = false,
	onToggleYearly = noop,
}: {
	isYearly?: boolean;
	onToggleYearly?: (yearly: boolean) => void;
}) {
	return (
		<div className="mb-8 flex justify-center">
			<Tabs
				onValueChange={(val) => onToggleYearly(val === "yearly")}
				value={isYearly ? "yearly" : "monthly"}
			>
				<TabsList variant="pills">
					<TabsTrigger value="monthly">Monthly</TabsTrigger>
					<TabsTrigger
						className="[&_span]:text-primary data-active:[&_span]:text-white/90 dark:data-active:[&_span]:text-black/80"
						value="yearly"
					>
						Yearly
						<span className="ml-1.5 font-medium text-xs">2 months free</span>
					</TabsTrigger>
				</TabsList>
			</Tabs>
		</div>
	);
}

/**
 * Apple-style expandable "add hosted compute" panel, nested inside a plan card
 * (Max and Teams). Collapsed by default; expands to reveal the Ryu Cloud
 * hosting ladder. The BASE node ships free with the plan (shown as "Included",
 * never a checkout); the 2X/3X performance tiers are paid add-ons priced on top
 * of the plan, each with its own checkout (separate monthly billing — the merge
 * is purely visual). Renders nothing when no tiers are supplied. `planLabel`
 * names the host plan in the copy.
 */
function CloudUpgradePanel({
	tiers,
	loadingPlan,
	onCheckout,
	planLabel,
}: {
	tiers: readonly CloudHostingTier[];
	loadingPlan: PricingPlanSlug | null;
	onCheckout: (slug: PricingPlanSlug) => void;
	planLabel: string;
}) {
	const [expanded, setExpanded] = useState(false);

	if (tiers.length === 0) {
		return null;
	}

	return (
		<div className="mt-6 border-t pt-4">
			<button
				aria-expanded={expanded}
				className="flex w-full items-center justify-between gap-2 text-left font-medium text-sm"
				onClick={() => setExpanded((prev) => !prev)}
				type="button"
			>
				<span className="flex items-center gap-2">
					<Server className="size-4" />
					Run your AI in the cloud
				</span>
				<ChevronDown
					className={
						expanded
							? "size-4 rotate-180 transition-transform"
							: "size-4 transition-transform"
					}
				/>
			</button>
			<p className="mt-1 text-muted-foreground text-xs">
				Your {planLabel} plan includes a free managed node, so your AI keeps
				running 24/7 even when your computer is off. Upgrade for more
				performance — billed monthly, on top of {planLabel}.
			</p>
			<AnimatePresence initial={false}>
				{expanded ? (
					<motion.ul
						animate={{ height: "auto", opacity: 1 }}
						className="overflow-hidden"
						exit={{ height: 0, opacity: 0 }}
						initial={{ height: 0, opacity: 0 }}
						transition={{ duration: 0.24, ease: "easeOut" }}
					>
						{tiers.map((tier) => {
							const specs = `${tier.cores} vCPU · ${tier.memoryGb} GB RAM · ${tier.diskGb} GB SSD`;
							// BASE ships free with the plan: shown, never a checkout.
							if (tier.includedWithMax) {
								return (
									<li key={tier.slug}>
										<div className="mt-3 flex w-full items-center gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3 text-left">
											<Cloud className="size-4 shrink-0 text-primary" />
											<span className="flex-1">
												<span className="block font-medium text-sm">
													{tier.name} · {tier.perfLabel}
												</span>
												<span className="block text-muted-foreground text-xs">
													{specs}
												</span>
											</span>
											<span className="shrink-0 font-semibold text-primary text-sm">
												Included
											</span>
										</div>
									</li>
								);
							}
							const isLoading = loadingPlan === tier.slug;
							return (
								<li key={tier.slug}>
									<button
										className="mt-3 flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary disabled:opacity-60"
										disabled={isLoading}
										onClick={() => onCheckout(tier.slug)}
										type="button"
									>
										<Cpu className="size-4 shrink-0 text-primary" />
										<span className="flex-1">
											<span className="block font-medium text-sm">
												{tier.name} · {tier.perfLabel}
											</span>
											<span className="block text-muted-foreground text-xs">
												{specs}
											</span>
										</span>
										<span className="shrink-0 text-right">
											{isLoading ? (
												<Loader2 className="size-4 animate-spin" />
											) : (
												<span className="font-semibold text-sm">
													+${tier.monthlyAddUsd}
													<span className="text-muted-foreground text-xs">
														/mo
													</span>
												</span>
											)}
										</span>
									</button>
								</li>
							);
						})}
					</motion.ul>
				) : null}
			</AnimatePresence>
		</div>
	);
}

/**
 * Wraps a plan card in a 2px gradient border. Pro uses an always-on animated
 * conic sweep (`.t-pro-card-border`); other tiers (max/teams/lifetime) show a
 * static default border in the 2px frame in LIGHT mode only (`bg-border`;
 * `dark:bg-transparent` = borderless in dark) that MORPHS into a matching
 * animated conic ring on hover (`.t-card-border-spin` +
 * {@link planTierConicGradient}).
 */
function PricingCardBorder({
	variant,
	children,
}: {
	variant: PlanTier;
	children: ReactNode;
}) {
	if (variant === "pro") {
		return (
			<div className="t-pro-card-border relative rounded-[calc(var(--radius-4xl)+2px)] p-[2px]">
				<Card className="relative flex h-full flex-col border-transparent">
					{children}
				</Card>
			</div>
		);
	}

	return (
		<div className="group relative rounded-[calc(var(--radius-4xl)+2px)] bg-border p-[2px] dark:bg-transparent">
			<div
				aria-hidden
				className="t-card-border-spin pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-500 ease-out group-hover:opacity-100"
				style={{ backgroundImage: planTierConicGradient(variant) }}
			/>
			<Card className="relative flex h-full flex-col border-transparent">
				{children}
			</Card>
		</div>
	);
}

/** Shared props every individual plan card accepts. */
interface PlanCardProps {
	currentPlan?: CurrentPricingPlan | null;
	isYearly?: boolean;
	loadingPlan?: PricingPlanSlug | null;
	onCheckout?: (slug: PricingPlanSlug) => void;
}

/** The footer CTA shared by every plan card (current / processing / label). */
function PlanCta({
	isCurrent,
	isLoading,
	label,
	onClick,
	variant,
}: {
	isCurrent: boolean;
	isLoading: boolean;
	label: string;
	onClick: () => void;
	variant?: "outline";
}) {
	return (
		<Button
			className="w-full"
			disabled={isCurrent || isLoading}
			onClick={onClick}
			variant={variant}
		>
			{isCurrent ? (
				"Current plan"
			) : isLoading ? (
				<>
					<Loader2 className="mr-2 size-4 animate-spin" />
					Processing…
				</>
			) : (
				label
			)}
		</Button>
	);
}

/** Lifetime (desktop license) plan card — one-time purchase, local-first. */
export function LifetimePlanCard({
	loadingPlan = null,
	onCheckout = noop,
	currentPlan = null,
}: PlanCardProps) {
	const isCurrent = currentPlan === "desktop-license";
	return (
		<PricingCardBorder variant="desktop-license">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					Lifetime Access
					<PlanBadge label="Lifetime" plan="desktop-license" size="md" />
				</CardTitle>
				<CardDescription>
					Run AI on your own computer. Pay once.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex-1">
				<div className="mb-1 flex items-baseline gap-2">
					<NumberTicker
						className="font-semibold text-4xl"
						prefix="$"
						value={29}
					/>
					<span className="text-muted-foreground text-xl line-through">
						$69
					</span>
					<span className="ml-1 text-muted-foreground">once</span>
				</div>
				<p className="mb-6 font-medium text-primary text-xs">
					Launch price · save 58%
				</p>
				<ul className="space-y-3">
					<li className="flex items-center">
						<Monitor className="mr-2 size-4" />
						<span>Run AI on your own computer, forever</span>
					</li>
					<li className="flex items-center">
						<Key className="mr-2 size-4" />
						<span>Use your own keys for cloud AI (optional)</span>
					</li>
					<li className="flex items-center">
						<Wrench className="mr-2 size-4" />
						<span>Private: nothing leaves your machine</span>
					</li>
					<li className="flex items-center">
						<Calendar className="mr-2 size-4" />
						<span>One year of updates included</span>
					</li>
					<li className="flex items-center">
						<Star className="mr-2 size-4" />
						<span>7-day free trial, no card needed</span>
					</li>
				</ul>
			</CardContent>
			<CardFooter>
				<PlanCta
					isCurrent={isCurrent}
					isLoading={loadingPlan === "lifetime"}
					label="Get lifetime access"
					onClick={() => onCheckout("lifetime")}
					variant="outline"
				/>
			</CardFooter>
		</PricingCardBorder>
	);
}

/** Pro plan card — the highlighted managed plan (animated gradient border). */
export function ProPlanCard({
	isYearly = false,
	loadingPlan = null,
	onCheckout = noop,
	currentPlan = null,
}: PlanCardProps) {
	const isCurrent = currentPlan === "pro";
	const isLoading =
		loadingPlan === "pro-monthly" || loadingPlan === "pro-yearly";

	return (
		<PricingCardBorder variant="pro">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					Pro Plan
					<PlanBadge plan="pro" size="md" />
				</CardTitle>
				<CardDescription>We run AI for you. Nothing to set up.</CardDescription>
			</CardHeader>
			<CardContent className="flex-1">
				<PriceBlock isYearly={isYearly} monthly={39} />
				<ul className="space-y-3">
					<li className="flex items-center">
						<Download className="mr-2 size-4" />
						<span>The full app on all your devices</span>
					</li>
					<li className="flex items-center">
						<Bot className="mr-2 size-4" />
						<span>Unlimited chats, agents & spaces</span>
					</li>
					<li className="flex items-center">
						<Cloud className="mr-2 size-4" />
						<span>300+ cloud AI models, ready to use</span>
					</li>
					<li className="flex items-center">
						<Coins className="mr-2 size-4" />
						<span>$20/month of AI usage included</span>
					</li>
					<li className="flex items-center">
						<Zap className="mr-2 size-4" />
						<span>We handle all the setup for you</span>
					</li>
					<li className="flex items-center">
						<Monitor className="mr-2 size-4" />
						<span>Run AI on your computer too</span>
					</li>
					<li className="flex items-center">
						<Mail className="mr-2 size-4" />
						<span>
							Unlimited Agent Inboxes &amp; emails · 5 GB mail storage
						</span>
					</li>
					<li className="flex items-center">
						<Server className="mr-2 size-4" />
						<span>Space data limited only by your disk</span>
					</li>
					<li className="flex items-center">
						<Key className="mr-2 size-4" />
						<span>Use your own API keys (optional)</span>
					</li>
				</ul>
			</CardContent>
			<CardFooter>
				<PlanCta
					isCurrent={isCurrent}
					isLoading={isLoading}
					label="Upgrade"
					onClick={() => onCheckout(isYearly ? "pro-yearly" : "pro-monthly")}
				/>
			</CardFooter>
		</PricingCardBorder>
	);
}

/** Max plan card — 24/7 managed agents, with the optional Cloud panel. */
export function MaxPlanCard({
	isYearly = false,
	loadingPlan = null,
	onCheckout = noop,
	currentPlan = null,
	cloudTiers = [],
}: PlanCardProps & { cloudTiers?: readonly CloudHostingTier[] }) {
	const isCurrent = currentPlan === "max";
	const isLoading =
		loadingPlan === "max-monthly" || loadingPlan === "max-yearly";
	return (
		<PricingCardBorder variant="max">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					Max Plan
					<PlanBadge plan="max" size="md" />
				</CardTitle>
				<CardDescription>We run AI for you, around the clock.</CardDescription>
			</CardHeader>
			<CardContent className="flex-1">
				<PriceBlock isYearly={isYearly} monthly={200} />
				<ul className="space-y-3">
					<li className="flex items-center">
						<ArrowLeft className="mr-2 size-4" />
						<span>Everything in Pro, plus:</span>
					</li>
					<li className="flex items-center">
						<Coins className="mr-2 size-4" />
						<span>$150/month of AI usage included</span>
					</li>
					<li className="flex items-center">
						<Bot className="mr-2 size-4" />
						<span>AI agents that keep working 24/7</span>
					</li>
					<li className="flex items-center">
						<Server className="mr-2 size-4" />
						<span>Free managed cloud node (2 vCPU · 4 GB)</span>
					</li>
					<li className="flex items-center">
						<Mail className="mr-2 size-4" />
						<span>Unlimited Agent Inboxes · 10 GB storage</span>
					</li>
					<li className="flex items-center">
						<Shield className="mr-2 size-4" />
						<span>Priority support</span>
					</li>
				</ul>
				<CloudUpgradePanel
					loadingPlan={loadingPlan}
					onCheckout={onCheckout}
					planLabel="Max"
					tiers={cloudTiers}
				/>
			</CardContent>
			<CardFooter>
				<PlanCta
					isCurrent={isCurrent}
					isLoading={isLoading}
					label="Upgrade"
					onClick={() => onCheckout(isYearly ? "max-yearly" : "max-monthly")}
				/>
			</CardFooter>
		</PricingCardBorder>
	);
}

/** Teams plan card — per-seat org plan, with the optional Cloud panel. */
export function TeamsPlanCard({
	isYearly = false,
	loadingPlan = null,
	onCheckout = noop,
	currentPlan = null,
	cloudTiers = [],
}: PlanCardProps & { cloudTiers?: readonly CloudHostingTier[] }) {
	const isCurrent = currentPlan === "teams";
	const isLoading =
		loadingPlan === "teams-monthly" || loadingPlan === "teams-yearly";
	return (
		<PricingCardBorder variant="teams">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					Teams
					<PlanBadge plan="teams" size="md" />
				</CardTitle>
				<CardDescription>We run AI for your whole team.</CardDescription>
			</CardHeader>
			<CardContent className="flex-1">
				<PriceBlock isYearly={isYearly} monthly={49} perSeat />
				<ul className="space-y-3">
					<li className="flex items-center">
						<ArrowLeft className="mr-2 size-4" />
						<span>Everything in Pro, plus:</span>
					</li>
					<li className="flex items-center">
						<Coins className="mr-2 size-4" />
						<span>Shared AI usage across your team</span>
					</li>
					<li className="flex items-center">
						<Users className="mr-2 size-4" />
						<span>One bill, one shared wallet</span>
					</li>
					<li className="flex items-center">
						<Shield className="mr-2 size-4" />
						<span>Roles &amp; permissions</span>
					</li>
					<li className="flex items-center">
						<Wrench className="mr-2 size-4" />
						<span>Manage seats &amp; spending</span>
					</li>
					<li className="flex items-center">
						<Mail className="mr-2 size-4" />
						<span>Unlimited Agent Inboxes · 20 GB storage</span>
					</li>
				</ul>
				<CloudUpgradePanel
					loadingPlan={loadingPlan}
					onCheckout={onCheckout}
					planLabel="Teams"
					tiers={cloudTiers}
				/>
				<p className="mt-4 text-muted-foreground text-xs">Minimum 2 seats</p>
			</CardContent>
			<CardFooter>
				<PlanCta
					isCurrent={isCurrent}
					isLoading={isLoading}
					label="Upgrade"
					onClick={() =>
						onCheckout(isYearly ? "teams-yearly" : "teams-monthly")
					}
					variant="outline"
				/>
			</CardFooter>
		</PricingCardBorder>
	);
}

/**
 * Enterprise plan — the "contact sales" tier, rendered as a FULL-WIDTH horizontal
 * band BELOW the four self-serve plans (spanning all columns), not a fifth column.
 * No self-serve checkout: the CTA links to the sales/contact page. Uses the
 * `enterprise` PlanBadge + gradient border (both already supported).
 */
export function EnterprisePlanCard() {
	return (
		<div className="mx-auto mb-12 max-w-7xl">
			<PricingCardBorder variant="enterprise">
				<div className="flex flex-col gap-6 p-6 md:flex-row md:items-center md:justify-between md:gap-10">
					<div className="md:max-w-xs">
						<div className="flex items-center gap-2">
							<span className="font-semibold text-xl">Enterprise</span>
							<PlanBadge label="Enterprise" plan="enterprise" size="md" />
						</div>
						<p className="mt-1 text-muted-foreground text-sm">
							We run AI across your whole organization.
						</p>
						<div className="mt-3 font-semibold text-3xl">Custom</div>
						<p className="text-muted-foreground text-xs">
							Tailored to your org · annual contract
						</p>
					</div>
					<ul className="flex flex-1 flex-wrap gap-x-8 gap-y-3">
						<li className="flex items-center">
							<ArrowLeft className="mr-2 size-4" />
							<span>Everything in Teams</span>
						</li>
						<li className="flex items-center">
							<Key className="mr-2 size-4" />
							<span>SSO &amp; SCIM</span>
						</li>
						<li className="flex items-center">
							<Shield className="mr-2 size-4" />
							<span>Audit logs &amp; SLAs</span>
						</li>
						<li className="flex items-center">
							<Users className="mr-2 size-4" />
							<span>Dedicated support</span>
						</li>
					</ul>
					<a
						className={buttonVariants({
							variant: "outline",
							className: "shrink-0 md:w-48",
						})}
						href="/contact"
					>
						Contact sales
					</a>
				</div>
			</PricingCardBorder>
		</div>
	);
}

/**
 * The pricing plans, presentational: the four self-serve plans in a grid, with
 * the Enterprise "contact sales" tier as a full-width band spanning all columns
 * below. Cloud hosting is NOT here — it lives in the org dashboard (post-auth).
 */
export function PricingPlanGrid({
	isYearly = false,
	loadingPlan = null,
	onCheckout = noop,
	currentPlan = null,
}: {
	isYearly?: boolean;
	loadingPlan?: PricingPlanSlug | null;
	onCheckout?: (slug: PricingPlanSlug) => void;
	currentPlan?: CurrentPricingPlan | null;
}) {
	return (
		<>
			<div className="mx-auto mb-12 grid max-w-7xl grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-4">
				<LifetimePlanCard
					currentPlan={currentPlan}
					isYearly={isYearly}
					loadingPlan={loadingPlan}
					onCheckout={onCheckout}
				/>
				<ProPlanCard
					currentPlan={currentPlan}
					isYearly={isYearly}
					loadingPlan={loadingPlan}
					onCheckout={onCheckout}
				/>
				<TeamsPlanCard
					currentPlan={currentPlan}
					isYearly={isYearly}
					loadingPlan={loadingPlan}
					onCheckout={onCheckout}
				/>
				<MaxPlanCard
					currentPlan={currentPlan}
					isYearly={isYearly}
					loadingPlan={loadingPlan}
					onCheckout={onCheckout}
				/>
			</div>
			<EnterprisePlanCard />
		</>
	);
}

/**
 * A single selectable Ryu Cloud instance, priced from the LIVE Hetzner catalog
 * (specs + live $/mo × markup), injected by the page. The USER never sees the
 * underlying Hetzner type name — only CPU / RAM / SSD + a perf label + price.
 * `type` is the opaque checkout key (passed back on select), never rendered.
 */
export interface PricingCloudInstance {
	/** True in the currently selected location. */
	readonly availableInLocation: boolean;
	readonly cores: number;
	readonly diskGb: number;
	/** True for the free base node bundled with Max (shown as "Included"). */
	readonly includedWithMax: boolean;
	readonly memoryGb: number;
	/** Customer-facing monthly USD (live × markup); 0 for the included base. */
	readonly monthlyUsd: number;
	/** User-facing perf class label ("Cost-optimized" | "Performance" | "ARM"). */
	readonly perfLabel: string;
	/** Opaque Hetzner type key — the checkout argument, NEVER displayed. */
	readonly type: string;
}

/** A selectable Hetzner location, shown to the user as city + country. */
export interface PricingCloudLocation {
	readonly city: string;
	readonly country: string;
	readonly id: string;
}

/**
 * Ryu Cloud dynamic instance picker — managed nodes (Core + Gateway hosted for
 * you). Reads a live catalog (specs + live $/mo × markup + regional
 * availability) injected by the page; the user picks a location and a node.
 * The base node ships free with Max (shown "Included with Max", never a
 * checkout); every other node is an ad-hoc cloud-instance subscription. The USER
 * only ever sees CPU / RAM / SSD + a perf label + price — never the Hetzner type
 * name. Presentational: the page fetches the catalog and wires the handlers.
 *
 * Cloud instances are billed monthly regardless of the plan monthly/yearly
 * toggle above (that toggle only applies to the subscription plans), so this
 * never reads `isYearly`.
 */
export function PricingInstancePicker({
	instances = [],
	locations = [],
	location = "",
	live = true,
	loadingType = null,
	onLocationChange = noop,
	onSelectInstance = noop,
}: {
	instances?: readonly PricingCloudInstance[];
	live?: boolean;
	loadingType?: string | null;
	location?: string;
	locations?: readonly PricingCloudLocation[];
	onLocationChange?: (locationId: string) => void;
	onSelectInstance?: (type: string) => void;
}) {
	if (instances.length === 0) {
		return null;
	}
	return (
		<div className="mx-auto mb-12 max-w-7xl">
			<div className="mb-6 text-center">
				<h2 className="flex items-center justify-center gap-2 font-semibold text-2xl">
					<Server className="size-5" />
					Ryu Cloud
				</h2>
				<p className="mt-1 text-muted-foreground">
					We host your node: Core, Gateway, and 24/7 agents. Your Max plan
					includes a free base node; add a bigger node whenever you need more
					performance.
				</p>
				<p className="mt-1 text-muted-foreground text-xs">
					Nodes are billed monthly at live cost. The yearly toggle doesn&apos;t
					apply to Cloud nodes.
				</p>
			</div>
			{locations.length > 0 ? (
				<div className="mb-6 flex items-center justify-center gap-2">
					<label
						className="text-muted-foreground text-sm"
						htmlFor="ryu-cloud-location"
					>
						Region
					</label>
					<select
						className="rounded-lg border bg-background px-3 py-2 text-sm"
						id="ryu-cloud-location"
						onChange={(event) => onLocationChange(event.target.value)}
						value={location}
					>
						{locations.map((loc) => (
							<option key={loc.id} value={loc.id}>
								{loc.city}, {loc.country}
							</option>
						))}
					</select>
				</div>
			) : null}
			<div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
				{instances.map((instance) => {
					const isIncluded = instance.includedWithMax;
					const isLoading = loadingType === instance.type;
					const unavailable = !(isIncluded || instance.availableInLocation);
					return (
						<Card
							className={
								isIncluded
									? "relative flex flex-col border-primary"
									: "relative flex flex-col"
							}
							key={instance.type}
						>
							<CardHeader>
								<CardTitle className="flex items-center gap-2 text-xl">
									{isIncluded ? (
										<Cloud className="size-4 text-primary" />
									) : (
										<Cpu className="size-4 text-primary" />
									)}
									{instance.perfLabel}
								</CardTitle>
								<CardDescription>
									{instance.cores} vCPU · {instance.memoryGb} GB RAM
								</CardDescription>
							</CardHeader>
							<CardContent className="flex-1">
								{isIncluded ? (
									<div className="mb-6 flex items-baseline">
										<span className="font-semibold text-4xl">Included</span>
										<span className="ml-2 text-muted-foreground">with Max</span>
									</div>
								) : (
									<div className="mb-6 flex items-baseline">
										<NumberTicker
											className="font-semibold text-4xl"
											prefix="$"
											value={instance.monthlyUsd}
										/>
										<span className="ml-1 text-muted-foreground">/mo</span>
									</div>
								)}
								<ul className="space-y-3">
									<li className="flex items-center">
										<Cpu className="mr-2 size-4" />
										<span>{instance.cores} vCPU</span>
									</li>
									<li className="flex items-center">
										<Server className="mr-2 size-4" />
										<span>{instance.memoryGb} GB RAM</span>
									</li>
									<li className="flex items-center">
										<Cloud className="mr-2 size-4" />
										<span>{instance.diskGb} GB SSD</span>
									</li>
								</ul>
							</CardContent>
							<CardFooter>
								{isIncluded ? (
									<Button className="w-full" disabled variant="outline">
										Included with Max
									</Button>
								) : (
									<Button
										className="w-full"
										disabled={isLoading || unavailable}
										onClick={() => onSelectInstance(instance.type)}
									>
										{isLoading ? (
											<>
												<Loader2 className="mr-2 size-4 animate-spin" />
												Processing…
											</>
										) : unavailable ? (
											"Not in this region"
										) : (
											"Deploy node"
										)}
									</Button>
								)}
							</CardFooter>
						</Card>
					);
				})}
			</div>
			<p className="mt-4 text-center text-muted-foreground text-xs">
				{live
					? "Prices track live compute cost."
					: "Estimated pricing — live catalog unavailable."}{" "}
				Self-hostable too: run `infra/provision.sh` against your own cloud
				account.
			</p>
		</div>
	);
}
