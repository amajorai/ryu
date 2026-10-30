// `ryu secrets …` — the Secret Vault developer workflow over Core's
// `/api/vault/*` projection, built on the typed `@ryuhq/core-client/vault`
// module. Every call goes through `ctx.target`, so a test injects a fake
// `target.fetch` (plus `ctx.spawn` / `ctx.readStdin`) and never touches a node.
//
// Values are printed only by the explicit `get` and `export` subcommands. `run`
// merges them into a child's environment and prints nothing about them.
// `run --broker` mints a credential-broker session instead and gives the child
// only the proxy environment, so the child never receives a value. With
// `--isolation=container` the child runs in a Docker container whose only
// egress is the broker (see `vaultIsolation.ts`).
//
// Machine-token mode: when `RYU_VAULT_TOKEN` is set, `get`, `export`, and `run`
// use the token-only `/api/vault/agent/*` routes (node-scoped values the token's
// policies may read) and send no node bearer. `ryu secrets login` exchanges an
// AppRole or OIDC/JWT credential for such a token and prints it.

import {
	createVaultBrokerSession,
	deleteVaultItem,
	type PutVaultItemInput,
	parseVaultJsonExport,
	putVaultItem,
	revealVaultCardField,
	revokeVaultBrokerSession,
	type VaultBrokerProxy,
	type VaultBrokerSessionInput,
	type VaultItemFieldInput,
	vaultAgentBrokerSession,
} from "@ryuhq/core-client/vault";
import { tf } from "../i18n/translate.ts";
import {
	approvals,
	audit,
	environments,
	login,
	logout,
	policies,
	sealCommand,
} from "./secrets-admin.ts";
import {
	arg,
	flag,
	parseDuration,
	parseSecretsArgs,
	type SecretsArgs,
} from "./secrets-args.ts";
import {
	brokerCaPem,
	brokerProxyReachable,
	brokerServices,
	childRuntimeEnvironment,
	dockerCliEnvironment,
	isolationMode,
	localBrokerCa,
	spawnUntilStopped,
} from "./secrets-broker.ts";
import { broker } from "./secrets-broker-admin.ts";
import { cards } from "./secrets-cards.ts";
import { SUBCOMMAND_HELP } from "./secrets-help.ts";
import {
	itemLocation,
	itemsGet,
	itemsList,
	itemsPutCard,
	parseItemField,
	totp,
} from "./secrets-items.ts";
import { agentTarget, exportResult, printJson } from "./secrets-output.ts";
import { passwordManagers } from "./secrets-pm.ts";
import { scan } from "./secrets-scan.ts";
import { tokenCommand, unwrap, wrap } from "./secrets-tokens.ts";
import {
	deleteSecret,
	exportSecrets,
	getSecret,
	importSecrets,
	listSecrets,
	listVersions,
	restore,
	rollback,
	setSecret,
} from "./secrets-values.ts";
import { type CliContext, type Command, UsageError } from "./types.ts";
import {
	defaultContainerHost,
	guardSignals,
	IsolationCancelledError,
	prepareContainer,
	runPrepared,
} from "./vaultIsolation.ts";
import { confirmIdentity } from "./vaultStepUp.ts";

export {
	parseDuration,
	parseSecretsArgs,
	type SecretsArgs,
} from "./secrets-args.ts";
export {
	parseCardExpiry,
	parseCardStdin,
	parseItemField,
} from "./secrets-items.ts";
export { PM_PENDING_EXIT } from "./secrets-pm.ts";
export { collectScanFiles, scanBatches } from "./secrets-scan.ts";

const USAGE = "ryu-cli secrets <subcommand> …";

async function runWithSecrets(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const command = args.passthrough ?? [];
	if (command.length === 0) {
		throw new UsageError(
			"Usage: ryu-cli secrets run [--env E] [--path P] [--broker SVC,…] -- CMD ARGS…"
		);
	}
	const container = isolationMode(args) === "container";
	if (
		!container &&
		(args.values.has("--image") || args.values.has("--mount"))
	) {
		throw new UsageError("--image and --mount need --isolation=container.");
	}
	if (args.values.has("--broker")) {
		if (brokerServices(args).length === 0) {
			throw new UsageError("--broker needs at least one service name.");
		}
		// Container mode hands this environment to the host `docker` CLI (which
		// needs DOCKER_* configuration), never to the isolated command. A host
		// child gets only the reviewed runtime allowlist plus the proxy env.
		const baseEnv = container
			? dockerCliEnvironment(ctx.env)
			: childRuntimeEnvironment(ctx.env);
		return await runWithBroker(ctx, args, command, baseEnv, container);
	}
	if (container) {
		throw new UsageError(
			"--isolation=container needs --broker: the container reaches the network only through the credential broker."
		);
	}
	if (flag(args, "--ttl") !== undefined) {
		throw new UsageError("--ttl applies to 'run --broker' only.");
	}
	const values = parseVaultJsonExport(await exportResult(ctx, args, "json"));
	return await ctx.spawn(command, {
		...childRuntimeEnvironment(ctx.env),
		...values,
	});
}

