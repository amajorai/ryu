"use client";

import { Switch } from "@ryu/ui/components/switch.tsx";
import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs";
import { cn } from "@ryu/ui/lib/utils";
import {
	noop,
	type PricingAudience,
	type PricingDeployment,
} from "./pricing-plan-prices.ts";

/**
 * THE DEPLOYMENT SWITCH — platform vs self-hosted.
 *
 * This is the page's large, label-only text switch. It sits above the two
 * pricing controls below it: audience uses `pills-lg`, while billing stays on
 * the compact `pills` treatment. Billing remains on the platform side, while
 * the audience control also selects the Individual or Enterprise self-hosted
 * shelf.
 */
export function PricingDeploymentToggle({
	standaloneEnabled = false,
	deployment = "platform",
	onDeploymentChange = noop,
}: {
	deployment?: PricingDeployment;
	standaloneEnabled?: boolean;
	onDeploymentChange?: (deployment: PricingDeployment) => void;
}) {
	return (
		<div className="mx-auto mb-8 flex justify-center">
			<Tabs
				aria-label="Deployment"
				onValueChange={(value) =>
					// SAFETY: this Tabs root contains only the authored platform,
					// self-hosted, and standalone triggers below; its selection callback forwards their values.
					onDeploymentChange(value as PricingDeployment)
				}
				value={deployment}
			>
				<TabsList className="flex-wrap" manageLayout={false} variant="text">
					<TabsTrigger typography="pricing-plan" value="platform">
						Ryu Platform
					</TabsTrigger>
					<TabsTrigger typography="pricing-plan" value="self-hosted">
						Self-Hosted
					</TabsTrigger>
					{standaloneEnabled ? (
						<TabsTrigger typography="pricing-plan" value="standalone">
							Standalone services
						</TabsTrigger>
					) : null}
				</TabsList>
			</Tabs>
		</div>
	);
}

/**
 * The audience switch sits above platform billing: it changes which plans
 * exist, while the billing toggle only changes how the visible ones are billed.
 *
 * The platform uses Teams & Enterprise for its organization shelf; self-hosted
 * uses the same control for the Enterprise shelf.
 */
export function PricingAudienceToggle({
	audience = "business",
	businessLabel = "Teams & Enterprise",
	onAudienceChange = noop,
}: {
	audience?: PricingAudience;
	businessLabel?: string;
	onAudienceChange?: (audience: PricingAudience) => void;
}) {
	return (
		<div className="mb-4 flex justify-center">
			<Tabs
				onValueChange={(val) =>
					// SAFETY: the only triggers in this local Tabs root have the
					// authored individual/business values of PricingAudience.
					onAudienceChange(val as PricingAudience)
				}
				value={audience}
			>
				<TabsList className="min-w-max" manageLayout={false} variant="pills-lg">
					<TabsTrigger typography="pricing-audience" value="individual">
						Individual
					</TabsTrigger>
					<TabsTrigger typography="pricing-audience" value="business">
						{businessLabel}
					</TabsTrigger>
				</TabsList>
			</Tabs>
		</div>
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
		<div
			aria-label="Billing period"
			className="mb-8 flex items-center justify-center gap-3"
			role="group"
		>
			<span
				className={cn(
					"text-sm transition-colors",
					isYearly ? "text-muted-foreground" : "font-medium text-foreground"
				)}
			>
				Monthly
			</span>
			<Switch
				aria-label="Yearly billing"
				checked={isYearly}
				onCheckedChange={onToggleYearly}
			/>
			<span
				className={cn(
					"inline-flex items-center gap-1.5 text-sm transition-colors",
					isYearly ? "font-medium text-foreground" : "text-muted-foreground"
				)}
			>
				Yearly
				<span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary text-xs">
					2 months free
				</span>
			</span>
		</div>
	);
}
