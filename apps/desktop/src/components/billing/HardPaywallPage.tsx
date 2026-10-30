// apps/desktop/src/components/billing/HardPaywallPage.tsx
//
// The desktop HARD paywall (epic #496). Unlike the dismissible PaywallModal,
// this is a full-page, non-dismissible gate rendered INSTEAD of the app shell
// once the trial has expired with no active subscription and no valid desktop
// license key (`verdict.paywalled`). The user cannot use the app until they:
//   - buy Lifetime access or subscribe to Pro (the two headline options),
//   - activate a desktop license key (a quiet footer action; validated via the
//     control plane → Polar),
//   - expand "Want to run ryu 24/7?" for the Max plan (+ Ryu Cloud hosting), or
//   - expand "Other plans" for the Teams agent plan.
//
// Checkout runs through the control-plane's generic bearer-authed endpoint
// (createCheckout) and opens the hosted Polar URL externally. Teams is
// organization-scoped, so it opens the web pricing page for the agent contract.
//
// This is a deliberate departure from the open-core "never block the shell"
// stance: it is a hard paywall by product decision.

import {
	LifetimePlanCard,
	MaxPlanCard,
	PricingBillingToggle,
	type PricingPlanSlug,
	ProPlanCard,
	TeamsPlanCard,
} from "@ryu/blocks/web/pricing.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Logo as OrbLogo } from "@ryu/ui/components/logo.tsx";
import { PageHeader } from "@ryu/ui/components/page-header.tsx";
import { TextSwap } from "@ryu/ui/components/text-swap.tsx";
import { useState } from "react";
import { sileo } from "sileo";
import { clearSessionToken, FRONTEND_URL, signOut } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useStepUp } from "@/src/components/StepUpDialog.tsx";
import {
	BouncyAccordion,
	type BouncyAccordionItem,
} from "@/src/components/ui/bouncy-accordion.tsx";
import type { LicenseValidateResult } from "@/src/lib/api/billing.ts";
import {
	CheckoutError,
	createCheckout,
	LicenseValidateError,
} from "@/src/lib/api/billing.ts";

// Cloud hosting is now a dynamic, live-priced instance picker on the web pricing
// page (POLAR_PRODUCT_CLOUD_INSTANCE, ad-hoc pricing). The desktop hard paywall
// links out to /pricing for cloud; it no longer nests a fixed hosted-compute panel.

const WEB_PRICING_URL = `${FRONTEND_URL.replace(/\/$/, "")}/pricing`;

interface HardPaywallPageProps {
	/** Validate + persist a license key; resolves to the validate result. */
	onApplyLicenseKey: (key: string) => Promise<LicenseValidateResult>;
}

