// Client-side proofs for the keyless vault logins (`ryu secrets login --cert`
// and `--aws`). Nothing here talks to Core: the certificate proof is a short
// JWT signed with the certificate's private key, and the AWS proof is a SigV4
// signed `sts:GetCallerIdentity` request that Core forwards to STS. Both
// follow `apps/core/src/vault/auth_methods.rs`.

import {
	createHash,
	createHmac,
	createPrivateKey,
	type KeyObject,
	randomUUID,
	sign,
} from "node:crypto";
import {
	VAULT_AWS_SERVER_ID_HEADER,
	VAULT_CERT_LOGIN_AUDIENCE,
	type VaultAwsLoginInput,
} from "@ryuhq/core-client/vault";
import { localize } from "./localizedText.ts";
import { UsageError } from "./types.ts";

/** Proof lifetime; Core accepts at most 300 seconds. */
export const CERT_PROOF_LIFETIME_SECS = 60;
export const DEFAULT_STS_ENDPOINT = "https://sts.amazonaws.com/";
const STS_BODY = "Action=GetCallerIdentity&Version=2011-06-15";

function base64url(input: Buffer | string): string {
	return Buffer.from(input).toString("base64url");
}

interface JwtSigner {
	alg: string;
	sign: (data: Buffer) => Buffer;
}

function signerFor(key: KeyObject): JwtSigner {
	const type = key.asymmetricKeyType;
	if (type === "ed25519") {
		return { alg: "EdDSA", sign: (data) => sign(null, data, key) };
	}
	if (type === "rsa") {
		return { alg: "RS256", sign: (data) => sign("sha256", data, key) };
	}
	if (type === "ec") {
		const curve = key.asymmetricKeyDetails?.namedCurve;
		if (curve !== "prime256v1" && curve !== "secp384r1") {
			throw new UsageError(
				"The certificate key must be EC P-256, EC P-384, Ed25519, or RSA."
			);
		}
		const [alg, hash] =
			curve === "secp384r1" ? ["ES384", "sha384"] : ["ES256", "sha256"];
		return {
			alg,
			sign: (data) => sign(hash, data, { key, dsaEncoding: "ieee-p1363" }),
		};
	}
	throw new UsageError(
		"The certificate key must be EC P-256, EC P-384, Ed25519, or RSA."
	);
}

/** A proof-of-possession JWT for `POST /api/vault/auth/cert/login`. */
export function certLoginProof(
	privateKeyPem: string,
	identity: string,
	now: Date = new Date()
): string {
	let key: KeyObject;
	try {
		key = createPrivateKey(privateKeyPem);
	} catch {
		throw new UsageError("--key-file is not a PEM private key.");
	}
	const signer = signerFor(key);
	const iat = Math.floor(now.getTime() / 1000);
	const header = base64url(JSON.stringify({ alg: signer.alg, typ: "JWT" }));
	const claims = base64url(
		JSON.stringify({
			aud: VAULT_CERT_LOGIN_AUDIENCE,
			sub: identity,
			iat,
			exp: iat + CERT_PROOF_LIFETIME_SECS,
			jti: randomUUID(),
		})
	);
	const input = `${header}.${claims}`;
	return `${input}.${base64url(signer.sign(Buffer.from(input)))}`;
}

export interface AwsCredentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

export interface SigV4Request {
	body: string;
	/** Header names in any case; `host` is derived from the URL. */
	headers: Record<string, string>;
	method: string;
	url: string;
}

function sha256Hex(data: string): string {
	return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
	return createHmac("sha256", key).update(data).digest();
}

function amzDate(now: Date): string {
	return now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "");
}

/**
 * AWS Signature Version 4 headers for `request`: the given headers plus
 * `host`, `x-amz-date`, `x-amz-security-token` (with a session token) and
 * `authorization`, every name lowercased.
 */
export function signSigV4(
	request: SigV4Request,
	credentials: AwsCredentials,
	scope: { region: string; service: string },
	now: Date = new Date()
): Record<string, string> {
	const url = new URL(request.url);
	const stamp = amzDate(now);
	const day = stamp.slice(0, 8);
	const headers: Record<string, string> = { host: url.host };
	for (const [name, value] of Object.entries(request.headers)) {
		headers[name.toLowerCase()] = value.trim();
	}
	headers["x-amz-date"] = stamp;
	if (credentials.sessionToken) {
		headers["x-amz-security-token"] = credentials.sessionToken;
	}
	const names = Object.keys(headers).sort();
	const signedHeaders = names.join(";");
	const query = [...url.searchParams]
		.map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)])
		.sort(([a = ""], [b = ""]) => {
			if (a === b) {
				return 0;
			}
			return a < b ? -1 : 1;
		})
		.map(([key, value]) => `${key}=${value}`)
		.join("&");
	const canonical = [
		request.method.toUpperCase(),
		url.pathname || "/",
		query,
		names.map((name) => `${name}:${headers[name]}\n`).join(""),
		signedHeaders,
		sha256Hex(request.body),
	].join("\n");
	const credentialScope = `${day}/${scope.region}/${scope.service}/aws4_request`;
	const toSign = [
		"AWS4-HMAC-SHA256",
		stamp,
		credentialScope,
		sha256Hex(canonical),
	].join("\n");
	const signingKey = hmac(
		hmac(
			hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), scope.region),
			scope.service
		),
		"aws4_request"
	);
	const signature = createHmac("sha256", signingKey)
		.update(toSign)
		.digest("hex");
	headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
	return headers;
}

/** `sts.amazonaws.com` signs for us-east-1; `sts.<region>.amazonaws.com` for its region. */
export function stsRegion(endpoint: string): string {
	const host = new URL(endpoint).hostname;
	const match = /^sts\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/.exec(host);
	return match?.[1] ?? "us-east-1";
}

/** Read AWS credentials from the standard environment variables. */
export function awsCredentialsFromEnv(
	env: Readonly<Record<string, string | undefined>>
): AwsCredentials {
	const accessKeyId = env.AWS_ACCESS_KEY_ID;
	const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
	if (!(accessKeyId && secretAccessKey)) {
		throw new UsageError(
			localize(
				"login --aws signs with AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN when set)."
			)
		);
	}
	const sessionToken = env.AWS_SESSION_TOKEN;
	return sessionToken
		? { accessKeyId, secretAccessKey, sessionToken }
		: { accessKeyId, secretAccessKey };
}

/** The base64 `iam_*` fields of a signed `GetCallerIdentity` for `identity`. */
export function awsLoginRequest(options: {
	credentials: AwsCredentials;
	endpoint?: string;
	identity: string;
	now?: Date;
	region?: string;
	serverId: string;
}): VaultAwsLoginInput {
	const url = options.endpoint ?? DEFAULT_STS_ENDPOINT;
	const headers = signSigV4(
		{
			method: "POST",
			url,
			body: STS_BODY,
			headers: {
				"content-type": "application/x-www-form-urlencoded; charset=utf-8",
				[VAULT_AWS_SERVER_ID_HEADER]: options.serverId,
			},
		},
		options.credentials,
		{ region: options.region ?? stsRegion(url), service: "sts" },
		options.now
	);
	const encode = (text: string) => Buffer.from(text).toString("base64");
	return {
		identity: options.identity,
		iamHttpRequestMethod: "POST",
		iamRequestUrl: encode(url),
		iamRequestBody: encode(STS_BODY),
		iamRequestHeaders: encode(JSON.stringify(headers)),
	};
}