type BrokerGrant = Awaited<ReturnType<typeof createVaultBrokerSession>>;

/** Mints the broker session, checks that its proxy is usable from here, runs
 *  `body`, and always revokes a human-minted session afterwards. */
async function withBrokerSession(
	ctx: CliContext,
	args: SecretsArgs,
	command: string[],
	body: (grant: BrokerGrant, proxy: VaultBrokerProxy) => Promise<number>
): Promise<number> {
	const input: VaultBrokerSessionInput = {
		services: brokerServices(args),
		label: `ryu secrets run ${command[0] ?? ""}`.trim(),
	};
	const environment = flag(args, "--env");
	const ttl = flag(args, "--ttl");
	if (environment) {
		input.environment = environment;
	}
	if (ttl !== undefined) {
		input.ttlSecs = parseDuration(ttl);
	}
	const agent = agentTarget(ctx);
	const grant = agent
		? await vaultAgentBrokerSession(agent, input)
		: await createVaultBrokerSession(ctx.target, input);
	try {
		const { proxy } = grant;
		if (!proxy) {
			ctx.io.err(
				"The credential broker is not listening on this node, so no proxy environment is available.\n"
			);
			return 1;
		}
		if (!brokerProxyReachable(ctx, proxy)) {
			ctx.io.err(
				"The broker proxy listens only on the node's loopback interface, so it is not reachable from this host.\n" +
					"Run this command on the node, or tunnel the proxy port (for example `ssh -L`) and target the node through that tunnel.\n"
			);
			return 1;
		}
		return await body(grant, proxy);
	} finally {
		// The revoke route is human-only; a machine-minted session ends with
		// its TTL or its token.
		if (!agent) {
			try {
				await revokeVaultBrokerSession(ctx.target, grant.session.id);
			} catch {
				ctx.io.err(
					`${tf("Could not revoke broker session {id}; it expires at {expiresAt}.", { id: grant.session.id, expiresAt: String(grant.session.expiresAt) })}\n`
				);
			}
		}
	}
}

/** `run --broker`: the child reaches the named services through the broker
 *  proxy and never receives a credential value or the session token in
 *  anything but the proxy URL Core rendered for it. */
async function runWithBroker(
	ctx: CliContext,
	args: SecretsArgs,
	command: string[],
	baseEnv: Record<string, string>,
	container: boolean
): Promise<number> {
	if (container) {
		return await runWithBrokerInContainer(ctx, args, command, baseEnv);
	}
	// Installed before minting, so a signal at any point unwinds through the
	// `finally` blocks below (CA cleanup, session revoke) instead of the
	// default action killing the CLI with the session still live.
	const guard = guardSignals(ctx.containerHost ?? defaultContainerHost());
	try {
		return await withBrokerSession(
			ctx,
			args,
			command,
			async (_grant, proxy) => {
				guard.throwIfCancelled();
				const ca = await localBrokerCa(ctx, proxy);
				const env = { ...baseEnv };
				for (const [key, value] of Object.entries(proxy.env)) {
					env[key] = ca.replacements.get(value) ?? value;
				}
				try {
					guard.throwIfCancelled();
					return await spawnUntilStopped(ctx, guard, command, env);
				} finally {
					await ca.cleanup();
				}
			}
		);
	} catch (error) {
		if (error instanceof IsolationCancelledError) {
			ctx.io.err(
				`${tf("ryu: stopped by {signal}.", { signal: error.signal })}\n`
			);
			return error.exitCode;
		}
		throw error;
	} finally {
		guard.dispose();
	}
}

/** `run --broker --isolation=container`. Docker checks, path validation, and
 *  images come first, so a run that cannot start mints no session. A signal
 *  at any point before the command starts cancels setup, tears down what was
 *  created, revokes the session, and exits 128 + the signal number. */
async function runWithBrokerInContainer(
	ctx: CliContext,
	args: SecretsArgs,
	command: string[],
	baseEnv: Record<string, string>
): Promise<number> {
	const host = ctx.containerHost ?? defaultContainerHost();
	const guard = guardSignals(host);
	const containerCtx = { err: ctx.io.err, guard, host };
	try {
		const prepared = await prepareContainer(containerCtx, {
			env: ctx.env,
			image: flag(args, "--image"),
			mounts: args.values.get("--mount") ?? [],
		});
		return await withBrokerSession(ctx, args, command, async (grant, proxy) => {
			guard.throwIfCancelled();
			return await runPrepared(
				{ ...containerCtx, spawn: ctx.spawn },
				prepared,
				{
					brokerPort: proxy.port,
					caPem: await brokerCaPem(ctx, proxy),
					command,
					dockerEnv: baseEnv,
					expiresAt: grant.session.expiresAt,
					token: grant.token,
				}
			);
		});
	} catch (error) {
		if (error instanceof IsolationCancelledError) {
			ctx.io.err(
				`${tf("ryu: {message}; the container setup was removed.", { message: error.message })}\n`
			);
			return error.exitCode;
		}
		throw error;
	} finally {
		guard.dispose();
	}
}