export function HardPaywallPage({ onApplyLicenseKey }: HardPaywallPageProps) {
	const [isYearly, setIsYearly] = useState(false);
	const [loadingPlan, setLoadingPlan] = useState<PricingPlanSlug | null>(null);
	const [licenseDialogOpen, setLicenseDialogOpen] = useState(false);
	const [key, setKey] = useState("");
	const [validating, setValidating] = useState(false);
	const [switchingAccount, setSwitchingAccount] = useState(false);
	const stepUp = useStepUp();

	const handleCheckout = async (slug: PricingPlanSlug) => {
		// Teams is per-seat and refused by the generic checkout endpoint; send the
		// user to the web pricing page where the seat-aware flow lives.
		if (slug.startsWith("teams")) {
			openExternal(WEB_PRICING_URL).catch(() => {
				sileo.error({ title: "Could not open the pricing page." });
			});
			return;
		}
		setLoadingPlan(slug);
		try {
			const checkout = await stepUp.guard("billing", () =>
				createCheckout(slug)
			);
			if (checkout === null) {
				return;
			}
			const url = checkout;
			await openExternal(url);
		} catch (error) {
			const message =
				error instanceof CheckoutError
					? error.message
					: "Failed to start checkout. Please try again.";
			sileo.error({ title: message });
		} finally {
			setLoadingPlan(null);
		}
	};

	const handleValidate = async () => {
		const trimmed = key.trim();
		if (!trimmed) {
			return;
		}
		setValidating(true);
		try {
			const result = await onApplyLicenseKey(trimmed);
			if (result.active) {
				sileo.success({ title: "License activated. Welcome back." });
				setLicenseDialogOpen(false);
				setKey("");
				// On success the verdict re-resolves and this page unmounts itself.
			} else {
				sileo.error({
					title: "That license key is not valid or has been revoked.",
				});
			}
		} catch (error) {
			const message =
				error instanceof LicenseValidateError
					? error.message
					: "Could not validate the license key. Please try again.";
			sileo.error({ title: message });
		} finally {
			setValidating(false);
		}
	};

	const handleSwitchAccount = async () => {
		if (switchingAccount) {
			return;
		}
		setSwitchingAccount(true);
		try {
			await Promise.all([signOut(), clearSessionToken()]);
		} finally {
			window.location.reload();
		}
	};

	const secondaryPlanItems: BouncyAccordionItem[] = [
		{
			id: "max",
			title: "Want to run ryu 24/7?",
			description: (
				<div className="-mx-3 pt-2">
					<MaxPlanCard
						isYearly={isYearly}
						loadingPlan={loadingPlan}
						onCheckout={handleCheckout}
					/>
				</div>
			),
		},
		{
			id: "teams",
			title: "Other plans",
			description: (
				<div className="-mx-3 pt-2">
					<TeamsPlanCard
						isYearly={isYearly}
						loadingPlan={loadingPlan}
						onCheckout={handleCheckout}
					/>
				</div>
			),
		},
	];

	return (
		<div className="flex size-full flex-col">
			{/* top strip is the drag region */}
			<div
				aria-hidden
				className="h-10 w-full shrink-0"
				data-tauri-drag-region="true"
			/>
			<div className="scroll-fade min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex min-h-full w-full max-w-3xl flex-col items-center gap-8 px-6 pt-12 pb-16">
					<div className="flex w-full max-w-md flex-col items-center gap-6">
						<div className="shrink-0">
							<OrbLogo size="32px" variant="outline" />
						</div>

						<PageHeader
							className="w-full text-center"
							size="app"
							subtitle="Lifetime or Pro keeps sync, pro agents and cloud models on every device."
							title="Choose a plan"
							titleClassName="text-balance text-center"
						/>
					</div>

					<Dialog onOpenChange={setLicenseDialogOpen} open={licenseDialogOpen}>
						<DialogContent className="sm:max-w-md">
							<DialogHeader>
								<DialogTitle>Activate your license key</DialogTitle>
								<DialogDescription>
									Enter the key from your Lifetime purchase. We&apos;ll unlock
									access on this account.
								</DialogDescription>
							</DialogHeader>
							<div className="flex items-center gap-2">
								<Input
									aria-label="License key"
									autoComplete="off"
									className="flex-1"
									disabled={validating}
									onChange={(e) => setKey(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											handleValidate().catch(() => undefined);
										}
									}}
									placeholder="RYU-XXXX-XXXX-XXXX"
									value={key}
								/>
								<Button
									disabled={validating || key.trim().length === 0}
									onClick={() => {
										handleValidate().catch(() => undefined);
									}}
									variant="mono"
								>
									<TextSwap>{validating ? "Checking…" : "Activate"}</TextSwap>
								</Button>
							</div>
							<DialogFooter showCloseButton />
						</DialogContent>
					</Dialog>

					<div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
						<div className="flex justify-center">
							<PricingBillingToggle
								isYearly={isYearly}
								onToggleYearly={setIsYearly}
							/>
						</div>

						<div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
							<LifetimePlanCard
								loadingPlan={loadingPlan}
								onCheckout={handleCheckout}
							/>
							<ProPlanCard
								isYearly={isYearly}
								loadingPlan={loadingPlan}
								onCheckout={handleCheckout}
							/>
						</div>

						<BouncyAccordion
							classNames={{
								item: "border-0 bg-transparent shadow-none",
								description: "text-foreground leading-normal",
								title: "truncate font-medium",
							}}
							collapsible
							items={secondaryPlanItems}
						/>
					</div>

					<footer className="flex flex-wrap items-center justify-center gap-2 text-sm">
						{/* The license path is for people who already bought: a quiet
						    footer action, not the first thing on the page. */}
						<Button
							onClick={() => setLicenseDialogOpen(true)}
							type="button"
							variant="ghost"
						>
							I have a license key
						</Button>
						<Button
							disabled={switchingAccount}
							onClick={() => {
								handleSwitchAccount().catch(() => undefined);
							}}
							variant="ghost"
						>
							{switchingAccount ? "Switching account…" : "Switch account"}
						</Button>
						<Button
							onClick={() => {
								openExternal(WEB_PRICING_URL).catch(() => {
									sileo.error({ title: "Could not open the pricing page." });
								});
							}}
							variant="ghost"
						>
							Compare all plans
						</Button>
					</footer>
				</div>
			</div>
			{stepUp.dialog}
		</div>
	);
}
