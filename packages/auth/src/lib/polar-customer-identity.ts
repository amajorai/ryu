import { OrganizationSeatEntitlement } from "@ryu/db/models/organization-seat-entitlement.model";
import { PolarBillingProjection } from "@ryu/db/models/polar-billing-projection.model";
import { z } from "zod";
import { polarClient } from "./payments.ts";
import { polarOrganizationExternalId } from "./polar-credits.ts";

const providerErrorStatusSchema = z
	.object({
		statusCode: z.number().nullish().catch(Number.NaN),
		status: z.number().nullish().catch(Number.NaN),
	})
	.transform((error) => error.statusCode ?? error.status)
	.catch(undefined);
const organizationCustomerMetadataSchema = z.object({ orgId: z.string() });

/** Polar's answer when a customer with this external id or email already exists. */
function isProviderConflict(error: unknown): boolean {
	const status = providerErrorStatusSchema.parse(error);
	return status === 409 || status === 422;
}

/** A provider customer id cannot be safely reused until its Ryu owner is proven. */
export class OrganizationPolarCustomerReconciliationError extends Error {
	readonly code = "polar_customer_identity_reconciliation_required";

	constructor(
		message = "Organization billing needs customer identity reconciliation before it can be managed or purchased again"
	) {
		super(message);
		this.name = "OrganizationPolarCustomerReconciliationError";
	}
}

/** Payer email is contact information, never an organization ownership proof. */
export async function resolveOrganizationPolarCustomerId(
	organizationId: string
): Promise<string | null> {
	const externalId = polarOrganizationExternalId(organizationId);
	try {
		const customer = await polarClient.customers.getExternal({ externalId });
		if (customer.externalId !== externalId) {
			throw new Error(
				"Polar returned a customer for a different billing identity"
			);
		}
		return customer.id;
	} catch (error) {
		const status = providerErrorStatusSchema.parse(error);
		if (status !== 404) {
			throw error;
		}
	}
	// A known legacy contract needs explicit provider reconciliation. Returning
	// an empty account here would offer a duplicate checkout. A stored id alone
	// does not prove ownership: old email fallback may have populated it.
	const [contract, projection] = await Promise.all([
		OrganizationSeatEntitlement.findOne({ organizationId })
			.select("polarCustomerId")
			.lean<{ polarCustomerId?: string | null }>(),
		PolarBillingProjection.findOne({ organizationId })
			.select("polarCustomerId")
			.lean<{ polarCustomerId?: string | null }>(),
	]);
	if (contract?.polarCustomerId || projection?.polarCustomerId) {
		throw new OrganizationPolarCustomerReconciliationError();
	}
	return null;
}

/**
 * Resolve the canonical organization customer before starting a checkout.
 *
 * Polar's checkout API can select an existing payer by email. That is unsafe
 * for an organization because the email may already belong to a personal
 * customer. Creating the team customer first lets checkout use `customerId`
 * and makes the provider identity unambiguous. A provider-side email collision
 * is deliberately surfaced to the caller for reconciliation; it is never
 * silently linked to the personal payer.
 */
export async function ensureOrganizationPolarCustomer(input: {
	organizationId: string;
	email: string;
	ownerName?: string | null;
	ownerUserId?: string | null;
}): Promise<string> {
	const organizationId = input.organizationId.trim();
	const email = input.email.trim().toLowerCase();
	if (!(organizationId && email)) {
		throw new Error("organization billing requires an id and email");
	}

	const existing = await resolveOrganizationPolarCustomerId(organizationId);
	if (existing) {
		return existing;
	}

	const externalId = polarOrganizationExternalId(organizationId);
	let customer: Awaited<ReturnType<typeof polarClient.customers.create>>;
	try {
		customer = await polarClient.customers.create({
			email,
			externalId,
			metadata: { orgId: organizationId, scope: "org" },
			name: input.ownerName?.trim() || undefined,
			owner: input.ownerUserId?.trim()
				? {
						email,
						externalId: input.ownerUserId.trim(),
						name: input.ownerName?.trim() || undefined,
					}
				: undefined,
			type: "team",
		});
	} catch (error) {
		if (!isProviderConflict(error)) {
			throw error;
		}
		// A concurrent checkout for this organization may have created the
		// customer between our lookup and create. Re-resolve once with the same
		// strict identity checks; only a conflict that is still unexplained is a
		// real collision. Errors from the re-resolve propagate unchanged.
		const raced = await resolveOrganizationPolarCustomerId(organizationId);
		if (raced) {
			return raced;
		}
		throw new OrganizationPolarCustomerReconciliationError(
			"Polar already has a customer for this organization contact; reconcile the provider customer identity before retrying checkout"
		);
	}
	if (customer.externalId !== externalId || !customer.id) {
		throw new Error("Polar returned an invalid organization customer identity");
	}
	return customer.id;
}

/** Resolve or create the personal customer used by an individual checkout. */
export async function ensurePersonalPolarCustomer(input: {
	userId: string;
	email: string;
	name?: string | null;
}): Promise<string> {
	const userId = input.userId.trim();
	const email = input.email.trim().toLowerCase();
	if (!(userId && email)) {
		throw new Error("personal billing requires a user id and email");
	}

	const existing = await resolvePersonalPolarCustomerId(userId);
	if (existing) {
		return existing;
	}

	let customer: Awaited<ReturnType<typeof polarClient.customers.create>>;
	try {
		customer = await polarClient.customers.create({
			email,
			externalId: userId,
			metadata: { scope: "user", userId },
			name: input.name?.trim() || undefined,
			type: "individual",
		});
	} catch (error) {
		if (!isProviderConflict(error)) {
			throw error;
		}
		// Same race as the organization path: adopt a customer a concurrent
		// checkout just created for this exact user, never an email match.
		const raced = await resolvePersonalPolarCustomerId(userId);
		if (raced) {
			return raced;
		}
		throw new OrganizationPolarCustomerReconciliationError(
			"Polar already has a customer for this personal contact; reconcile the provider customer identity before retrying checkout"
		);
	}
	if (customer.externalId !== userId || !customer.id) {
		throw new Error("Polar returned an invalid personal customer identity");
	}
	return customer.id;
}

/** Personal billing follows the authenticated user identity, never payer email. */
export async function resolvePersonalPolarCustomerId(
	userId: string
): Promise<string | null> {
	if (!userId.trim()) {
		throw new Error("A user id is required for personal billing");
	}
	try {
		const customer = await polarClient.customers.getExternal({
			externalId: userId,
		});
		if (
			customer.externalId !== userId ||
			customer.metadata.scope === "org" ||
			organizationCustomerMetadataSchema.safeParse(customer.metadata).success
		) {
			throw new Error(
				"Polar returned a customer for a different billing identity"
			);
		}
		return customer.id;
	} catch (error) {
		const status = providerErrorStatusSchema.parse(error);
		if (status !== 404) {
			throw error;
		}
	}
	return null;
}
