// `ryu-cli secrets ssh roles|role|sign|certs|revoke|krl`: SSH certificate
// roles, signing and revocation over Core's `/api/vault/ssh` routes.
//
// Nothing here is secret: `sign` takes a public key and returns a
// certificate, and the KRL is a public revocation list. The KRL is binary,
// so it is only written to `--out FILE`, never to the terminal.

import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	deleteVaultSshRole,
	getVaultSshKrl,
	listVaultSshCertificates,
	listVaultSshRoles,
	putVaultSshRole,
	revokeVaultSshCertificates,
	signVaultSshKey,
	type VaultSshSignInput,
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

export const SSH_CERT_USAGE = [
	"  | ssh roles | ssh role set NAME --ca CA --principal P… [--cert-type user|host]",
	"        [--ttl T] [--max-ttl T] [--extension E…] | ssh role delete NAME",
	"  | ssh sign ROLE --public-key FILE|- [--principal P…] [--key-id ID] [--ttl T] [--out FILE]",
	"  | ssh certs CA | ssh revoke CA --serial N | --key-id ID | ssh krl CA --out FILE",
].join("\n");

function values(args: SecretsArgs, name: string): string[] {
	return (args.values.get(name) ?? [])
		.flatMap((value) => value.split(","))
		.map((value) => value.trim())
		.filter(Boolean);
}

function ttlSecs(args: SecretsArgs, name: string): number | undefined {
	const value = flag(args, name);
	return value === undefined ? undefined : parseDuration(value);
}

function resolve(ctx: CliContext, file: string): string {
	return isAbsolute(file) ? file : join(ctx.cwd ?? process.cwd(), file);
}

function print(ctx: CliContext, value: unknown, text: string): number {
	if (ctx.flags.json) {
		printJson(ctx, value);
	} else {
		ctx.io.out(`${text}\n`);
	}
	return 0;
}

/** Where `--out` writes, checked before anything is requested: an existing
 *  path (a symlink included) is refused without `--force`, a directory
 *  always. */
async function outPath(ctx: CliContext, file: string): Promise<string> {
	const path = resolve(ctx, file);
	const existing = await lstat(path).catch(() => null);
	if (existing?.isDirectory()) {
		throw new UsageError(tf("{file} is a directory.", { file }));
	}
	if (existing && !ctx.flags.force) {
		throw new UsageError(
			tf("{file} already exists; pass --force to replace it.", { file })
		);
	}
	await checkOutParent(path, file);
	return path;
}

/** Create `path` exclusively (or, with `--force`, rename a new file over
 *  it), never writing through a symlink. */
async function writeOut(
	ctx: CliContext,
	path: string,
	data: string | Uint8Array
): Promise<void> {
	await (ctx.flags.force ? replaceExclusive : createExclusive)(path, data);
}

/** Public key types Core signs (`vault/ssh/mod.rs`). */
const PUBLIC_KEY_TYPES = new Set([
	"ssh-ed25519",
	"ssh-rsa",
	"ecdsa-sha2-nistp256",
	"ecdsa-sha2-nistp384",
	"ecdsa-sha2-nistp521",
	"sk-ssh-ed25519@openssh.com",
]);

/** `TYPE BASE64` from the one `TYPE BASE64 [COMMENT]` line of an OpenSSH public key, or a
 *  refusal. Anything else (a PEM, OpenSSH or PuTTY private key, bare base64,
 *  several keys) never leaves this process. */
export function publicKeyLine(text: string): string {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const match =
		lines.length === 1
			? /^(\S+) ([A-Za-z0-9+/]+={0,2})(?: .*)?$/.exec(lines[0] ?? "")
			: null;
	const type = match?.[1] ?? "";
	const blob = Buffer.from(match?.[2] ?? "", "base64");
	const named =
		blob.length > 4 &&
		blob.readUInt32BE(0) === type.length &&
		blob.subarray(4, 4 + type.length).toString("latin1") === type;
	if (!(match && PUBLIC_KEY_TYPES.has(type) && named)) {
		throw new UsageError(
			"--public-key must be a public key (the .pub file), never a private key."
		);
	}
	// Only `TYPE BASE64` goes to Core: the comment is the user's, not the key's.
	return `${type} ${match?.[2] ?? ""}`;
}

async function publicKey(ctx: CliContext, source: string): Promise<string> {
	if (source === "-") {
		const piped = await ctx.readStdin();
		if (piped === null) {
			throw new UsageError(
				"--public-key - reads the key from stdin; pipe it in."
			);
		}
		return piped.trim();
	}
	return (await readFile(resolve(ctx, source), "utf8")).trim();
}

/** The `sign` body from flags. Only a public key line is sent. */
export function signInput(args: SecretsArgs, key: string): VaultSshSignInput {
	const input: VaultSshSignInput = { publicKey: publicKeyLine(key) };
	const principals = values(args, "--principal");
	if (principals.length > 0) {
		input.principals = principals;
	}
	const keyId = flag(args, "--key-id");
	if (keyId !== undefined) {
		input.keyId = keyId;
	}
	const ttl = ttlSecs(args, "--ttl");
	if (ttl !== undefined) {
		input.ttlSecs = ttl;
	}
	return input;
}

