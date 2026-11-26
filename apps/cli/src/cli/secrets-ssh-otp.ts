// `ryu-cli secrets ssh otp-roles|otp-role|otp` - SSH one-time passwords over
// Core's `/api/vault/ssh/otp-roles` and `/api/vault/ssh/creds` routes.
//
// `ssh otp` prints a one-time password, so the agent guard refuses it in an
// AI agent session (`printsSecretValues`). The public `verify` route is not a
// command: it consumes the password, and only the target host's helper (for
// example `vault-ssh-helper`) should call it.

import { isIP } from "node:net";
import {
	createVaultSshOtp,
	deleteVaultSshOtpRole,
	listVaultSshOtpRoles,
	putVaultSshOtpRole,
	type VaultSshOtpRequest,
	type VaultSshOtpRole,
	type VaultSshOtpRoleInput,
} from "@ryuhq/core-client/vault";
import { tf } from "../i18n/translate.ts";
import { formatTable } from "./output.ts";
import {
	arg,
	flag,
	intFlag,
	parseDuration,
	type SecretsArgs,
} from "./secrets-args.ts";
import { printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

export const SSH_OTP_USAGE = [
	"  | ssh otp-roles | ssh otp-role show NAME | ssh otp-role delete NAME",
	"  | ssh otp-role set NAME --default-user U --cidr C… [--allowed-user U…] [--exclude-cidr C…]",
	"        [--port 22] [--ttl 10m]",
	"  | ssh otp ROLE --ip IP [--username U]",
].join("\n");

/** Core's bounds for an unused OTP's lifetime (`vault/ssh/otp.rs`). */
const MIN_TTL_SECS = 60;
const MAX_TTL_SECS = 3600;

function values(args: SecretsArgs, name: string): string[] {
	return (args.values.get(name) ?? [])
		.flatMap((value) => value.split(","))
		.map((value) => value.trim())
		.filter(Boolean);
}

/** The role body from `set` flags. Omitted optional fields are left to Core's
 *  defaults (port 22, 10 minutes, no other users or exclusions): `set`
 *  replaces the whole role. */
export function otpRoleInput(args: SecretsArgs): VaultSshOtpRoleInput {
	const defaultUser = flag(args, "--default-user");
	const cidrList = values(args, "--cidr");
	if (!defaultUser || cidrList.length === 0) {
		throw new UsageError(
			"ssh otp-role set needs --default-user and at least one --cidr."
		);
	}
	const input: VaultSshOtpRoleInput = { defaultUser, cidrList };
	const allowedUsers = values(args, "--allowed-user");
	if (allowedUsers.length > 0) {
		input.allowedUsers = allowedUsers;
	}
	const excluded = values(args, "--exclude-cidr");
	if (excluded.length > 0) {
		input.excludeCidrList = excluded;
	}
	const port = intFlag(args, "--port");
	if (port !== undefined) {
		if (port < 1 || port > 65_535) {
			throw new UsageError("--port must be 1-65535.");
		}
		input.port = port;
	}
	const ttl = flag(args, "--ttl");
	if (ttl !== undefined) {
		const secs = parseDuration(ttl);
		if (secs < MIN_TTL_SECS || secs > MAX_TTL_SECS) {
			throw new UsageError("--ttl must be between 1m and 1h.");
		}
		input.ttlSecs = secs;
	}
	return input;
}

/** The `creds` body from flags. `--ip` is required and must be an address. */
export function otpRequest(args: SecretsArgs): VaultSshOtpRequest {
	const ip = flag(args, "--ip")?.trim();
	if (!ip) {
		throw new UsageError("ssh otp needs --ip IP (the target host).");
	}
	if (isIP(ip) === 0) {
		throw new UsageError("--ip must be an IP address.");
	}
	const request: VaultSshOtpRequest = { ip };
	const username = flag(args, "--username")?.trim();
	if (username) {
		request.username = username;
	}
	return request;
}

function table(roles: VaultSshOtpRole[]): string {
	return formatTable(
		["NAME", "USER", "ALLOWED USERS", "CIDRS", "EXCLUDED", "PORT", "TTL"],
		roles.map((role) => [
			role.name,
			role.defaultUser,
			role.allowedUsers.join(","),
			role.cidrList.join(","),
			role.excludeCidrList.join(","),
			String(role.port),
			`${role.ttlSecs}s`,
		])
	);
}

function print(ctx: CliContext, value: unknown, text: string): number {
	if (ctx.flags.json) {
		printJson(ctx, value);
	} else {
		ctx.io.out(`${text}\n`);
	}
	return 0;
}

function missing(ctx: CliContext, name: string): number {
	ctx.io.err(`${tf("No SSH OTP role named {name}.", { name })}\n`);
	return 1;
}

async function otpRoles(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const verb = args.positional[2];
	if (verb === undefined || verb === "list") {
		const { roles } = await listVaultSshOtpRoles(ctx.target);
		return print(ctx, roles, table(roles));
	}
	if (!["show", "set", "delete"].includes(verb)) {
		throw new UsageError(`Usage: ryu-cli secrets ssh\n${SSH_OTP_USAGE}`);
	}
	const name = arg(args, 3, `ssh otp-role ${verb} NAME`);
	if (verb === "show") {
		// Core has no single-role read; the listing holds every visible role.
		const { roles } = await listVaultSshOtpRoles(ctx.target);
		const role = roles.find((candidate) => candidate.name === name);
		return role ? print(ctx, role, table([role])) : missing(ctx, name);
	}
	if (verb === "delete") {
		const result = await deleteVaultSshOtpRole(ctx.target, name);
		if (!result.deleted) {
			return missing(ctx, name);
		}
		return print(ctx, result, tf("Deleted {name}.", { name }));
	}
	const { role } = await putVaultSshOtpRole(
		ctx.target,
		name,
		otpRoleInput(args)
	);
	return print(ctx, role, table([role]));
}

/** Handle an OTP `ssh` action, or `null` when it is not one of these. */
export async function sshOtp(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number | null> {
	switch (args.positional[1]) {
		case "otp-roles":
		case "otp-role":
			return await otpRoles(ctx, args);
		case "otp": {
			const role = arg(args, 2, "ssh otp ROLE --ip IP [--username U]");
			const { credential } = await createVaultSshOtp(
				ctx.target,
				role,
				otpRequest(args)
			);
			if (ctx.flags.json) {
				printJson(ctx, credential);
				return 0;
			}
			// Only the password goes to stdout, so it can be piped.
			ctx.io.out(`${credential.key}\n`);
			ctx.io.err(
				`${tf("One-time password for {username}@{ip} port {port}. It works once and expires at {expiresAt}.", { username: credential.username, ip: credential.ip, port: String(credential.port), expiresAt: String(credential.expiresAt) })}\n`
			);
			return 0;
		}
		default:
			return null;
	}
}
