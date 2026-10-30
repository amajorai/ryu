// apps/desktop/src/components/billing/PaywallModal.tsx
//
// The desktop paywall (epic #496, Unit C1). Shown after the 7-day trial expires
// with no active Pro/Max/Teams/Business subscription AND no valid desktop license key.
//
// Open-core: this gates Pro features + managed inference, NOT the app shell. It
// is DISMISSIBLE — closing it drops the user into free local chat (which stays
// usable forever). The user can open the web pricing page to subscribe / buy a
// license (the primary action), or reveal the license field and enter a key
// (validated via the control plane → Polar).

import { DESKTOP_TRIAL_LABEL, planLimit } from "@ryu/auth/lib/plans";
import { useLiteralMessages } from "@ryu/i18n/react";
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
import { TextSwap } from "@ryu/ui/components/text-swap.tsx";
import { useEffect, useRef, useState } from "react";
import { sileo } from "sileo";
import { FRONTEND_URL } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import type { LicenseValidateResult } from "@/src/lib/api/billing.ts";
import { LicenseValidateError } from "@/src/lib/api/billing.ts";

interface PaywallModalProps {
	intent?: "general" | "tabs";
	/** Validate + persist a license key; resolves to the validate result. */
	onApplyLicenseKey: (key: string) => Promise<LicenseValidateResult>;
	onOpenChange: (open: boolean) => void;
	open: boolean;
}

export function PaywallModal({
	open,
	intent = "general",
	onOpenChange,
	onApplyLicenseKey,
}: PaywallModalProps) {
	const tl = useLiteralMessages();
	const [key, setKey] = useState("");
	const [validating, setValidating] = useState(false);
	const [showLicense, setShowLicense] = useState(false);
	// Revealing the field replaces the button that had focus, so focus follows
	// into the field instead of dropping to the page.
	const licenseInputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (showLicense) {
			licenseInputRef.current?.focus();
		}
	}, [showLicense]);

	const handleValidate = async () => {
		const trimmed = key.trim();
		if (!trimmed) {
			return;
		}
		setValidating(true);
		try {
			const result = await onApplyLicenseKey(trimmed);
			if (result.active) {
				sileo.success({
					title: "Desktop license activated. Tab limit lifted.",
				});
				onOpenChange(false);
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

	const handleSubscribe = () => {
		openExternal(
			`${FRONTEND_URL.replace(/\/$/, "")}/pricing${intent === "tabs" ? "?audience=individual#plans" : ""}`
		).catch(() => {
			sileo.error({ title: "Could not open the pricing page." });
		});
	};

	// Bring-your-own-subscription: reuse the Claude Code / ChatGPT subscription
	// you already pay for instead of Ryu-managed credits. Only Claude and ChatGPT
	// have real subscription passthrough — do NOT widen this copy to other
	// providers. Learn more on the marketing /subscriptions page.
	const handleByos = () => {
		openExternal(`${FRONTEND_URL.replace(/\/$/, "")}/subscriptions`).catch(
			() => {
				sileo.error({ title: "Could not open the subscriptions page." });
			}
		);
	};

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{intent === "tabs"
							? "Open more tabs with a desktop license"
							: tl("Your {trialLabel} has ended", {
									trialLabel: DESKTOP_TRIAL_LABEL,
								})}
					</DialogTitle>
					<DialogDescription>
						{intent === "tabs"
							? tl(
									"The free desktop supports {tabLimit} open tabs. A desktop license unlocks unlimited tabs. Your existing tabs stay available.",
									{ tabLimit: String(planLimit(null, "maxOpenTabs")) }
								)
							: "Local desktop features stay free. A desktop license unlocks unlimited tabs; a subscription covers Ryu-managed inference."}
					</DialogDescription>
				</DialogHeader>

				<ul className="flex list-disc flex-col gap-1 ps-4 text-muted-foreground text-sm">
					{(intent === "tabs"
						? [
								"Unlimited open tabs",
								"Run work on your own hardware or with your own provider",
								"One-time desktop purchase; managed AI and hosting are separate",
							]
						: [
								"Unlimited tabs with a desktop license",
								"Ryu-managed inference with a subscription",
								"Choose the plan that fits where your work runs",
							]
					).map((feature) => (
						<li key={feature}>{feature}</li>
					))}
				</ul>

				<p className="text-muted-foreground text-sm">
					Already pay for ChatGPT or Claude?{" "}
					<Button
						className="h-auto p-0"
						onClick={handleByos}
						type="button"
						variant="link"
					>
						Bring your own subscription
					</Button>
				</p>

				{/* Most people subscribe; the license field opens on request. */}
				{showLicense ? (
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
							ref={licenseInputRef}
							value={key}
						/>
						<Button
							disabled={validating || key.trim().length === 0}
							onClick={() => {
								handleValidate().catch(() => undefined);
							}}
							variant="outline"
						>
							<TextSwap>{validating ? "Checking…" : "Activate"}</TextSwap>
						</Button>
					</div>
				) : (
					<Button
						className="self-start"
						onClick={() => setShowLicense(true)}
						size="sm"
						type="button"
						variant="ghost-muted"
					>
						Have a license key?
					</Button>
				)}

				<DialogFooter>
					<Button
						onClick={() => onOpenChange(false)}
						type="button"
						variant="ghost"
					>
						{intent === "tabs"
							? "Keep my current tabs"
							: "Continue with free chat"}
					</Button>
					<Button onClick={handleSubscribe} type="button" variant="mono">
						{intent === "tabs" ? "Get desktop license" : "See plans"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
