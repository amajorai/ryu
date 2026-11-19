// `ryu-cli secrets pki …`: certificate authorities, roles and certificates
// over Core's `/api/vault/pki` routes, like `bao write pki/…`.
//
// `issue` returns a new private key once (Core never stores it): it is
// written to `--key-out FILE` (mode 0600, refusing to replace a file without
// `--force`) or printed, and the agent guard refuses `issue` in an AI agent
// session (`printsSecretValues`). Certificates, chains and CRLs are public.

import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	createVaultPkiIssuer,
	deleteVaultPkiRole,
	getVaultPkiCrl,
	listVaultPkiCertificates,
	listVaultPkiIssuers,
	listVaultPkiRoles,
	putVaultPkiRole,
	revokeVaultPkiCertificate,
	type VaultIssuedCertificate,
	type VaultPkiIssueInput,
	vaultPki,
} from "@ryuhq/core-client/vault";
import { tf } from "../i18n/translate.ts";
import { formatTable } from "./output.ts";
import { arg, flag, parseDuration, type SecretsArgs } from "./secrets-args.ts";
import {
	checkOutParent,
	createExclusive,
	replaceExclusive,
	writeFailure,
} from "./secrets-out-file.ts";
import { printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

const USAGE = [
	"Usage: ryu-cli secrets pki issuers | pki issuer create NAME --common-name CN [--ttl 3650d]",
	"  | pki certs ISSUER | pki crl ISSUER | pki revoke SERIAL",
	"  | pki roles | pki role set NAME --issuer I --domain D… [--ttl T] [--max-ttl T]",
	"        [--allow-ip-sans] [--server] [--client] | pki role delete NAME",
	"  | pki issue ROLE --common-name CN [--alt-name N…] [--ip-san IP…] [--ttl T] [--key-out FILE]",
	"  | pki sign ROLE --csr FILE|- [--common-name CN] [--ttl T]",
].join("\n");

function values(args: SecretsArgs, name: string): string[] {
	return (args.values.get(name) ?? [])
		.flatMap((value) => value.split(","))
		.map((value) => value.trim())
		.filter(Boolean);
}

function ttlSecs(args: SecretsArgs, name = "--ttl"): number | undefined {
	const value = flag(args, name);
	return value === undefined ? undefined : parseDuration(value);
}

function print(ctx: CliContext, value: unknown, text: string): number {
	if (ctx.flags.json) {
		printJson(ctx, value);
	} else {
		ctx.io.out(`${text}\n`);
	}
	return 0;
}

/** The `issue`/`sign` body from flags. `--common-name` is required to issue. */
export function issueInput(
	args: SecretsArgs,
	requireCommonName: boolean
): VaultPkiIssueInput {
	const commonName = flag(args, "--common-name");
	if (requireCommonName && !commonName) {
		throw new UsageError("pki issue needs --common-name.");
	}
	const input: VaultPkiIssueInput = { commonName: commonName ?? "" };
	const altNames = values(args, "--alt-name");
	if (altNames.length > 0) {
		input.altNames = altNames;
	}
	const ipSans = values(args, "--ip-san");
	if (ipSans.length > 0) {
		input.ipSans = ipSans;
	}
	const ttl = ttlSecs(args);
	if (ttl !== undefined) {
		input.ttlSecs = ttl;
	}
	return input;
}

/** Where `--key-out` writes, checked before Core issues anything: an
 *  existing path (a symlink included, dangling or not) is refused without
 *  `--force`, and a directory always. */
async function keyPath(ctx: CliContext, target: string): Promise<string> {
	const path = isAbsolute(target)
		? target
		: join(ctx.cwd ?? process.cwd(), target);
	let existing: Awaited<ReturnType<typeof lstat>> | null = null;
	try {
		existing = await lstat(path);
	} catch {
		existing = null;
	}
	if (existing?.isDirectory()) {
		throw new UsageError(tf("{file} is a directory.", { file: target }));
	}
	if (existing && !ctx.flags.force) {
		throw new UsageError(
			tf("{file} already exists; pass --force to replace it.", { file: target })
		);
	}
	await checkOutParent(path, target);
	return path;
}

/** Write a new private key owner-only (0600), never through a symlink:
 *  created exclusively without `--force`, renamed over the path with it. */
async function writeKey(
	path: string,
	key: string,
	force: boolean
): Promise<void> {
	const data = key.endsWith("\n") ? key : `${key}\n`;
	await (force ? replaceExclusive : createExclusive)(path, data, 0o600);
}

async function readCsr(ctx: CliContext, source: string): Promise<string> {
	if (source === "-") {
		const piped = await ctx.readStdin();
		if (piped === null) {
			throw new UsageError("--csr - reads the CSR from stdin; pipe it in.");
		}
		return piped;
	}
	const path = isAbsolute(source)
		? source
		: join(ctx.cwd ?? process.cwd(), source);
	return await readFile(path, "utf8");
}

function certificateText(certificate: VaultIssuedCertificate): string {
	return [certificate.certificate.trim(), certificate.issuingCa.trim()].join(
		"\n"
	);
}

async function issue(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const role = arg(args, 2, "pki issue ROLE --common-name CN");
	const input = issueInput(args, true);
	const keyOut = flag(args, "--key-out");
	// Checked before Core issues: a refusal must not leave an issued
	// certificate whose key was thrown away.
	const path = keyOut === undefined ? undefined : await keyPath(ctx, keyOut);
	const { certificate } = await vaultPki(ctx.target, "issue", role, input);
	const { privateKey, ...publicPart } = certificate;
	if (path !== undefined && keyOut !== undefined && privateKey) {
		try {
			await writeKey(path, privateKey, ctx.flags.force);
		} catch (error) {
			// Core has issued and never stores the key: say which certificate
			// to revoke instead of surfacing a bare file-system error.
			const reason = writeFailure(error);
			ctx.io.err(
				`${tf("The certificate (serial {serial}) was issued, but its private key could not be written to {file}: {reason}. The key is gone; revoke the certificate with 'ryu-cli secrets pki revoke {serial}'.", { file: keyOut, reason, serial: certificate.serial })}\n`
			);
			return 1;
		}
		if (ctx.flags.json) {
			printJson(ctx, { certificate: publicPart, keyFile: path });
		} else {
			ctx.io.out(`${certificateText(certificate)}\n`);
			ctx.io.err(
				`${tf("Wrote the private key to {file}.", { file: keyOut })}\n`
			);
		}
		return 0;
	}
	const text = privateKey
		? `${certificateText(certificate)}\n${privateKey.trim()}`
		: certificateText(certificate);
	return print(ctx, { certificate }, text);
}

async function roles(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const [, , verb] = args.positional;
	if (verb === undefined || verb === "list") {
		const { roles: list } = await listVaultPkiRoles(ctx.target);
		const rows = list.map((role) => [
			role.name,
			role.issuer,
			role.allowedDomains.join(","),
			String(role.maxTtlSecs),
		]);
		return print(
			ctx,
			list,
			formatTable(["NAME", "ISSUER", "DOMAINS", "MAX TTL"], rows)
		);
	}
	const name = arg(args, 3, `pki role ${verb} NAME`);
	if (verb === "delete") {
		const result = await deleteVaultPkiRole(ctx.target, name);
		return print(
			ctx,
			result,
			result.deleted ? tf("Deleted {name}.", { name }) : name
		);
	}
	if (verb !== "set") {
		throw new UsageError(USAGE);
	}
	const issuer = flag(args, "--issuer");
	const allowedDomains = values(args, "--domain");
	if (!issuer || allowedDomains.length === 0) {
		throw new UsageError(
			"pki role set needs --issuer and at least one --domain."
		);
	}
	const defaultTtl = ttlSecs(args) ?? 24 * 3600;
	const maxTtl = ttlSecs(args, "--max-ttl") ?? defaultTtl;
	if (maxTtl < defaultTtl) {
		throw new UsageError("--max-ttl must be at least --ttl.");
	}
	const { role } = await putVaultPkiRole(ctx.target, name, {
		issuer,
		allowedDomains,
		defaultTtlSecs: defaultTtl,
		maxTtlSecs: maxTtl,
		allowIpSans: args.booleans.has("--allow-ip-sans"),
		serverFlag: args.booleans.has("--server"),
		clientFlag: args.booleans.has("--client"),
	});
	return print(
		ctx,
		role,
		`${role.name}: ${role.allowedDomains.join(", ")} (${role.issuer})`
	);
}

export async function pki(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const action = args.positional[1];
	switch (action) {
		case "issuers": {
			const { issuers } = await listVaultPkiIssuers(ctx.target);
			const rows = issuers.map((issuer) => [
				issuer.name,
				issuer.commonName,
				String(issuer.notAfter),
			]);
			return print(
				ctx,
				issuers,
				formatTable(["NAME", "COMMON NAME", "NOT AFTER"], rows)
			);
		}
		case "issuer": {
			if (args.positional[2] !== "create") {
				throw new UsageError(USAGE);
			}
			const name = arg(args, 3, "pki issuer create NAME --common-name CN");
			const commonName = flag(args, "--common-name");
			if (!commonName) {
				throw new UsageError("pki issuer create needs --common-name.");
			}
			const ttl = ttlSecs(args);
			const { issuer } = await createVaultPkiIssuer(ctx.target, {
				name,
				commonName,
				...(ttl === undefined ? {} : { ttlSecs: ttl }),
			});
			return print(ctx, issuer, issuer.certificate.trim());
		}
		case "certs": {
			const issuer = arg(args, 2, "pki certs ISSUER");
			const { certificates } = await listVaultPkiCertificates(
				ctx.target,
				issuer
			);
			const rows = certificates.map((cert) => [
				cert.serial,
				cert.commonName,
				String(cert.notAfter),
				cert.revokedAt === null ? "" : String(cert.revokedAt),
			]);
			return print(
				ctx,
				certificates,
				formatTable(["SERIAL", "COMMON NAME", "NOT AFTER", "REVOKED"], rows)
			);
		}
		case "crl": {
			const pem = await getVaultPkiCrl(
				ctx.target,
				arg(args, 2, "pki crl ISSUER")
			);
			return print(ctx, { crl: pem }, pem.trim());
		}
		case "revoke": {
			const serial = arg(args, 2, "pki revoke SERIAL");
			const { certificate } = await revokeVaultPkiCertificate(
				ctx.target,
				serial
			);
			return print(
				ctx,
				certificate,
				tf("Revoked {serial} ({name}).", {
					name: certificate.commonName,
					serial: certificate.serial,
				})
			);
		}
		case "roles":
		case "role":
			return await roles(ctx, args);
		case "issue":
			return await issue(ctx, args);
		case "sign": {
			const role = arg(args, 2, "pki sign ROLE --csr FILE");
			const source = flag(args, "--csr");
			if (source === undefined) {
				throw new UsageError("pki sign needs --csr FILE (or - for stdin).");
			}
			const input = {
				...issueInput(args, false),
				csr: await readCsr(ctx, source),
			};
			// A signed CSR has no key here; drop one if Core ever sent it.
			const { certificate } = await vaultPki(ctx.target, "sign", role, input);
			const { privateKey: _ignored, ...signed } = certificate;
			return print(ctx, { certificate: signed }, certificateText(certificate));
		}
		default:
			throw new UsageError(USAGE);
	}
}
