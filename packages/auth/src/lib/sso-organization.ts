import { z } from "zod";

const SSO_CALLBACK_PATH =
	/^\/sso\/(?:callback|saml2\/callback|saml2\/sp\/acs)\/([^/]+)$/;
const PROVIDER_ID_PARAMETER = ":providerId";
const callbackParamsSchema = z.object({ providerId: z.string().min(1) });

/**
 * Return the provider id from a provider-specific Better Auth callback.
 *
 * Inside Better Auth hooks `ctx.path` is the endpoint's route template
 * (`/sso/callback/:providerId`), not the request path, and the provider id is
 * in `ctx.params`; a literal request path (`/sso/callback/acme`) is accepted
 * too. Shared callbacks without a provider segment return null.
 */
export function providerIdFromSsoCallbackPath(
	path: string,
	params?: unknown
): string | null {
	const match = SSO_CALLBACK_PATH.exec(path);
	if (!match?.[1]) {
		return null;
	}
	if (match[1] === PROVIDER_ID_PARAMETER) {
		const parsed = callbackParamsSchema.safeParse(params);
		return parsed.success ? parsed.data.providerId : null;
	}

	try {
		return decodeURIComponent(match[1]);
	} catch {
		return null;
	}
}
