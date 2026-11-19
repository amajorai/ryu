// `ryu-cli secrets cloud …`: read the organization's shared values with a
// service-account key, without a node or a person signing in (roadmap P1-4).
//
// The key comes from RYU_SERVICE_ACCOUNT_KEY (never a flag: arguments show up
// in `ps` and shell history) and is sent as `x-api-key` to the control plane's
// `/api/control-plane/orgs/:orgId/vault` routes, which accept a key only for
// listing and reading. What it may read is decided by the vault policies bound
// to `machine:<service-account-id>`. `get` prints a value, so the agent guard
// refuses it in an AI agent session (`printsSecretValues`).

import { z } from "zod";
import { authBackendUrl } from "../core/controlPlane.ts";
import { tf } from "../i18n/translate.ts";
import { formatTable } from "./output.ts";
import { arg, flag, type SecretsArgs } from "./secrets-args.ts";
import { printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

export const SERVICE_ACCOUNT_KEY_ENV = "RYU_SERVICE_ACCOUNT_KEY";

const USAGE = [
	"Usage: ryu-cli secrets cloud list --org ORG [--env E]",
	"  | cloud get NAME --org ORG [--env E] [--path P] [--project ID]",
	`  The service-account key is read from ${SERVICE_ACCOUNT_KEY_ENV}.`,
].join("\n");

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const cloudSecretSchema = z.object({
	name: z.string(),
	scope: z.string(),
	scopeId: z.string(),
	environment: z.string(),
	path: z.string(),
	version: z.number(),
	status: z.string(),
});
const listSchema = z.object({ secrets: z.array(cloudSecretSchema) });
const revealSchema = z.object({ value: z.string() });
const errorSchema = z.object({ error: z.string() });

/** The control-plane vault base for `org`; a key is only sent over HTTPS
 *  (or to this machine, for a local control plane). */
export function cloudVaultBase(
	env: Record<string, string | undefined>,
	org: string
): string {
	const origin = new URL(authBackendUrl(env));
	if (origin.protocol !== "https:" && !LOOPBACK_HOSTS.has(origin.hostname)) {
		throw new UsageError(
			tf(
				"Refusing to send a service-account key to {origin} over plain HTTP.",
				{ origin: origin.origin }
			)
		);
	}
	return `${origin.origin}/api/control-plane/orgs/${encodeURIComponent(org)}/vault`;
}

function serviceAccountKey(ctx: CliContext): string {
	const key = ctx.env[SERVICE_ACCOUNT_KEY_ENV]?.trim();
	if (!key) {
		throw new UsageError(
			tf("Set {name} to a service-account key with Vault access.", {
				name: SERVICE_ACCOUNT_KEY_ENV,
			})
		);
	}
	return key;
}

/** How long one control-plane call may take. */
const CLOUD_TIMEOUT_MS = 30_000;

/** The server's refusal sentence (JSON `error`, or a plain-text body), or
 *  the status when it sent none. */
async function failure(response: Response): Promise<Error> {
	const text = (await response.text().catch(() => "")).trim();
	let reason = text;
	try {
		const parsed = errorSchema.safeParse(JSON.parse(text));
		if (parsed.success) {
			reason = parsed.data.error;
		}
	} catch {
		// A plain-text body is the sentence itself.
	}
	return new Error(
		tf("Control-plane vault refused: {reason}", {
			reason: reason.slice(0, 500) || `HTTP ${response.status}`,
		})
	);
}

async function cloudCall<T>(
	ctx: CliContext,
	url: string,
	init: { body?: unknown; method: "GET" | "POST" },
	schema: z.ZodType<T>
): Promise<T> {
	// A redirect is never followed: fetch would resend `x-api-key` (it only
	// drops `Authorization`) to whatever host the response names.
	const response = await ctx.fetch(url, {
		method: init.method,
		redirect: "manual",
		signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
		headers: {
			accept: "application/json",
			"x-api-key": serviceAccountKey(ctx),
			...(init.body === undefined
				? {}
				: { "content-type": "application/json" }),
		},
		...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
	});
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel();
		throw new Error(
			"The control plane redirected the request; it was not followed, so the key was not sent on."
		);
	}
	if (!response.ok) {
		throw await failure(response);
	}
	return schema.parse(await response.json());
}

export async function cloud(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[1];
	const org = flag(args, "--org") ?? ctx.env.RYU_ORG_ID?.trim();
	if (
		(action !== "list" && action !== "get") ||
		!org ||
		org === "." ||
		org === ".."
	) {
		throw new UsageError(USAGE);
	}
	const base = cloudVaultBase(ctx.env, org);
	const environment = flag(args, "--env");
	if (action === "list") {
		const query = environment
			? `?environment=${encodeURIComponent(environment)}`
			: "";
		const { secrets } = await cloudCall(
			ctx,
			`${base}/secrets${query}`,
			{ method: "GET" },
			listSchema
		);
		if (ctx.flags.json) {
			printJson(ctx, secrets);
			return 0;
		}
		const rows = secrets.map((secret) => [
			secret.name,
			secret.environment,
			secret.path,
			secret.scope === "project" ? `project:${secret.scopeId}` : secret.scope,
			String(secret.version),
			secret.status,
		]);
		ctx.io.out(
			`${formatTable(["NAME", "ENV", "PATH", "SCOPE", "VERSION", "STATUS"], rows)}\n`
		);
		return 0;
	}
	const name = arg(args, 2, "cloud get NAME");
	if (name === "." || name === "..") {
		throw new UsageError(USAGE);
	}
	const project = flag(args, "--project");
	const { value } = await cloudCall(
		ctx,
		`${base}/secrets/${encodeURIComponent(name)}/reveal`,
		{
			method: "POST",
			body: {
				scope: project ? "project" : "org",
				scopeId: project ?? org,
				environment: environment ?? "default",
				path: flag(args, "--path") ?? "/",
			},
		},
		revealSchema
	);
	if (ctx.flags.json) {
		printJson(ctx, { name, value });
	} else {
		ctx.io.out(`${value}\n`);
	}
	return 0;
}
