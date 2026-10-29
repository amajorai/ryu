import { HTTPClient, Polar } from "@polar-sh/sdk";
import { env } from "@ryu/env/server";
import { z } from "zod";
import {
	PolarWebhookVerificationError,
	validatePolarEvent,
} from "./newpolar-webhooks.ts";
import { POLAR_API_VERSION } from "./polar-api.ts";

const polarHttpClient = new HTTPClient();
polarHttpClient.addHook("beforeRequest", (request) => {
	request.headers.set("Polar-Version", POLAR_API_VERSION);
});

/**
 * Upper bound for every Polar SDK request. The SDK default is no timeout at all,
 * so a Polar brownout would leave billing, credits, and gift requests (and their
 * sockets and follow-up writes) pending forever while users retry. This matches
 * `POLAR_READ_TIMEOUT_MS` in auto-topup. A call that passes its own `signal` or
 * `timeoutMs` keeps it. Retries stay off on purpose: a timed-out checkout or
 * subscription update must never be re-sent silently.
 */
const POLAR_REQUEST_TIMEOUT_MS = 15_000;

export const polarClient = new Polar({
	accessToken: env.POLAR_ACCESS_TOKEN,
	httpClient: polarHttpClient,
	server: env.POLAR_SERVER,
	timeoutMs: POLAR_REQUEST_TIMEOUT_MS,
});

/**
 * Re-export the unified Polar webhook verifier through `@ryu/auth` so handlers
 * in other packages (e.g. `@ryu/api`) do not need a direct Polar SDK dependency.
 * New `whsec_` keys use Standard Webhooks directly; legacy raw secrets retain
 * the SDK verifier's established behavior.
 */
export { PolarWebhookVerificationError, validatePolarEvent };

export interface EnsurePolarCustomerInput {
	email: string;
	id: string;
	name?: string | null;
}

/**
 * Idempotently provisions a Polar customer for a user without ever failing the
 * caller. An existing customer must already belong to the user; email alone
 * cannot authorize linking a legacy or organization payer. Any Polar/API error is
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
		if (result.items.length > 0) {
			return result.items.some(
				(customer) =>
					customer.externalId === id &&
					customer.metadata.scope !== "org" &&
					!z.object({ orgId: z.string() }).safeParse(customer.metadata).success
			);
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
		const status = z
			.object({
				statusCode: z.number().nullish().catch(Number.NaN),
				status: z.number().nullish().catch(Number.NaN),
			})
			.transform((value) => value.statusCode ?? value.status)
			.optional()
			.catch(undefined)
			.parse(error);
		// Personal customers are created lazily at checkout so an account update
		// before the first purchase has no provider row to synchronize yet.
		if (status === 404) {
			return false;
		}
		console.error(
			"Failed to sync Polar customer (non-critical):",
			error instanceof Error ? error.message : error
		);
		return false;
	}
};
