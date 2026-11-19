// Workload identity tokens from cloud metadata services, for
// `ryu secrets login --azure|--gcp`. Both are OIDC JWTs signed by the cloud's
// issuer, so Core verifies them with the JWT auth method: configure the
// machine identity's JWKS URL, issuer, and audience for Microsoft Entra ID
// (`https://login.microsoftonline.com/<tenant>/v2.0`) or Google
// (`https://accounts.google.com`). The token is read from the local metadata
// endpoint and sent only to Core's login route.

import { z } from "zod";
import { tf } from "../i18n/translate.ts";
import { type FetchLike, UsageError } from "./types.ts";

/** Azure Instance Metadata Service (VMs, VM scale sets, AKS pod identity). */
export const AZURE_IMDS_TOKEN_URL =
	"http://169.254.169.254/metadata/identity/oauth2/token";
/** GCE/GKE/Cloud Run metadata server. */
export const GCP_IDENTITY_URL =
	"http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

export const AZURE_DEFAULT_RESOURCE = "https://management.azure.com/";

const azureTokenSchema = z.object({ access_token: z.string().min(1) });
const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]*$/;

async function metadataGet(
	fetch: FetchLike,
	url: string,
	headers: Record<string, string>,
	source: string
): Promise<string> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(5000),
		});
	} catch (error) {
		throw new UsageError(
			tf("Could not reach the {source} metadata endpoint: {reason}", {
				source,
				reason: error instanceof Error ? error.message : String(error),
			})
		);
	}
	const text = await response.text();
	if (!response.ok) {
		// The body can name the identity but never holds a token on an error.
		throw new UsageError(
			tf(
				"The {source} metadata endpoint refused the token request (HTTP {status}).",
				{
					source,
					status: String(response.status),
				}
			)
		);
	}
	return text;
}

function requireJwt(token: string, source: string): string {
	const trimmed = token.trim();
	if (!JWT_SHAPE.test(trimmed)) {
		throw new UsageError(
			tf("The {source} metadata endpoint did not return a JWT.", { source })
		);
	}
	return trimmed;
}

/**
 * A managed-identity access token for `resource`. App Service and Functions
 * publish `IDENTITY_ENDPOINT`/`IDENTITY_HEADER`; elsewhere IMDS answers.
 */
export async function azureManagedIdentityJwt(
	fetch: FetchLike,
	env: Readonly<Record<string, string | undefined>>,
	options: { clientId?: string; resource?: string } = {}
): Promise<string> {
	const params = new URLSearchParams({
		resource: options.resource ?? AZURE_DEFAULT_RESOURCE,
	});
	if (options.clientId) {
		params.set("client_id", options.clientId);
	}
	const endpoint = env.IDENTITY_ENDPOINT;
	const header = env.IDENTITY_HEADER;
	let url: string;
	let headers: Record<string, string>;
	if (endpoint && header) {
		params.set("api-version", "2019-08-01");
		url = `${endpoint}?${params}`;
		headers = { "X-IDENTITY-HEADER": header };
	} else {
		params.set("api-version", "2018-02-01");
		url = `${AZURE_IMDS_TOKEN_URL}?${params}`;
		headers = { Metadata: "true" };
	}
	const text = await metadataGet(fetch, url, headers, "Azure");
	let parsed: ReturnType<typeof azureTokenSchema.safeParse>;
	try {
		parsed = azureTokenSchema.safeParse(JSON.parse(text));
	} catch {
		parsed = azureTokenSchema.safeParse(null);
	}
	if (!parsed.success) {
		throw new UsageError("The Azure metadata endpoint did not return a token.");
	}
	return requireJwt(parsed.data.access_token, "Azure");
}

/** A Google-signed identity token whose `aud` is `audience`. */
export async function gcpIdentityJwt(
	fetch: FetchLike,
	audience: string
): Promise<string> {
	const params = new URLSearchParams({ audience, format: "full" });
	const text = await metadataGet(
		fetch,
		`${GCP_IDENTITY_URL}?${params}`,
		{ "Metadata-Flavor": "Google" },
		"Google Cloud"
	);
	return requireJwt(text, "Google Cloud");
}
