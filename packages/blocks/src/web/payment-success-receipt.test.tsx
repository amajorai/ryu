import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type PaymentSuccessKind,
	PaymentSuccessReceipt,
} from "./payment-success-receipt.tsx";

test("prints a reusable top-up receipt without exposing the provider checkout id", () => {
	const checkoutId = "polar_checkout_test_123456";
	const html = renderToStaticMarkup(
		<PaymentSuccessReceipt checkoutId={checkoutId} kind="topup" />
	);

	expect(html).toContain('data-testid="payment-success-receipt"');
	expect(html).toContain("Top-up complete");
	expect(html).toContain("Syncing");
	expect(html).toContain("wallet update clears");
	expect(html).toContain("RYU-");
	expect(html).not.toContain(checkoutId);
});

test("keeps every payment family on the shared receipt surface", () => {
	const kinds: PaymentSuccessKind[] = [
		"payment",
		"topup",
		"plan",
		"subscription",
		"upgrade",
		"purchase",
		"gift",
		"cloud",
	];

	for (const kind of kinds) {
		const html = renderToStaticMarkup(
			<PaymentSuccessReceipt checkoutId={`checkout-${kind}`} kind={kind} />
		);

		expect(html).toContain('data-testid="payment-success-receipt"');
		expect(html).toContain("paid");
	}
});

test("an unknown currency code still prints the amount in the reader's locale", async () => {
	const { I18nProvider } = await import("@ryu/i18n/react");
	const html = renderToStaticMarkup(
		<I18nProvider initialLocale="de" initialPackId={null}>
			<PaymentSuccessReceipt amount={1234.5} currency="x1" kind="payment" />
		</I18nProvider>
	);

	expect(html).toContain("X1 1.234,50");
	expect(html).not.toContain("1234.50");
});
