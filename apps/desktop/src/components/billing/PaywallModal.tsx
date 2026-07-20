// apps/desktop/src/components/billing/PaywallModal.tsx
//
// The desktop paywall (epic #496, Unit C1). Shown after the 7-day trial expires
// with no active Pro/Max/Teams subscription AND no valid desktop license key.
//
// Open-core: this gates Pro features + managed inference, NOT the app shell. It
// is DISMISSIBLE — closing it drops the user into free local chat (which stays
// usable forever). The user can: enter a license key (validated via the control
// plane → Polar), or open the web pricing page to subscribe / buy a license.

import {
	CheckmarkCircle02Icon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { Input } from "@ryu/ui/components/input";
import { TextSwap } from "@ryu/ui/components/text-swap";
import { useState } from "react";
import { sileo } from "sileo";
import { FRONTEND_URL } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import type { LicenseValidateResult } from "@/src/lib/api/billing.ts";
import { LicenseValidateError } from "@/src/lib/api/billing.ts";

interface PaywallModalProps {
	/** Validate + persist a license key; resolves to the validate result. */
	onApplyLicenseKey: (key: string) => Promise<LicenseValidateResult>;
	onOpenChange: (open: boolean) => void;
	open: boolean;
}

export function PaywallModal({
	open,
	onOpenChange,
	onApplyLicenseKey,
}: PaywallModalProps) {
	const [key, setKey] = useState("");
	const [validating, setValidating] = useState(false);

	const handleValidate = async () => {
		const trimmed = key.trim();
		if (!trimmed) {
			return;
		}
		setValidating(true);
		try {
			const result = await onApplyLicenseKey(trimmed);
			if (result.active) {
				sileo.success({ title: "License activated. Pro features unlocked." });
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
		openExternal(`${FRONTEND_URL.replace(/\/$/, "")}/pricing`).catch(() => {
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
					<div className="flex items-center gap-2">
						<HugeiconsIcon
							className="text-warning"
							icon={SparklesIcon}
							strokeWidth={2}
						/>
						<DialogTitle>Your free trial has ended</DialogTitle>
					</div>
					<DialogDescription>
						Basic local chat stays free. Unlock Pro features and Ryu-managed
						inference with a subscription or a desktop license key.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-2">
					<span className="font-medium text-sm">Have a license key?</span>
					<div className="flex items-center gap-2">
						<Input
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
						>
							<TextSwap>{validating ? "Checking..." : "Activate"}</TextSwap>
						</Button>
					</div>
				</div>

				<ul className="flex flex-col gap-1.5 text-muted-foreground text-sm">
					{[
						"Ryu-managed inference (no API keys needed)",
						"Cloud sync across devices",
						"Pro agents, teams, and gateway controls",
					].map((feature) => (
						<li className="flex items-center gap-2" key={feature}>
							<HugeiconsIcon
								className="text-success"
								icon={CheckmarkCircle02Icon}
								strokeWidth={2}
							/>
							{feature}
						</li>
					))}
				</ul>

				<button
					className="rounded-lg border border-dashed px-3 py-2 text-left text-muted-foreground text-xs transition-colors hover:text-foreground"
					onClick={handleByos}
					type="button"
				>
					Already pay for ChatGPT or Claude? Bring your own subscription — no
					extra API keys needed.{" "}
					<span className="text-foreground underline">Learn more</span>
				</button>

				<DialogFooter>
					<Button
						onClick={() => onOpenChange(false)}
						type="button"
						variant="ghost"
					>
						Continue with free chat
					</Button>
					<Button onClick={handleSubscribe} type="button">
						See plans
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
