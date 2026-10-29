import {
	type Checkout,
	Checkout$inboundSchema,
	Checkout$outboundSchema,
} from "@polar-sh/sdk/models/components/checkout";
import {
	type Customer,
	Customer$inboundSchema,
	Customer$outboundSchema,
} from "@polar-sh/sdk/models/components/customer";
import {
	type Product,
	Product$inboundSchema,
	Product$outboundSchema,
} from "@polar-sh/sdk/models/components/product";
import type { CustomersListResponse } from "@polar-sh/sdk/models/operations/customerslist";
import { haltIterator } from "@polar-sh/sdk/types/operations";

/** Complete native SDK responses; fixtures isolate vendor I/O, never its DTO ABI. */
export function polarCheckoutFixture(url: string): Checkout {
	const checkout = {
		id: "fixture-checkout",
		createdAt: new Date(0),
		modifiedAt: null,
		paymentProcessor: "stripe",
		status: "open",
		clientSecret: "fixture-checkout-secret",
		url,
		expiresAt: new Date("2030-01-01T00:00:00.000Z"),
		successUrl: "https://app.example.test/success",
		returnUrl: null,
		embedOrigin: null,
		amount: 2000,
		discountAmount: 0,
		netAmount: 2000,
		taxAmount: null,
		totalAmount: 2000,
		currency: "usd",
		allowTrial: null,
		activeTrialInterval: null,
		activeTrialIntervalCount: null,
		trialEnd: null,
		organizationId: "fixture-vendor-org",
		productId: null,
		productPriceId: null,
		discountId: null,
		allowDiscountCodes: true,
		requireBillingAddress: false,
		isDiscountApplicable: true,
		isFreeProductPrice: false,
		isPaymentRequired: true,
		isPaymentSetupRequired: false,
		isPaymentFormRequired: true,
		customerId: null,
		isBusinessCustomer: false,
		customerName: null,
		customerEmail: null,
		customerIpAddress: null,
		customerBillingName: null,
		customerBillingAddress: null,
		customerTaxId: null,
		paymentProcessorMetadata: {},
		billingAddressFields: {
			country: "required",
			state: "optional",
			city: "optional",
			postalCode: "optional",
			line1: "optional",
			line2: "optional",
		},
		trialInterval: null,
		trialIntervalCount: null,
		metadata: {},
		externalCustomerId: null,
		customerExternalId: null,
		products: [],
		product: null,
		productPrice: null,
		prices: null,
		discount: null,
		subscriptionId: null,
		attachedCustomFields: null,
		customerMetadata: {},
	} satisfies Checkout;
	return Checkout$inboundSchema.parse(Checkout$outboundSchema.parse(checkout));
}
export function polarCustomerFixture(
	input: Pick<Customer, "id" | "externalId" | "metadata">
): Customer {
	const customer = {
		...input,
		createdAt: new Date(0),
		modifiedAt: null,
		email: "fixture-customer@example.test",
		emailVerified: false,
		name: "Fixture customer",
		billingAddress: null,
		taxId: null,
		organizationId: "fixture-vendor-org",
		deletedAt: null,
		avatarUrl: "https://example.test/avatar.png",
	} satisfies Customer;
	return Customer$inboundSchema.parse(Customer$outboundSchema.parse(customer));
}
export function polarCustomerPageFixture(items: Customer[]) {
	const response = {
		result: { items, pagination: { totalCount: items.length, maxPage: 1 } },
	} satisfies CustomersListResponse;
	return haltIterator(response);
}
export function polarTopupProductFixture(
	id: string,
	priceAmount: number
): Product {
	const product = {
		id,
		createdAt: new Date(0),
		modifiedAt: null,
		trialInterval: null,
		trialIntervalCount: null,
		name: "Fixture top-up",
		description: null,
		recurringInterval: null,
		recurringIntervalCount: null,
		isRecurring: false,
		isArchived: false,
		organizationId: "fixture-vendor-org",
		metadata: {},
		prices: [
			{
				id: "fixture-product-price",
				createdAt: new Date(0),
				modifiedAt: null,
				source: "catalog",
				amountType: "fixed",
				isArchived: false,
				productId: id,
				type: "one_time",
				recurringInterval: null,
				priceCurrency: "usd",
				priceAmount,
			},
		],
		benefits: [],
		medias: [],
		attachedCustomFields: [],
	} satisfies Product;
	return Product$inboundSchema.parse(Product$outboundSchema.parse(product));
}

import {
	type Subscription,
	Subscription$inboundSchema,
	Subscription$outboundSchema,
} from "@polar-sh/sdk/models/components/subscription";
import type { SubscriptionsListResponse } from "@polar-sh/sdk/models/operations/subscriptionslist";
export function polarRecurringProductFixture(
	productId: string,
	priceId: string,
	priceAmount: number
): Product {
	const product = {
		...polarTopupProductFixture(productId, priceAmount),
		isRecurring: true,
		recurringInterval: "month",
		recurringIntervalCount: 1,
		prices: [
			{
				id: priceId,
				createdAt: new Date(0),
				modifiedAt: null,
				source: "catalog",
				amountType: "fixed",
				isArchived: false,
				productId,
				type: "recurring",
				recurringInterval: "month",
				priceCurrency: "usd",
				priceAmount,
			},
		],
	} satisfies Product;
	return Product$inboundSchema.parse(Product$outboundSchema.parse(product));
}
export function polarSubscriptionFixture(
	id: string,
	product: Product,
	customer: Customer
): Subscription {
	const price = product.prices.find((value) => value.amountType === "fixed");
	if (price?.amountType !== "fixed") {
		throw new Error("Expected the fixture's fixed recurring price");
	}
	const subscription = {
		createdAt: new Date(0),
		modifiedAt: null,
		id,
		amount: price.priceAmount,
		currency: "usd",
		recurringInterval: "month",
		recurringIntervalCount: 1,
		status: "active",
		currentPeriodStart: new Date("2026-01-01T00:00:00.000Z"),
		currentPeriodEnd: new Date("2030-01-01T00:00:00.000Z"),
		trialStart: null,
		trialEnd: null,
		cancelAtPeriodEnd: false,
		canceledAt: null,
		startedAt: new Date(0),
		endsAt: null,
		endedAt: null,
		customerId: customer.id,
		productId: product.id,
		discountId: null,
		checkoutId: null,
		customerCancellationReason: null,
		customerCancellationComment: null,
		metadata: {},
		customer,
		product,
		discount: null,
		prices: product.prices,
		meters: [],
	} satisfies Subscription;
	return Subscription$inboundSchema.parse(
		Subscription$outboundSchema.parse(subscription)
	);
}
export function polarSubscriptionPageFixture(items: Subscription[]) {
	const response = {
		result: { items, pagination: { totalCount: items.length, maxPage: 1 } },
	} satisfies SubscriptionsListResponse;
	return haltIterator(response);
}
