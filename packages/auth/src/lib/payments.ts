import { Polar } from "@polar-sh/sdk";
import {
	WebhookVerificationError as PolarWebhookVerificationError,
	validateEvent as polarValidateEvent,
} from "@polar-sh/sdk/webhooks";
import { env } from "@ryu/env/server";

export const polarClient = new Polar({
	accessToken: env.POLAR_ACCESS_TOKEN,
	server: env.POLAR_SERVER,
});

/**
 * Re-export the Polar SDK's Standard-Webhooks verifier through `@ryu/auth` so
 * webhook handlers in other packages (e.g. `@ryu/api`) can verify Polar events
 * without taking a direct dependency on `@polar-sh/sdk` (which is installed only
 * here). Mirrors how this module wraps the rest of the Polar SDK surface.
 */
export const validatePolarEvent = polarValidateEvent;
export { PolarWebhookVerificationError };

export interface EnsurePolarCustomerInput {
	email: string;
	id: string;
	name?: string | null;
}

/**
 * Idempotently provisions a Polar customer for a user without ever failing the
 * caller. If a customer already exists for the email it is relinked to the
 * current user id; otherwise a new customer is created. Any Polar/API error is
 * logged and swallowed so billing problems never block sign-up.
 */
export const ensurePolarCustomer = async ({
	id,
	email,
	name,
}: EnsurePolarCustomerInput): Promise<boolean> => {
	if (!email) {
		return false;
	}

	try {
		const { result } = await polarClient.customers.list({ email });
		const existingCustomer = result.items[0];

		if (existingCustomer) {
			// Polar forbids changing an externalId once set, so only link when the
			// existing customer has none yet. If it is already linked to another
			// user id we leave it as-is rather than failing sign-up.
			if (!existingCustomer.externalId) {
				await polarClient.customers.update({
					id: existingCustomer.id,
					customerUpdate: { externalId: id },
				});
			}
			return true;
		}

		await polarClient.customers.create({
			email,
			name: name ?? undefined,
			externalId: id,
		});
		return true;
	} catch (error) {
		console.error(
			"Failed to provision Polar customer (non-critical):",
			error instanceof Error ? error.message : error
		);
		return false;
	}
};

/**
 * Keeps the Polar customer's email/name in sync when the user record changes,
 * mirroring the plugin's previous onUserUpdate behaviour. Looks the customer up
 * by externalId (the user id). Never throws so a profile update cannot fail.
 */
export const syncPolarCustomer = async ({
	id,
	email,
	name,
}: EnsurePolarCustomerInput): Promise<boolean> => {
	if (!email) {
		return false;
	}

	try {
		await polarClient.customers.updateExternal({
			externalId: id,
			customerUpdateExternalID: { email, name: name ?? undefined },
		});
		return true;
	} catch (error) {
		console.error(
			"Failed to sync Polar customer (non-critical):",
			error instanceof Error ? error.message : error
		);
		return false;
	}
};