async function roles(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const verb = args.positional[2];
	if (verb === undefined || verb === "list") {
		const { roles: list } = await listVaultSshRoles(ctx.target);
		const rows = list.map((role) => [
			role.name,
			role.ca,
			role.certType,
			role.allowedPrincipals.join(","),
		]);
		return print(
			ctx,
			list,
			formatTable(["NAME", "CA", "TYPE", "PRINCIPALS"], rows)
		);
	}
	const name = arg(args, 3, `ssh role ${verb} NAME`);
	if (verb === "delete") {
		const result = await deleteVaultSshRole(ctx.target, name);
		return print(
			ctx,
			result,
			result.deleted ? tf("Deleted {name}.", { name }) : name
		);
	}
	if (verb !== "set") {
		throw new UsageError(`Usage: ryu-cli secrets ssh\n${SSH_CERT_USAGE}`);
	}
	const ca = flag(args, "--ca");
	const allowedPrincipals = values(args, "--principal");
	if (!ca || allowedPrincipals.length === 0) {
		throw new UsageError(
			"ssh role set needs --ca and at least one --principal."
		);
	}
	const certType = flag(args, "--cert-type") ?? "user";
	if (certType !== "user" && certType !== "host") {
		throw new UsageError("--cert-type must be user or host.");
	}
	const defaultTtl = ttlSecs(args, "--ttl") ?? 3600;
	const maxTtl = ttlSecs(args, "--max-ttl") ?? defaultTtl;
	if (maxTtl < defaultTtl) {
		throw new UsageError("--max-ttl must be at least --ttl.");
	}
	const { role } = await putVaultSshRole(ctx.target, name, {
		ca,
		certType,
		allowedPrincipals,
		defaultTtlSecs: defaultTtl,
		maxTtlSecs: maxTtl,
		extensions: values(args, "--extension"),
	});
	return print(
		ctx,
		role,
		`${role.name}: ${role.certType} ${role.allowedPrincipals.join(", ")} (${role.ca})`
	);
}

/** Handle an `ssh` action, or `null` when it is not one of these. */
export async function sshCerts(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number | null> {
	const action = args.positional[1];
	switch (action) {
		case "roles":
		case "role":
			return await roles(ctx, args);
		case "sign": {
			const role = arg(args, 2, "ssh sign ROLE --public-key FILE");
			const source = flag(args, "--public-key");
			if (source === undefined) {
				throw new UsageError(
					"ssh sign needs --public-key FILE (or - for stdin)."
				);
			}
			const input = signInput(args, await publicKey(ctx, source));
			const out = flag(args, "--out");
			// Checked before Core signs, so a refusal never loses a certificate.
			const path = out === undefined ? undefined : await outPath(ctx, out);
			const { certificate } = await signVaultSshKey(ctx.target, role, input);
			if (path !== undefined && out !== undefined) {
				try {
					await writeOut(ctx, path, `${certificate.certificate.trim()}\n`);
				} catch (error) {
					// Core has signed: hand the certificate over on stdout anyway,
					// and name its serial in case it should be revoked.
					const reason = writeFailure(error);
					print(ctx, certificate, certificate.certificate.trim());
					ctx.io.err(
						`${tf("The certificate (serial {serial}) was signed but could not be written to {file}: {reason}. It is printed above.", { file: out, reason, serial: String(certificate.serial) })}\n`
					);
					return 1;
				}
			}
			return print(ctx, certificate, certificate.certificate.trim());
		}
		case "certs": {
			const ca = arg(args, 2, "ssh certs CA");
			const { certificates } = await listVaultSshCertificates(ctx.target, ca);
			const rows = certificates.map((cert) => [
				cert.serial,
				cert.keyId,
				String(cert.validBefore),
				cert.revokedAt === undefined ? "" : String(cert.revokedAt),
			]);
			return print(
				ctx,
				certificates,
				formatTable(["SERIAL", "KEY ID", "VALID BEFORE", "REVOKED"], rows)
			);
		}
		case "revoke": {
			const ca = arg(args, 2, "ssh revoke CA --serial N | --key-id ID");
			const serial = flag(args, "--serial");
			const keyId = flag(args, "--key-id");
			if ((serial === undefined) === (keyId === undefined)) {
				throw new UsageError(
					"ssh revoke needs exactly one of --serial or --key-id."
				);
			}
			const { certificates } = await revokeVaultSshCertificates(
				ctx.target,
				ca,
				serial === undefined ? { keyId: keyId ?? "" } : { serial }
			);
			return print(
				ctx,
				certificates,
				tf(
					"Revoked {count, plural, one {# certificate} other {# certificates}}.",
					{
						count: certificates.length,
					}
				)
			);
		}
		case "krl": {
			const ca = arg(args, 2, "ssh krl CA --out FILE");
			const out = flag(args, "--out");
			if (out === undefined) {
				throw new UsageError("ssh krl writes a binary file: pass --out FILE.");
			}
			const path = await outPath(ctx, out);
			const krl = await getVaultSshKrl(ctx.target, ca);
			await writeOut(ctx, path, krl);
			return print(
				ctx,
				{ file: path, bytes: krl.length },
				tf("Wrote the key revocation list to {file}.", { file: out })
			);
		}
		default:
			return null;
	}
}
