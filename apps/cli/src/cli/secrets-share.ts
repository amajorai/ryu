// `ryu secrets share …`: one-time share links and inbound secret-request
// links. A share link grants its secret to whoever opens it, so creating one
// is refused in an AI agent session (`secrets-agent-guard.ts`); requesting,
// listing, claiming and revoking are not. `share request-credential` asks a
// person for an agent's sign-in to one site; its claim saves an agent account.

import {
	claimVaultShareRequest,
	listVaultShareLinks,
	requestVaultCredential,
	requestVaultSecret,
	revokeVaultShareLink,
	shareVaultSecret,
	shareVaultWrapToken,
	type VaultShareLink,
} from "@ryuhq/core-client/vault";
import { tf, tr } from "../i18n/translate.ts";
import { formatTable } from "./output.ts";
import {
	arg,
	coordsFrom,
	flag,
	parseDuration,
	type SecretsArgs,
} from "./secrets-args.ts";
import { printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

export const SHARE_USAGE =
	"Usage: ryu-cli secrets share NAME [--label L] [--ttl 1h] | share --wrap-token T | share request NAME --label L [--ttl 1h] | share request-credential SITE --label L [--agent A] [--username U] [--totp] [--submit-url URL] | share list | share claim ID | share revoke ID";

function ttl(args: SecretsArgs): { ttlSecs?: number } {
	const value = flag(args, "--ttl");
	return value === undefined ? {} : { ttlSecs: parseDuration(value) };
}

function label(args: SecretsArgs): { label?: string } {
	const value = flag(args, "--label");
	return value === undefined ? {} : { label: value };
}

function linkRows(links: VaultShareLink[]): string[][] {
	return links.map((link) => [
		link.id,
		link.kind,
		link.status,
		link.label ?? "",
		String(link.expiresAt),
	]);
}

/** Ask a person for an agent's sign-in to SITE (`--agent` picks the agent). */
function requestCredential(ctx: CliContext, args: SecretsArgs) {
	const site = arg(args, 2, "share request-credential SITE --label L");
	const text = flag(args, "--label");
	if (!text) {
		throw new UsageError(SHARE_USAGE);
	}
	const username = flag(args, "--username");
	const submitUrls = args.values.get("--submit-url") ?? [];
	return requestVaultCredential(ctx.target, site, text, {
		...(ctx.flags.agent ? { agentId: ctx.flags.agent } : {}),
		...(username ? { username } : {}),
		...(args.booleans.has("--totp") ? { totp: true } : {}),
		...(submitUrls.length > 0 ? { submitUrls } : {}),
		...ttl(args),
	});
}

export async function share(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[1];
	if (action === "list" || action === "ls") {
		const { links } = await listVaultShareLinks(ctx.target);
		if (ctx.flags.json) {
			printJson(ctx, links);
			return 0;
		}
		ctx.io.out(
			links.length === 0
				? `${tr("No share links.")}\n`
				: `${formatTable(["LINK", "KIND", "STATUS", "LABEL", "EXPIRES"], linkRows(links))}\n`
		);
		return 0;
	}
	if (action === "claim") {
		const id = arg(args, 2, "share claim ID");
		const result = await claimVaultShareRequest(ctx.target, id);
		if (ctx.flags.json) {
			printJson(ctx, result);
		} else {
			ctx.io.out(`${tf("Saved the answer to request {id}.", { id })}\n`);
		}
		return 0;
	}
	if (action === "revoke") {
		const id = arg(args, 2, "share revoke ID");
		const { revoked } = await revokeVaultShareLink(ctx.target, id);
		if (ctx.flags.json) {
			printJson(ctx, { revoked });
		} else {
			ctx.io.out(
				revoked
					? `${tf("Revoked link {id}.", { id })}\n`
					: `${tf("Link {id} was already used, expired, or revoked.", { id })}\n`
			);
		}
		return 0;
	}
	let created: { link: { expiresAt: string; id: string; url: string } };
	if (action === "request-credential") {
		created = await requestCredential(ctx, args);
	} else if (action === "request") {
		const name = arg(args, 2, "share request NAME --label L");
		const text = flag(args, "--label");
		if (!text) {
			throw new UsageError(SHARE_USAGE);
		}
		created = await requestVaultSecret(ctx.target, name, text, {
			...coordsFrom(args),
			...ttl(args),
		});
	} else {
		const wrapToken = flag(args, "--wrap-token");
		if (wrapToken) {
			created = await shareVaultWrapToken(ctx.target, wrapToken, {
				...label(args),
				...ttl(args),
			});
		} else {
			if (!action) {
				throw new UsageError(SHARE_USAGE);
			}
			created = await shareVaultSecret(ctx.target, action, {
				...coordsFrom(args),
				...label(args),
				...ttl(args),
			});
		}
	}
	if (ctx.flags.json) {
		printJson(ctx, created.link);
		return 0;
	}
	ctx.io.out(`${created.link.url}\n`);
	ctx.io.err(
		`${tf("Link {id} works once and expires at {expiresAt}. It is shown only now.", { id: created.link.id, expiresAt: created.link.expiresAt })}\n`
	);
	return 0;
}
