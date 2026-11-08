// `ryu secrets run`: start a command with Secret Vault values.
//
// Without `--broker` the command receives the exported values (narrowed by
// `--tags`) and one dynamic credential per `--lease`, whose lease is revoked
// when the command ends; `--watch` restarts it when those values change (see
// `secrets-watch.ts`). With `--broker` it receives only the credential-broker
// proxy environment and never a credential (an AI agent session's broker run
// also gets the `config` values, `secrets-agent-redaction.ts`); with
// `--isolation=container` it runs in a Docker container whose only egress is
// the broker (`vaultIsolation.ts`).

import {
	createVaultBrokerSession,
	revokeVaultBrokerSession,
	type VaultBrokerProxy,
	type VaultBrokerSessionInput,
	vaultAgentBrokerSession,
} from "@ryuhq/core-client/vault";
import { tf } from "../i18n/translate.ts";
import { isAgentBrokerRun } from "./secrets-agent-guard.ts";
import { agentConfigEnvironment } from "./secrets-agent-redaction.ts";
import { flag, parseDuration, type SecretsArgs } from "./secrets-args.ts";
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
import { agentTarget } from "./secrets-output.ts";
import { prepareTaggedRun } from "./secrets-run-env.ts";
import { runEventSource, runWatching } from "./secrets-watch.ts";
import { type CliContext, UsageError } from "./types.ts";
import {
	defaultContainerHost,
	guardSignals,
	IsolationCancelledError,
	prepareContainer,
	runPrepared,
} from "./vaultIsolation.ts";

const RUN_USAGE =
	"Usage: ryu-cli secrets run [--env E] [--path P] [--tags T,…] [--lease ROLE[=PREFIX]]… [--watch] [--broker SVC,…] -- CMD ARGS…";

export async function runWithSecrets(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const command = args.passthrough ?? [];
	if (command.length === 0) {
		throw new UsageError(RUN_USAGE);
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
		if (args.values.has("--lease")) {
			throw new UsageError(
				"--lease puts a credential in the command's environment, so it cannot be combined with --broker."
			);
		}
		if (args.booleans.has("--watch")) {
			ctx.io.err(
				"The broker reads current values on every request, so --watch is not needed with --broker.\n"
			);
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
	return await runWithValues(ctx, args, command);
}

/** A value run: the leases it issues are revoked when the command ends, also
 *  when the CLI is stopped by SIGTERM or SIGHUP. */
async function runWithValues(
	ctx: CliContext,
	args: SecretsArgs,
	command: string[]
): Promise<number> {
	const guard = guardSignals(ctx.containerHost ?? defaultContainerHost());
	try {
		if (args.booleans.has("--watch")) {
			return await runWatching(ctx, {
				command,
				events: runEventSource(ctx, args),
				guard,
				prepare: () => prepareTaggedRun(ctx, args),
			});
		}
		const prepared = await prepareTaggedRun(ctx, args);
		try {
			guard.throwIfCancelled();
			return await spawnUntilStopped(ctx, guard, command, prepared.env);
		} finally {
			await prepared.cleanup();
		}
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
	// Read before minting, so the session is not held while values export.
	const config = isAgentBrokerRun(args)
		? await agentConfigEnvironment(ctx, args)
		: {};
	const guard = guardSignals(ctx.containerHost ?? defaultContainerHost());
	try {
		return await withBrokerSession(
			ctx,
			args,
			command,
			async (_grant, proxy) => {
				guard.throwIfCancelled();
				const ca = await localBrokerCa(ctx, proxy);
				const env = { ...baseEnv, ...config };
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
