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
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useCallback, useState } from "react";
import { z } from "zod";
import type { PlatformView as PlatformSource } from "../ugc-wire-contracts.ts";
import { describeError, dollarsToCents, useUgcCall } from "./ugc-format.ts";
import { ErrorBanner } from "./ugc-primitives.tsx";

// ── Dialogs ──────────────────────────────────────────────────────────────────

const payoutRuleDraftKindSchema = z.enum(["cpm_cents", "flat_cents"]);

interface PayoutRuleDraft {
	amount: string;
	kind: "cpm_cents" | "flat_cents";
}

export function NewCampaignDialog({
	onCreated,
	onOpenChange,
	open,
	platforms,
}: {
	onCreated: () => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	platforms: PlatformSource[];
}) {
	const call = useUgcCall();
	const [brand, setBrand] = useState("");
	const [brief, setBrief] = useState("");
	const [budget, setBudget] = useState("");
	const [maxPerCreator, setMaxPerCreator] = useState("");
	const [rule, setRule] = useState<PayoutRuleDraft>({
		amount: "",
		kind: "cpm_cents",
	});
	const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const togglePlatform = useCallback((platform: string) => {
		setSelectedPlatforms((prev) =>
			prev.includes(platform)
				? prev.filter((p) => p !== platform)
				: [...prev, platform]
		);
	}, []);

	const submit = useCallback(async () => {
		setError(null);
		const budgetCents = budget.trim() ? dollarsToCents(budget) : 0;
		const ruleCents = dollarsToCents(rule.amount);
		const capCents = maxPerCreator.trim() ? dollarsToCents(maxPerCreator) : 0;
		if (budgetCents === null || capCents === null) {
			setError(
				"Budget and per-creator cap must be amounts like 250 or 250.00."
			);
			return;
		}
		if (ruleCents === null) {
			setError(
				rule.kind === "cpm_cents"
					? "Enter the payout per 1,000 views, e.g. 2.50."
					: "Enter the flat payout per approved post, e.g. 50."
			);
			return;
		}
		setSaving(true);
		try {
			await call("/campaigns", {
				body: JSON.stringify({
					brand: brand.trim(),
					brief: brief.trim(),
					budget_cents: budgetCents,
					max_payout_per_creator_cents: capCents,
					// EXACT wire shape of the sidecar's `CampaignBody.payout`: the field
					// is `payout` (not `payout_rule`), and `PayoutRule` is externally
					// tagged, so the `type` discriminant is mandatory. `CampaignBody`
					// does not deny unknown fields and `payout` carries `#[serde(default)]`
					// — a mis-named or untagged rule is therefore accepted and silently
					// becomes `flat 0c`, i.e. a campaign that accrues nothing forever.
					payout:
						rule.kind === "cpm_cents"
							? { cpm_cents: ruleCents, type: "cpm" }
							: { flat_cents: ruleCents, type: "flat" },
					platforms: selectedPlatforms,
					status: "draft",
				}),
				method: "POST",
			});
			onCreated();
			onOpenChange(false);
			setBrand("");
			setBrief("");
			setBudget("");
			setMaxPerCreator("");
			setRule({ amount: "", kind: "cpm_cents" });
			setSelectedPlatforms([]);
		} catch (err) {
			setError(describeError(err));
		} finally {
			setSaving(false);
		}
	}, [
		brand,
		brief,
		budget,
		call,
		maxPerCreator,
		onCreated,
		onOpenChange,
		rule,
		selectedPlatforms,
	]);

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>New campaign</DialogTitle>
					<DialogDescription>
						Campaigns start as drafts. Amounts are stored as integer cents.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="ugc-campaign-brand">Brand</Label>
						<Input
							id="ugc-campaign-brand"
							onChange={(e) => setBrand(e.target.value)}
							placeholder="Acme"
							value={brand}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="ugc-campaign-brief">Brief</Label>
						<Textarea
							id="ugc-campaign-brief"
							onChange={(e) => setBrief(e.target.value)}
							placeholder="What creators should post, required hashtags and mentions…"
							value={brief}
						/>
					</div>
					<fieldset className="flex flex-col gap-1.5">
						<legend className="font-medium text-sm">Platforms</legend>
						<div className="flex flex-wrap gap-1.5">
							{platforms.length === 0 ? (
								<span className="text-muted-foreground text-xs">
									The sidecar reported no platforms.
								</span>
							) : null}
							{platforms.map((p) => (
								<Button
									aria-pressed={selectedPlatforms.includes(p.platform)}
									key={p.platform}
									onClick={() => togglePlatform(p.platform)}
									size="xs"
									type="button"
									variant={
										selectedPlatforms.includes(p.platform)
											? "secondary"
											: "outline"
									}
								>
									{p.label}
								</Button>
							))}
						</div>
					</fieldset>
					<div className="grid grid-cols-2 gap-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="ugc-campaign-budget">Budget (USD)</Label>
							<Input
								id="ugc-campaign-budget"
								inputMode="decimal"
								onChange={(e) => setBudget(e.target.value)}
								placeholder="0 = uncapped"
								value={budget}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="ugc-campaign-cap">Max per creator (USD)</Label>
							<Input
								id="ugc-campaign-cap"
								inputMode="decimal"
								onChange={(e) => setMaxPerCreator(e.target.value)}
								placeholder="0 = uncapped"
								value={maxPerCreator}
							/>
						</div>
					</div>
					<div className="grid grid-cols-2 gap-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="ugc-campaign-rule">Payout rule</Label>
							<NativeSelect
								className="w-full"
								id="ugc-campaign-rule"
								onChange={(e) =>
									setRule((prev) => ({
										...prev,
										kind: payoutRuleDraftKindSchema.parse(e.target.value),
									}))
								}
								value={rule.kind}
							>
								<NativeSelectOption value="cpm_cents">
									Per 1,000 views
								</NativeSelectOption>
								<NativeSelectOption value="flat_cents">
									Flat per approved post
								</NativeSelectOption>
							</NativeSelect>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="ugc-campaign-rate">Rate (USD)</Label>
							<Input
								id="ugc-campaign-rate"
								inputMode="decimal"
								onChange={(e) =>
									setRule((prev) => ({ ...prev, amount: e.target.value }))
								}
								placeholder="2.50"
								value={rule.amount}
							/>
						</div>
					</div>
					{error ? <ErrorBanner message={error} /> : null}
				</div>
				<DialogFooter>
					<Button
						onClick={() => onOpenChange(false)}
						type="button"
						variant="ghost"
					>
						Cancel
					</Button>
					<Button
						disabled={brand.trim().length === 0}
						loading={saving}
						onClick={() => {
							submit().catch(() => undefined);
						}}
						type="button"
					>
						Create campaign
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
