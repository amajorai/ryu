import {
	decideVaultBrokerProposal,
	getVaultBrokerCaPem,
	listVaultBrokerLogs,
	listVaultBrokerProposals,
	listVaultBrokerServices,
	listVaultBrokerSessions,
	revokeVaultBrokerSession,
} from "@ryuhq/core-client/vault";
import { z } from "zod";
import { tf } from "../i18n/translate.ts";
import { formatTable, truncate } from "./output.ts";
import {
	arg,
	flag,
	grantFlag,
	intFlag,
	type SecretsArgs,
} from "./secrets-args.ts";
import { machineTarget, printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

async function brokerServicesCommand(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const { services } = await listVaultBrokerServices(ctx.target, {
		environment: flag(args, "--env"),
	});
	if (ctx.flags.json) {
		printJson(ctx, services);
		return 0;
	}
	if (services.length === 0) {
		ctx.io.out("No broker services.\n");
		return 0;
	}
	const rows = services.map((service) => [
		service.name,
		service.environment,
		`${service.host}${service.port ? `:${service.port}` : ""}${service.pathPrefix === "/" ? "" : service.pathPrefix}`,
		service.enabled ? "enabled" : "disabled",
		truncate(service.description ?? "", 40),
	]);
	ctx.io.out(
		`${formatTable(["NAME", "ENV", "UPSTREAM", "STATE", "DESCRIPTION"], rows)}\n`
	);
	return 0;
}

async function brokerSessionsCommand(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	if (args.positional[2] === "revoke") {
		const id = arg(args, 3, "broker sessions revoke ID");
		const result = await revokeVaultBrokerSession(ctx.target, id);
		if (ctx.flags.json) {
			printJson(ctx, result);
		} else {
			ctx.io.out(
				result.revoked
					? `Revoked ${id}.\n`
					: `${tf("{id} was already revoked.", { id })}\n`
			);
		}
		return 0;
	}
	const { sessions } = await listVaultBrokerSessions(ctx.target);
	if (ctx.flags.json) {
		printJson(ctx, sessions);
		return 0;
	}
	if (sessions.length === 0) {
		ctx.io.out("No live broker sessions.\n");
		return 0;
	}
	const rows = sessions.map((session) => [
		session.id,
		session.environment,
		session.services.join(","),
		session.mintedBy,
		String(session.expiresAt),
		truncate(session.label, 30),
	]);
	ctx.io.out(
		`${formatTable(["ID", "ENV", "SERVICES", "BY", "EXPIRES", "LABEL"], rows)}\n`
	);
	return 0;
}

async function brokerLogsCommand(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const { logs } = await listVaultBrokerLogs(ctx.target, {
		environment: flag(args, "--env"),
		service: flag(args, "--service"),
		limit: intFlag(args, "--limit"),
		before: intFlag(args, "--before"),
	});
	if (ctx.flags.json) {
		printJson(ctx, logs);
		return 0;
	}
	if (logs.length === 0) {
		ctx.io.out("No brokered requests.\n");
		return 0;
	}
	const rows = logs.map((row) => [
		String(row.id),
		String(row.at),
		row.service ?? "-",
		row.method,
		truncate(`${row.host}${row.path}`, 50),
		String(row.status),
		row.outcome,
	]);
	ctx.io.out(
		`${formatTable(["ID", "AT", "SERVICE", "METHOD", "URL", "STATUS", "OUTCOME"], rows)}\n`
	);
	return 0;
}

const brokerProposalStatusSchema = z.enum([
	"pending",
	"approved",
	"rejected",
	"expired",
]);

async function brokerProposalsCommand(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[2];
	if (action === "approve" || action === "reject") {
		const id = arg(args, 3, `broker proposals ${action} ID [--reason R]`);
		const note = flag(args, "--reason");
		const grant = grantFlag(args);
		const result = await decideVaultBrokerProposal(ctx.target, id, action, {
			...(note ? { note } : {}),
			...(grant ? { grant } : {}),
		});
		if (ctx.flags.json) {
			printJson(ctx, result);
		} else {
			ctx.io.out(
				`${action === "approve" ? "Approved" : "Rejected"} proposal ${id}.\n`
			);
		}
		return 0;
	}
	if (action !== undefined && action !== "list") {
		throw new UsageError(
			"Usage: ryu-cli secrets broker proposals [list [--status S] | approve ID | reject ID [--reason R]]"
		);
	}
	const status = brokerProposalStatusSchema.safeParse(
		flag(args, "--status") ?? "pending"
	);
	if (!status.success) {
		throw new UsageError(
			"--status must be pending, approved, rejected, or expired."
		);
	}
	const { proposals } = await listVaultBrokerProposals(ctx.target, {
		status: status.data,
	});
	if (ctx.flags.json) {
		printJson(ctx, proposals);
		return 0;
	}
	if (proposals.length === 0) {
		ctx.io.out(`${tf("No {status} proposals.", { status: status.data })}\n`);
		return 0;
	}
	const rows = proposals.map((proposal) => [
		proposal.id,
		proposal.environment,
		proposal.requestedBy,
		String(proposal.services.length),
		proposal.credentialUse
			? `${proposal.credentialUse.ref} (${proposal.credentialUse.subject})`
			: proposal.credentials.map((credential) => credential.ref).join(","),
		truncate(proposal.message, 40),
	]);
	ctx.io.out(
		`${formatTable(["ID", "ENV", "FROM", "SERVICES", "CREDENTIALS", "MESSAGE"], rows)}\n`
	);
	return 0;
}

async function brokerCaCommand(ctx: CliContext): Promise<number> {
	const pem = await getVaultBrokerCaPem(machineTarget(ctx));
	ctx.io.out(pem.endsWith("\n") ? pem : `${pem}\n`);
	return 0;
}

const BROKER_USAGE =
	"Usage: ryu-cli secrets broker services|sessions [revoke ID]|logs|proposals [approve|reject ID]|ca";

export async function broker(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	switch (args.positional[1]) {
		case "services":
			return await brokerServicesCommand(ctx, args);
		case "sessions":
			return await brokerSessionsCommand(ctx, args);
		case "logs":
			return await brokerLogsCommand(ctx, args);
		case "proposals":
			return await brokerProposalsCommand(ctx, args);
		case "ca":
			return await brokerCaCommand(ctx);
		default:
			throw new UsageError(BROKER_USAGE);
	}
}
