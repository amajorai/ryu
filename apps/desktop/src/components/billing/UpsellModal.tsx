// apps/desktop/src/components/billing/UpsellModal.tsx
//
// The soft, dismissible conversion upsell (free-tier gating plan, 2026-07-11
// addendum). Replaces the retired trial-expiry HARD wall: after the trial ends
// the user drops into the Free tier (the app shell stays fully usable) and this
// modal surfaces periodically with a personalized pitch instead of blocking.
//
// The server computes WHAT to pitch (ranked `UpsellCard`s from
// `selectUpsellCards`); this modal only renders them. The caller (the launch
// show-cadence in entitlement-context) decides WHEN to show and passes the
// already-fetched, non-empty cards in — so the modal never flashes an empty
// state. On show it stamps the server-side `lastUpsellShownAt` so it will not
// re-fire for ~7 days (or across the user's other devices).
//
// The Upgrade CTA hands off to `requestUpgrade()` (the existing detailed
// PaywallModal with plans + license-key entry); this modal is the gentle nudge,
// that one is the checkout surface.

import { SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { UpsellCard } from "@ryu/auth/lib/upsell";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { useEffect, useRef } from "react";
import { markUpsellConverted, markUpsellShown } from "@/src/lib/api/upsell.ts";

interface UpsellModalProps {
	/** The ranked pitch cards to render (guaranteed non-empty by the caller). */
	cards: UpsellCard[];
	/** Close without upgrading (the user stays on Free). */
	onOpenChange: (open: boolean) => void;
	/** Hand off to the detailed paywall (plans + license key). */
	onUpgrade: () => void;
	open: boolean;
}

export function UpsellModal({
	open,
	cards,
	onOpenChange,
	onUpgrade,
}: UpsellModalProps) {
	// Stamp `lastUpsellShownAt` once per open transition (not on every render), so
	// the cadence gap starts the moment the user actually sees the pitch.
	const stampedRef = useRef(false);
	useEffect(() => {
		if (open && !stampedRef.current && cards.length > 0) {
			stampedRef.current = true;
			markUpsellShown(cards.map((c) => c.id)).catch(() => undefined);
		}
		if (!open) {
			stampedRef.current = false;
		}
	}, [open, cards]);

	const handleUpgrade = () => {
		// Click-through intent signal (NOT a purchase — Polar attributes the real
		// conversion server-side). Fire-and-forget, then hand off to the paywall.
		markUpsellConverted(cards.map((c) => c.id)).catch(() => undefined);
		onOpenChange(false);
		onUpgrade();
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
						<DialogTitle>You're getting a lot out of Ryu</DialogTitle>
					</div>
					<DialogDescription>
						Here's what you've built so far. Upgrade to Pro to keep it growing
						with cloud sync, parallel runs, and Ryu-managed inference.
					</DialogDescription>
				</DialogHeader>

				<ul className="flex flex-col gap-2">
					{cards.map((card) => (
						<li
							className="flex flex-col gap-0.5 rounded-lg border bg-muted/40 px-3 py-2.5"
							key={card.id}
						>
							<span className="font-medium text-sm">{card.headline}</span>
							<span className="text-muted-foreground text-xs">
								{card.subtext}
							</span>
						</li>
					))}
				</ul>

				<DialogFooter>
					<Button
						onClick={() => onOpenChange(false)}
						type="button"
						variant="ghost"
					>
						Maybe later
					</Button>
					<Button onClick={handleUpgrade} type="button">
						Upgrade to Pro
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
