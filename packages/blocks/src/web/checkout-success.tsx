import PageHeader from "@ryu/ui/components/page-header";

export interface CheckoutSuccessProps {
	/** The Polar checkout id returned in the success redirect. */
	checkoutId?: string;
}

/**
 * The real post-checkout success page, presentational. The live route reads
 * the `checkout_id` search param and passes it in; the storyboard renders it
 * with a static id.
 */
export default function CheckoutSuccess({ checkoutId }: CheckoutSuccessProps) {
	return (
		<div className="px-4 py-8">
			<PageHeader
				subtitle={checkoutId ? `Checkout ID: ${checkoutId}` : undefined}
				title="Payment Successful!"
			/>
		</div>
	);
}
