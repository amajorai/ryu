import { z } from "zod";

/** Polar, Stripe, marketplace monetization and affiliate settings. */
export const billingServerEnv = {
	// Polar
	POLAR_ORGANIZATION_ID: z.string().optional(),
	// Polar's Stripe publishable key for this POLAR_SERVER (Polar is merchant
	// of record, so cards are tokenized on Polar's Stripe account). Ryu's
	// payment-method page needs it to add a card; without it the page can list
	// and remove saved methods only.
	POLAR_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
	POLAR_SERVER: z.enum(["sandbox", "production"]).default("sandbox"),
	// Explicit migration switch. Keep legacy until the Polar meter/benefit
	// catalog and existing balances have been reconciled.
	POLAR_BILLING_AUTHORITY: z.enum(["local", "polar"]).default("local"),
	POLAR_METER_MANAGED_CREDITS: z.string().optional(),
	POLAR_METER_POOL_CLOUDFLARE: z.string().optional(),
	POLAR_METER_POOL_BEDROCK: z.string().optional(),
	POLAR_METER_POOL_VERTEX: z.string().optional(),
	POLAR_METER_POOL_OPENAI_CREDITS: z.string().optional(),
	POLAR_METER_POOL_ANTHROPIC_CREDITS: z.string().optional(),
	// Plan-catalog product/price ids. All optional: each falls back to the
	// documented default in `@ryu/auth/lib/plans`.
	POLAR_PRODUCT_DESKTOP_LICENSE: z.string().optional(),
	// Fixed $71 discount that turns the $200 lifetime list product into the
	// $129 launch offer. The checkout route fails closed when it is absent.
	POLAR_LIFETIME_LAUNCH_DISCOUNT_ID: z.string().optional(),
	POLAR_PRODUCT_MARKETPLACE_MEMBERSHIP_MONTHLY: z.string().optional(),
	POLAR_PRODUCT_MARKETPLACE_MEMBERSHIP_YEARLY: z.string().optional(),
	POLAR_PRODUCT_PRO_MONTHLY: z.string().optional(),
	POLAR_PRODUCT_PRO_YEARLY: z.string().optional(),
	POLAR_PRODUCT_MAX_MONTHLY: z.string().optional(),
	POLAR_PRODUCT_MAX_YEARLY: z.string().optional(),
	POLAR_PRODUCT_TEAMS_MONTHLY: z.string().optional(),
	POLAR_PRODUCT_TEAMS_YEARLY: z.string().optional(),
	// Single recurring product cloud-instance checkouts attach an ad-hoc
	// fixed price to (per-checkout amount = round(live Hetzner cost × markup);
	// the product's own base price is only a catalog placeholder). Qualifying
	// hosted plans include their documented base node, so BASE has no charge.
	// Optional: absent ⇒ ad-hoc cloud-instance checkout is refused.
	POLAR_PRODUCT_CLOUD_INSTANCE: z.string().optional(),
	// Pay-what-you-want product credit top-ups check out against (Unit B2).
	POLAR_PRODUCT_CREDITS: z.string().optional(),
	POLAR_PRODUCT_STANDALONE_PROTOTYPE: z.string().optional(),
	POLAR_PRODUCT_STANDALONE_ACCELERATE: z.string().optional(),
	// One-time custom-price product for Ryu gift cards, credit gifts, and
	// non-renewing subscription gifts.
	POLAR_PRODUCT_GIFTS: z.string().optional(),
	// FIXED-price product auto top-up charges off-session (its price must equal
	// the configured pack `amountCents`). Optional: absent ⇒ auto-topup cannot
	// charge and is effectively off. Requires the Polar org to have the
	// `off_session_charges_enabled` feature flag.
	POLAR_PRODUCT_AUTOTOPUP: z.string().optional(),
	// Polar webhook signing secret (Standard Webhooks). When unset, the
	// first-party credits top-up webhook degrades cleanly (503), never crashes.
	POLAR_WEBHOOK_SECRET: z.string().optional(),
	// Stripe (marketplace monetization #485). All optional: absent keys must
	// degrade cleanly (credits top-up/webhook disabled), never crash on import.
	STRIPE_SECRET_KEY: z.string().optional(),
	// Publishable key for the same Stripe account. The first-party marketplace
	// checkout page loads Stripe.js with it; without it marketplace checkouts
	// stay on Stripe-hosted Checkout.
	STRIPE_PUBLISHABLE_KEY: z.string().optional(),
	STRIPE_WEBHOOK_SECRET: z.string().optional(),
	// Signing secret of the Stripe Connect webhook endpoint (paid items, #486).
	STRIPE_CONNECT_WEBHOOK_SECRET: z.string().optional(),
	// Marketplace direct-charge migration flag (#490,
	// docs/stripe-connect-direct-charges-migration.md). DEFAULT OFF: absent /
	// anything but "true" keeps the destination-charge path (charge on the
	// PLATFORM, seller SG-only). Set "true" to charge ON the seller's connected
	// account (direct charge → 46 seller countries), keeping the platform fee.
	// BEFORE flipping true you MUST (a) subscribe checkout.session.completed /
	// payment_intent.succeeded / charge.refunded / charge.dispute.created on the
	// Connect webhook endpoint (direct-charge success events fire there with
	// `event.account` set — a platform endpoint never sees them, so licenses
	// silently stop being written), and (b) re-onboard existing sellers for the
	// `card_payments` capability + let `account.updated` backfill chargesEnabled.
	MARKETPLACE_DIRECT_CHARGE: z.string().optional(),
	MARKETPLACE_MEMBERSHIP_PUBLISHER_SHARE_BPS: z.string().optional(),
	// Secret shared with the gateway so the internal debit endpoint can be
	// called service-to-service (the gateway debits arbitrary orgs). Optional:
	// when unset, debit falls back to an authenticated user session.
	RYU_CREDITS_INTERNAL_SECRET: z.string().optional(),
	// Where Stripe redirects after a credit top-up checkout.
	STRIPE_SUCCESS_URL: z.string().optional(),
	STRIPE_CANCEL_URL: z.string().optional(),
	// First-party Ryu affiliate program (replaces Dub). The default
	// subscription-commission rule is assembled from these in code; ALL
	// optional and parsed/defaulted there (type=percent, value=2000 bps=20%,
	// recurring=true, duration_months=12). See `@ryu/api` affiliate config.
	AFFILIATE_SUBSCRIPTION_TYPE: z.string().optional(),
	AFFILIATE_SUBSCRIPTION_VALUE: z.string().optional(),
	AFFILIATE_SUBSCRIPTION_RECURRING: z.string().optional(),
	AFFILIATE_SUBSCRIPTION_DURATION_MONTHS: z.string().optional(),
};