async function itemsPut(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const key = arg(args, 2, "items put KEY --type T --field name=value[:plain]");
	if (flag(args, "--type") === "card") {
		return await itemsPutCard(ctx, args, key);
	}
	const specs = args.values.get("--field") ?? [];
	if (specs.length === 0) {
		throw new UsageError(
			"Usage: ryu secrets items put KEY --type T --field name=value[:plain]…"
		);
	}
	const fields: VaultItemFieldInput[] = [];
	const values: Record<string, string> = {};
	for (const spec of specs) {
		const parsed = parseItemField(spec);
		fields.push(parsed.field);
		if (parsed.value !== "") {
			values[parsed.field.name] = parsed.value;
		}
	}
	const input: PutVaultItemInput = { ...itemLocation(args), fields, values };
	const kind = flag(args, "--type");
	const description = flag(args, "--description");
	if (kind) {
		input.kind = kind;
	}
	if (description !== undefined) {
		input.description = description;
	}
	const { item } = await putVaultItem(ctx.target, key, input);
	if (ctx.flags.json) {
		printJson(ctx, item);
	} else {
		ctx.io.out(
			`${tf("Stored item {key} (version {version}).", { key: item.key, version: String(item.version) })}\n`
		);
	}
	return 0;
}

async function items(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const action = args.positional[1];
	if (action === "list" || action === "ls") {
		return await itemsList(ctx, args);
	}
	if (action === "get") {
		return await itemsGet(ctx, args);
	}
	if (action === "put" || action === "set") {
		return await itemsPut(ctx, args);
	}
	if (action === "reveal") {
		const usage = "items reveal KEY FIELD";
		// A card's number and CVC need a single-use approval per reveal.
		const result = await revealVaultCardField(
			ctx.target,
			arg(args, 2, usage),
			arg(args, 3, usage),
			itemLocation(args)
		);
		if (result.status === "approval_required") {
			if (ctx.flags.json) {
				printJson(ctx, result);
			} else {
				ctx.io.err(
					`${tf("Approval required ({id}). Approve with: ryu secrets cards approvals approve {id}, then run this again.", { id: result.approval.id })}\n`
				);
			}
			return 1;
		}
		if (ctx.flags.json) {
			printJson(ctx, { field: result.field, value: result.value });
		} else {
			ctx.io.out(`${result.value}\n`);
		}
		return 0;
	}
	if (action === "delete" || action === "rm") {
		const key = arg(args, 2, "items delete KEY");
		const result = await deleteVaultItem(ctx.target, key, itemLocation(args));
		if (ctx.flags.json) {
			printJson(ctx, result);
		} else {
			ctx.io.out(
				result.deleted
					? `${tf("Deleted item {key}.", { key })}\n`
					: `${tf("No item {key}.", { key })}\n`
			);
		}
		return 0;
	}
	throw new UsageError(
		"Usage: ryu secrets items list|get KEY|put KEY --type T --field name=value[:plain]|reveal KEY FIELD|delete KEY"
	);
}

// ── Registry ─────────────────────────────────────────────────────────────────

type SecretsHandler = (ctx: CliContext, args: SecretsArgs) => Promise<number>;

const SUBCOMMANDS = new Map<string, SecretsHandler>([
	["approvals", approvals],
	["audit", audit],
	["broker", broker],
	["cards", cards],
	["confirm", confirmIdentity],
	["delete", deleteSecret],
	["env", environments],
	["export", exportSecrets],
	["get", getSecret],
	["import", importSecrets],
	["items", items],
	["list", listSecrets],
	["login", login],
	["logout", (ctx) => logout(ctx)],
	["ls", listSecrets],
	["pm", passwordManagers],
	["policy", policies],
	["restore", restore],
	["rm", deleteSecret],
	["rollback", rollback],
	["run", runWithSecrets],
	["scan", scan],
	["seal", sealCommand],
	["set", setSecret],
	["status", sealCommand],
	["token", tokenCommand],
	["totp", totp],
	["unseal", sealCommand],
	["unwrap", unwrap],
	["versions", listVersions],
	["wrap", wrap],
]);

export const secretsCommand: Command = {
	name: "secrets",
	aliases: ["secret", "vault"],
	summary:
		"Manage Secret Vault values, run commands with them, and scan for leaks",
	usage: "ryu-cli secrets <list|get|set|run|export|import|scan|…>",
	run: async (ctx) => {
		const args = parseSecretsArgs(ctx.rawArgs);
		const subcommand = args.positional[0];
		if (!subcommand || subcommand === "help") {
			ctx.io.out(`${SUBCOMMAND_HELP}\n`);
			return 0;
		}
		const handler = SUBCOMMANDS.get(subcommand);
		if (!handler) {
			throw new UsageError(
				`Unknown subcommand '${subcommand}'. Usage: ${USAGE} (see 'ryu-cli secrets help').`
			);
		}
		return await handler(ctx, args);
	},
};
