"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { ChevronDown, Cloud, Cpu, Loader2, Server } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { ENGLISH_PRICING_FORMAT } from "./data/standalone-pricing-locale.ts";
import { usePricingFormat } from "./pricing-card-copy.tsx";
import {
	ALWAYS_ON_SERVER_COPY,
	type CloudHostingTier,
	type PricingPlanSlug,
} from "./pricing-plan-prices.ts";
import { SubscriptionAgreement } from "./subscription-agreement.tsx";

/**
 * Apple-style expandable "add hosted compute" panel, nested inside a plan card
 * (Max and Teams). Collapsed by default; expands to reveal the Ryu Cloud
 * hosting ladder. The BASE node ships free with the plan (shown as "Included",
 * never a checkout); the 2X/3X performance tiers are paid add-ons priced on top
 * of the plan, each with its own checkout (separate monthly billing — the merge
 * is purely visual). Renders nothing when no tiers are supplied. `planLabel`
 * names the host plan in the copy.
 */
export function CloudUpgradePanel({
	tiers,
	loadingPlan,
	onCheckout,
}: {
	tiers: readonly CloudHostingTier[];
	loadingPlan: PricingPlanSlug | null;
	onCheckout: (slug: PricingPlanSlug) => void;
}) {
	const tl = useLiteralMessages();
	const format = usePricingFormat();
	const [expanded, setExpanded] = useState(false);

	if (tiers.length === 0) {
		return null;
	}

	return (
		<div className="mt-8">
			<button
				aria-expanded={expanded}
				className="flex w-full items-center justify-between gap-2 text-start font-medium text-sm"
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
				Included managed server, upgrade for more performance, add-ons billed
				monthly
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
							const specs = tl(
								"{cores} vCPU, {memoryGb} GB RAM, and {diskGb} GB SSD",
								{
									cores: tier.cores,
									diskGb: tier.diskGb,
									memoryGb: tier.memoryGb,
								}
							);
							// BASE ships free with the plan: shown, never a checkout. Its
							// shape is resolved per plan and region and can change without
							// a pricing change, so the included row names no figures; only
							// the paid add-ons quote the exact shape being bought.
							const isIncluded = tier.includedWithPlan ?? tier.includedWithMax;
							if (isIncluded) {
								return (
									<li key={tier.slug}>
										<div className="mt-3 flex w-full items-center gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3 text-start">
											<Cloud className="size-4 shrink-0 text-primary" />
											<span className="flex-1">
												<span className="block font-medium text-sm">
													{tl("{name} is {perf}", {
														name: tier.name,
														perf: tier.perfLabel,
													})}
												</span>
												<span className="block text-muted-foreground text-xs">
													{ALWAYS_ON_SERVER_COPY}
												</span>
											</span>
											<span className="shrink-0 font-medium text-primary text-sm">
												Included
											</span>
										</div>
									</li>
								);
							}
							const isLoading = loadingPlan === tier.slug;
							// The English terms keep their published "US$" figure.
							const termsPrice =
								format === ENGLISH_PRICING_FORMAT
									? `US$${tier.monthlyAddUsd}`
									: format.price(tier.monthlyAddUsd);
							return (
								<li key={tier.slug}>
									<SubscriptionAgreement
										blocked={isLoading}
										offerKey={`${tier.slug}:${tier.monthlyAddUsd}`}
										terms={tl(
											"Renews automatically at an additional {price} every month, plus applicable taxes, until canceled.",
											{ price: termsPrice }
										)}
									>
										{(canContinue) => (
											<button
												className="mt-3 flex w-full items-center gap-3 rounded-lg border p-3 text-start transition-colors hover:border-primary disabled:opacity-60"
												disabled={!canContinue}
												onClick={() => onCheckout(tier.slug)}
												type="button"
											>
												<Cpu className="size-4 shrink-0 text-primary" />
												<span className="flex-1">
													<span className="block font-medium text-sm">
														{tl("{name} is {perf}", {
															name: tier.name,
															perf: tier.perfLabel,
														})}
													</span>
													<span className="block text-muted-foreground text-xs">
														{specs}
													</span>
												</span>
												<span className="shrink-0 text-end">
													{isLoading ? (
														<Loader2 className="size-4 animate-spin" />
													) : (
														<span className="font-heading font-medium text-sm tabular-nums">
															{tl("{amount} per month", {
																amount: format.price(tier.monthlyAddUsd),
															})}
														</span>
													)}
												</span>
											</button>
										)}
									</SubscriptionAgreement>
								</li>
							);
						})}
					</motion.ul>
				) : null}
			</AnimatePresence>
		</div>
	);
}
