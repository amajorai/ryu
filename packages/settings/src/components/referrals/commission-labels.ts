/* Display labels for a commission row's server enums. The API sends the raw `sourceType`
   ("subscription", "marketplace") and `status` ("pending", "approved", "paid", "reversed",
   "rejected"); rendering them as-is showed lowercase English in every language. Each label is its
   own catalog message, and a value this build does not know gets a generic label rather than the
   raw enum. */

/** Any `tl()`-shaped translator: `useLiteralMessages()`, `translate`, … */
export type CommissionLabelTranslator = (source: string) => string;

/** The revenue a commission was earned from, e.g. "Subscription". */
export function commissionSourceLabel(
	sourceType: string,
	tl: CommissionLabelTranslator
): string {
	switch (sourceType) {
		case "subscription":
			return tl("Subscription");
		case "marketplace":
			return tl("Marketplace");
		default:
			return tl("Other source");
	}
}

/** Where a commission is in its lifecycle, e.g. "Paid". */
export function commissionStatusLabel(
	status: string,
	tl: CommissionLabelTranslator
): string {
	switch (status) {
		case "pending":
			return tl("Pending");
		case "approved":
			return tl("Approved");
		case "paid":
			return tl("Paid");
		case "reversed":
			return tl("Reversed");
		case "rejected":
			return tl("Rejected");
		default:
			return tl("Unknown status");
	}
}
