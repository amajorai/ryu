"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
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
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Cloud, Cpu, Server } from "lucide-react";
import { usePricingCtaVariant } from "./pricing-appearance.tsx";
import { noop } from "./pricing-plan-prices.ts";
import { SubscriptionAgreement } from "./subscription-agreement.tsx";

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
	/** True for the generic base candidate; retained for compatibility. */
	readonly includedWithMax: boolean;
	/** True when this exact instance is included by the selected plan and region. */
	readonly includedWithPlan?: boolean;
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
 * The base node ships free with every recurring plan (shown "Included with
 * your plan", never a
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
	const tl = useLiteralMessages();
	const ctaVariant = usePricingCtaVariant();
	if (instances.length === 0) {
		return null;
	}
	return (
		<div className="mx-auto mb-12 max-w-7xl">
			<div className="mb-6 text-center">
				<h2 className="flex items-center justify-center gap-2 font-medium text-2xl">
					<Server className="size-5" />
					Ryu Cloud
				</h2>
				<p className="mt-1 text-muted-foreground">
					We host Core, Gateway, and your agents on your server. Your hosted
					plan includes a base server, and you can add a bigger server when you
					need more performance
				</p>
				<p className="mt-1 text-muted-foreground text-xs">
					Servers are billed monthly at live cost. The yearly toggle
					doesn&apos;t apply to Cloud servers
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
					<Select
						items={locations.map((loc) => ({
							label: `${loc.city}, ${loc.country}`,
							value: loc.id,
						}))}
						// The Select can emit `null` when cleared; there is no
						// "no location" state to report, so that case is ignored.
						onValueChange={(value) => {
							if (value !== null) {
								onLocationChange(value);
							}
						}}
						value={location}
					>
						<SelectTrigger className="w-56" id="ryu-cloud-location">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{locations.map((loc) => (
								<SelectItem key={loc.id} value={loc.id}>
									{loc.city}, {loc.country}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			) : null}
			<div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
				{instances.map((instance) => {
					const isIncluded =
						instance.includedWithPlan ?? instance.includedWithMax;
					const isLoading = loadingType === instance.type;
					const unavailable = !(isIncluded || instance.availableInLocation);
					return (
						<Card
							borderTone={isIncluded ? "included" : "default"}
							className={"relative flex flex-col"}
							key={instance.type}
						>
							<CardHeader>
								<CardTitle layout="badge-row" variant="plan">
									{isIncluded ? (
										<Cloud className="size-4 text-primary" />
									) : (
										<Cpu className="size-4 text-primary" />
									)}
									{instance.perfLabel}
								</CardTitle>
								<CardDescription>
									{tl("{cores} vCPU, {memoryGb} GB RAM, and {diskGb} GB SSD", {
										cores: String(instance.cores),
										diskGb: String(instance.diskGb),
										memoryGb: String(instance.memoryGb),
									})}
								</CardDescription>
							</CardHeader>
							<CardContent className="flex-1">
								{isIncluded ? (
									<div className="mb-6 flex items-baseline">
										<span className="font-medium text-4xl">Included</span>
										<span className="ml-2 text-muted-foreground">
											with your plan
										</span>
									</div>
								) : (
									<div className="mb-6 flex items-baseline">
										<NumberTicker
											prefix="$"
											value={instance.monthlyUsd}
											variant="plan-price"
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
										<span>
											{tl("{memoryGb} GB RAM", {
												memoryGb: String(instance.memoryGb),
											})}
										</span>
									</li>
									<li className="flex items-center">
										<Cloud className="mr-2 size-4" />
										<span>
											{tl("{diskGb} GB SSD", {
												diskGb: String(instance.diskGb),
											})}
										</span>
									</li>
								</ul>
							</CardContent>
							<CardFooter>
								{isIncluded ? (
									<Button className="w-full" disabled variant="outline">
										Included with your plan
									</Button>
								) : (
									<SubscriptionAgreement
										blocked={unavailable || isLoading}
										offerKey={`${location}:${instance.type}:${instance.monthlyUsd}`}
										terms={tl(
											"Renews automatically at {price} every month, plus applicable taxes, until canceled.",
											{ price: `US$${instance.monthlyUsd}` }
										)}
									>
										{(canContinue) => (
											<Button
												className="w-full"
												disabled={!canContinue}
												loading={isLoading}
												onClick={() => onSelectInstance(instance.type)}
												variant={ctaVariant}
											>
												{isLoading
													? "Processing"
													: unavailable
														? "Not in this region"
														: "Deploy server"}
											</Button>
										)}
									</SubscriptionAgreement>
								)}
							</CardFooter>
						</Card>
					);
				})}
			</div>
			<p className="mt-4 text-center text-muted-foreground text-xs">
				{live
					? "Prices track live compute cost You can self-host by running `infra/provision.sh` against your own cloud account"
					: "Estimated pricing because the live catalog is unavailable You can self-host by running `infra/provision.sh` against your own cloud account"}
			</p>
		</div>
	);
}
