import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import type { OfferModel } from "./publish-offer.ts";

/** The listing's offer: free, one-time, subscription or update-limited pricing. */
export function PublishOfferFields({
	offerAmount,
	offerCurrency,
	offerInterval,
	offerMaxUpdates,
	offerModel,
	setOfferAmount,
	setOfferCurrency,
	setOfferInterval,
	setOfferMaxUpdates,
	setOfferModel,
}: {
	offerAmount: string;
	offerCurrency: string;
	offerInterval: "month" | "year";
	offerMaxUpdates: string;
	offerModel: OfferModel;
	setOfferAmount: (value: string) => void;
	setOfferCurrency: (value: string) => void;
	setOfferInterval: (value: "month" | "year") => void;
	setOfferMaxUpdates: (value: string) => void;
	setOfferModel: (value: OfferModel) => void;
}) {
	return (
		<div className="flex flex-col gap-3 border-border border-t pt-3">
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="publish-offer-model">Offer</Label>
				<Select<OfferModel>
					items={[
						{ label: "Free", value: "free" },
						{ label: "One-time purchase", value: "one_time" },
						{ label: "Subscription", value: "subscription" },
						{ label: "Bounded updates", value: "bounded_updates" },
					]}
					onValueChange={(value) => {
						if (value) {
							setOfferModel(value);
						}
					}}
					value={offerModel}
				>
					<SelectTrigger id="publish-offer-model">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="free">Free</SelectItem>
						<SelectItem value="one_time">One-time purchase</SelectItem>
						<SelectItem value="subscription">Subscription</SelectItem>
						<SelectItem value="bounded_updates">Bounded updates</SelectItem>
					</SelectContent>
				</Select>
			</div>

			{offerModel === "free" ? (
				<p className="text-muted-foreground text-xs">
					Free packages need no seller payout setup.
				</p>
			) : (
				<>
					<div className="grid grid-cols-[1fr_7rem] gap-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="publish-offer-amount">Price</Label>
							<Input
								id="publish-offer-amount"
								inputMode="decimal"
								min="0.01"
								onChange={(event) => setOfferAmount(event.target.value)}
								placeholder="12.00"
								step="0.01"
								type="number"
								value={offerAmount}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="publish-offer-currency">Currency</Label>
							<Input
								id="publish-offer-currency"
								maxLength={3}
								onChange={(event) =>
									setOfferCurrency(event.target.value.toUpperCase())
								}
								placeholder="USD"
								value={offerCurrency}
							/>
						</div>
					</div>

					{offerModel === "subscription" ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="publish-offer-interval">Billing interval</Label>
							<Select
								items={[
									{ label: "Monthly", value: "month" },
									{ label: "Yearly", value: "year" },
								]}
								onValueChange={(value) => {
									if (value === "month" || value === "year") {
										setOfferInterval(value);
									}
								}}
								value={offerInterval}
							>
								<SelectTrigger id="publish-offer-interval">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="month">Monthly</SelectItem>
									<SelectItem value="year">Yearly</SelectItem>
								</SelectContent>
							</Select>
						</div>
					) : null}

					{offerModel === "bounded_updates" ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="publish-offer-updates">Included updates</Label>
							<Input
								id="publish-offer-updates"
								max="10000"
								min="1"
								onChange={(event) => setOfferMaxUpdates(event.target.value)}
								step="1"
								type="number"
								value={offerMaxUpdates}
							/>
							<p className="text-muted-foreground text-xs">
								One-time charge; each update is authorized separately.
							</p>
						</div>
					) : null}
					<p className="text-muted-foreground text-xs">
						Paid offers require completed Stripe Connect seller payouts. Ryu
						keeps the offer and entitlement; Stripe handles checkout and
						payouts.
					</p>
				</>
			)}
		</div>
	);
}
