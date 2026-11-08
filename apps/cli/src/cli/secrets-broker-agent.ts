// Agent side of the credential broker: `ryu-cli secrets broker discover`,
// `propose`, and `proposal ID`.
//
// An agent the broker refused (`403` with a `proposalHint`) lists what it may
// reach and asks a person for a missing host or credential. It authenticates
// with `RYU_VAULT_TOKEN` (a machine token) or with the `rvb_` broker session
// it already runs under (from `RYU_VAULT_BROKER_SESSION` or its proxy
// variables). Nothing here reads or prints a credential value; credentials
// are named by reference (`secret:NAME`) for a person to supply.
//
// An agent the broker started has no node token (Core injects only the proxy,
// NO_PROXY and CA variables), so against a tokenless plain-HTTP Core the
// session is sent only after Core proves it holds that session
// (`@ryuhq/core-client/core-identity-broker`).

import type { AppJsonValue } from "@ryuhq/core-client/app-request-json";
import { verifiedVaultAgentTarget } from "@ryuhq/core-client/core-identity-broker";
import {
	type VaultAgentTarget,
	type VaultBrokerProposal,
	vaultAgentBrokerDiscover,
	vaultAgentBrokerProposal,
	vaultAgentBrokerPropose,
} from "@ryuhq/core-client/vault";
import {
	brokerSessionFromEnv,
	brokerSessionTarget,
} from "@ryuhq/core-client/vault-broker-agent";
import { z } from "zod";
import {
	rawFetchForTarget,
	requiresCoreIdentity,
} from "../core/coreIdentity.ts";
import { tf } from "../i18n/translate.ts";
import { formatTable, truncate } from "./output.ts";
import { arg, flag, type SecretsArgs } from "./secrets-args.ts";
import { agentTarget, machineTarget, printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

const HTTPS_URL = /^https:/i;

const PROPOSE_USAGE =
	"Usage: ryu-cli secrets broker propose --message WHY [--host HOST [--name N] [--auth bearer|api_key|passthrough] [--header H]] [--credential REF [--instructions TEXT]]…";

/** The agent's target: a machine token, else its broker session. */
export function brokerAgentTarget(ctx: CliContext): VaultAgentTarget {
	const machine = agentTarget(ctx);
	if (machine) {
		return machine;
	}
	const session = brokerSessionFromEnv(ctx.env);
	if (!session) {
		throw new UsageError(
			"This command runs as an agent: set RYU_VAULT_TOKEN, or run it inside an agent started through the credential broker (or with RYU_VAULT_BROKER_SESSION set)."
		);
	}
	const core = ctx.target;
	// A node token verifies a loopback Core already (`withCoreIdentityCheck`),
	// and https has TLS; otherwise the session has to prove Core itself.
	if (requiresCoreIdentity(core) || HTTPS_URL.test(core.url)) {
		return brokerSessionTarget(machineTarget(ctx), session);
	}
	return verifiedVaultAgentTarget(
		{ url: core.url, fetch: rawFetchForTarget(core) },
		{ brokerSession: session }
	);
}

const discoveredServiceSchema = z.object({
	name: z.string(),
	host: z.string(),
	auth: z.string().catch(""),
	placeholders: z.array(z.object({ placeholder: z.string() })).catch(() => []),
});

async function discoverCommand(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const discovery = await vaultAgentBrokerDiscover(brokerAgentTarget(ctx), {
		environment: flag(args, "--env"),
	});
	if (ctx.flags.json) {
		printJson(ctx, discovery);
		return 0;
	}
	ctx.io.out(
		`${tf("Environment {environment}; unknown hosts: {policy}.", {
			environment: discovery.environment,
			policy: String(discovery.unmatchedHostPolicy),
		})}\n`
	);
	const services = discovery.services.flatMap((raw) => {
		const parsed = discoveredServiceSchema.safeParse(raw);
		return parsed.success ? [parsed.data] : [];
	});
	if (services.length === 0) {
		ctx.io.out(
			"No services. Ask for one with 'ryu-cli secrets broker propose'.\n"
		);
		return 0;
	}
	const rows = services.map((service) => [
		service.name,
		service.host,
		service.auth,
		service.placeholders.map((entry) => entry.placeholder).join(","),
	]);
	ctx.io.out(
		`${formatTable(["NAME", "HOST", "AUTH", "PLACEHOLDERS"], rows)}\n`
	);
	return 0;
}

/** Credential references a proposal may name; never a value. */
const REFERENCE_PREFIXES = ["secret:", "op://", "bws://"];

/** A service name derived from a host: `api.linear.app` → `api-linear-app`. */
export function serviceNameForHost(host: string): string {
	const name = host
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return name || "service";
}

function serviceAuth(
	args: SecretsArgs,
	credential: string | undefined
): Record<string, AppJsonValue> {
	const kind = flag(args, "--auth") ?? (credential ? "bearer" : "passthrough");
	if (kind === "passthrough") {
		return { type: "passthrough" };
	}
	if (!credential) {
		throw new UsageError(`--auth ${kind} needs a --credential reference.`);
	}
	if (kind === "bearer") {
		return { type: "bearer", token: credential };
	}
	if (kind === "api_key") {
		const header = flag(args, "--header");
		if (!header) {
			throw new UsageError("--auth api_key needs --header NAME.");
		}
		return { type: "api_key", header, value: credential };
	}
	throw new UsageError("--auth must be bearer, api_key, or passthrough.");
}

/** The proposal body for `propose`. Exported for tests. */
export function proposalInput(args: SecretsArgs): {
	credentials: { obtainInstructions: string; ref: string }[];
	environment?: string;
	message: string;
	services: Record<string, AppJsonValue>[];
} {
	const message = flag(args, "--message")?.trim() ?? "";
	const host = flag(args, "--host")?.trim().toLowerCase();
	const references = args.values.get("--credential") ?? [];
	if (!message || (references.length === 0 && !host)) {
		throw new UsageError(PROPOSE_USAGE);
	}
	for (const reference of references) {
		if (!REFERENCE_PREFIXES.some((prefix) => reference.startsWith(prefix))) {
			throw new UsageError(
				`--credential takes a reference such as secret:NAME or op://vault/item/field, not '${truncate(reference, 12)}'. Never pass a value.`
			);
		}
	}
	const instructions = flag(args, "--instructions") ?? "";
	const services = host
		? [
				{
					name: flag(args, "--name") ?? serviceNameForHost(host),
					host,
					auth: serviceAuth(args, references[0]),
				},
			]
		: [];
	const environment = flag(args, "--env");
	return {
		message,
		services,
		credentials: references.map((ref) => ({
			ref,
			obtainInstructions: instructions,
		})),
		...(environment ? { environment } : {}),
	};
}

function printProposal(ctx: CliContext, proposal: VaultBrokerProposal): void {
	ctx.io.out(
		`${tf("Proposal {id} is {status} (environment {environment}).", {
			environment: proposal.environment,
			id: proposal.id,
			status: proposal.status,
		})}\n`
	);
	if (proposal.status === "pending") {
		ctx.io.out(
			`${tf(
				"A person approves it in the Vault page's Broker tab. Check again with 'ryu-cli secrets broker proposal {id}'.",
				{ id: proposal.id }
			)}\n`
		);
	}
}

async function proposeCommand(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const input = proposalInput(args);
	const { proposal } = await vaultAgentBrokerPropose(
		brokerAgentTarget(ctx),
		input
	);
	if (ctx.flags.json) {
		printJson(ctx, proposal);
	} else {
		printProposal(ctx, proposal);
	}
	return 0;
}

async function proposalCommand(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const id = arg(args, 2, "broker proposal ID");
	const { proposal } = await vaultAgentBrokerProposal(
		brokerAgentTarget(ctx),
		id
	);
	if (ctx.flags.json) {
		printJson(ctx, proposal);
	} else {
		printProposal(ctx, proposal);
	}
	// Exit 3 while a person has not decided, like `pm read`.
	if (proposal.status === "pending") {
		return 3;
	}
	return proposal.status === "approved" ? 0 : 1;
}

/** Agent-side broker subcommands; null when `action` is not one of them. */
export function brokerAgentCommand(
	action: string | undefined
): ((ctx: CliContext, args: SecretsArgs) => Promise<number>) | null {
	switch (action) {
		case "discover":
			return discoverCommand;
		case "propose":
			return proposeCommand;
		case "proposal":
			return proposalCommand;
		default:
			return null;
	}
}
