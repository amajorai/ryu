// Core checks: reachability (with the `--fix` start), version skew, services.

import type { ApiTarget } from "@ryuhq/core-client/client";
import { redactDiagnosticText } from "@ryuhq/core-client/troubleshoot";
import { z } from "zod";
import { isLocal } from "../core/bootstrap.ts";
import { tf } from "../i18n/translate.ts";
import {
	CORE_BASE_PORT,
	PROFILE_PORT_OFFSETS,
} from "./troubleshoot-constants.ts";
import { checkGatewayDoctor } from "./troubleshoot-doctor-updates.ts";
import type { TroubleshootHost } from "./troubleshoot-host.ts";
import {
	add,
	type CoreSnapshot,
	healthSchema,
	hostOf,
	installCommand,
	majorMinor,
	portOf,
	portOwnerHint,
	probeCore,
	type RunState,
	sidecarSchema,
	statusSchema,
	systemInfoSchema,
	type TroubleshootOptions,
	tokenFix,
} from "./troubleshoot-probes.ts";
import type { CliContext } from "./types.ts";
import { VERSION } from "./version.ts";

/** Which other profile's Core answers locally, when the configured one does not. */
export async function findOtherProfileCore(
	ctx: CliContext,
	host: TroubleshootHost,
	target: ApiTarget
): Promise<{ port: number; profile: string } | null> {
	const current = portOf(target.url);
	for (const [profile, offset] of PROFILE_PORT_OFFSETS) {
		const port = CORE_BASE_PORT + offset;
		if (port === current || !(await host.probePort("127.0.0.1", port))) {
			continue;
		}
		const probe = await probeCore(
			ctx,
			// Health is public; never hand this node's token to another Core.
			{ url: `http://127.0.0.1:${port}`, token: null },
			"/api/health",
			healthSchema
		);
		if (probe.value) {
			return { port, profile };
		}
	}
	return null;
}

export async function checkCore(
	ctx: CliContext,
	state: RunState,
	host: TroubleshootHost,
	target: ApiTarget,
	options: TroubleshootOptions
): Promise<CoreSnapshot> {
	const local = isLocal(target.url);
	const shownUrl = redactDiagnosticText(target.url);
	let health = await probeCore(ctx, target, "/api/health", healthSchema);

	if (!health.value && local && options.fix) {
		const port = portOf(target.url);
		const occupied =
			port !== null && (await host.probePort(hostOf(target.url), port));
		if (occupied) {
			state.fixes.push(
				`Did not start Core: something else already listens on port ${port}.`
			);
		} else if (options.dryRun) {
			state.fixes.push(`Would start a local Core at ${shownUrl}.`);
		} else {
			await host.startCore(target);
			health = await probeCore(ctx, target, "/api/health", healthSchema);
			state.fixes.push(
				health.value
					? `Started Core at ${shownUrl}.`
					: `Tried to start Core at ${shownUrl}; it did not become healthy (see the log check below).`
			);
		}
	}

	if (health.value) {
		const version = health.value.version ?? "unknown";
		state.machine.push([
			"Core",
			`${version}${health.value.channel ? ` (${health.value.channel})` : ""}`,
		]);
		if (health.value.gatewayVersion) {
			state.machine.push(["Gateway", health.value.gatewayVersion]);
		}
		add(state, {
			id: "core.reachable",
			status: "pass",
			title: "Core reachable",
			detail: tf("Core {version} answers at {shownUrl}.", { version, shownUrl }),
		});
		return { health: health.value, reachable: true };
	}

	state.machine.push(["Core", "unreachable"]);
	if (health.failure === "auth") {
		add(state, {
			id: "core.reachable",
			status: "fail",
			title: "Core reachable",
			detail: tf("Core at {shownUrl} refused this CLI ({message}).", {
				shownUrl,
				message: health.message,
			}),
			fix: tokenFix(host),
			searchTerms: "core 401 unauthorized token",
			unit: "apps/cli",
		});
		return { health: null, reachable: false };
	}

	const port = portOf(target.url);
	const occupied =
		local && port !== null && (await host.probePort(hostOf(target.url), port));
	if (occupied) {
		add(state, {
			id: "core.reachable",
			status: "fail",
			title: "Core reachable",
			detail: tf(
				"Something listens on port {port} but does not answer as Ryu Core ({message}).",
				{ port: String(port), message: health.message }
			),
			fix: `Find what owns the port with \`${portOwnerHint(host, port ?? CORE_BASE_PORT)}\`. If it is a stuck ryu-core, stop it and start Core again.`,
			searchTerms: "core port in use",
			unit: "apps/core",
		});
		return { health: null, reachable: false };
	}

	const other = local ? await findOtherProfileCore(ctx, host, target) : null;
	if (other) {
		add(state, {
			id: "core.reachable",
			status: "fail",
			title: "Core reachable",
			detail: tf(
				"No Core at {shownUrl}, but a {profile}-profile Core answers on port {port}.",
				{ shownUrl, profile: other.profile, port: String(other.port) }
			),
			fix: `Point the CLI at it: RYU_PROFILE=${other.profile} (or RYU_CORE_URL=http://127.0.0.1:${other.port}).`,
			searchTerms: "cli cannot connect core profile port",
			unit: "apps/cli",
		});
		return { health: null, reachable: false };
	}

	add(state, {
		id: "core.reachable",
		status: "fail",
		title: "Core reachable",
		detail: local
			? tf("Nothing is listening at {shownUrl}; Core is not running.", { shownUrl })
			: tf("Could not reach the remote Core at {shownUrl} ({message}).", {
					shownUrl,
					message: health.message,
				}),
		fix: local
			? `Start it with \`${host.commandName} troubleshoot --fix\`, by opening \`${host.commandName}\`, or by running \`ryu-core\`.`
			: "Check the node is online and reachable from this machine (VPN, firewall, URL).",
		searchTerms: local ? "core not starting" : "remote node unreachable",
		unit: "apps/core",
	});
	return { health: null, reachable: false };
}

export async function checkCoreDetails(
	ctx: CliContext,
	state: RunState,
	host: TroubleshootHost,
	target: ApiTarget,
	snapshot: CoreSnapshot,
	options: TroubleshootOptions
): Promise<void> {
	const health = snapshot.health;
	if (!(snapshot.reachable && health)) {
		add(state, {
			id: "core.details",
			status: "skip",
			title: "Core services",
			detail: "Skipped because Core is unreachable.",
		});
		return;
	}

	const coreVersion = health.version ?? "";
	if (coreVersion && majorMinor(coreVersion) !== majorMinor(VERSION)) {
		add(state, {
			id: "core.version-match",
			status: "warn",
			title: "CLI and Core versions",
			detail: tf(
				"CLI {VERSION} talks to Core {coreVersion}; mixed releases can disagree on APIs.",
				{ VERSION, coreVersion }
			),
			fix: `Update the older one: ${installCommand(host)}`,
			searchTerms: "version mismatch cli core",
			unit: "apps/cli",
		});
	} else {
		add(state, {
			id: "core.version-match",
			status: "pass",
			title: "CLI and Core versions",
			detail: tf("CLI {VERSION}, Core {coreVersion}.", {
				VERSION,
				coreVersion: coreVersion || "unknown",
			}),
		});
	}

	if (health.requiredRuntimeReady === false) {
		add(state, {
			id: "core.runtime-ready",
			status: "warn",
			title: "Core runtime",
			detail: "Core is still installing its required runtime pieces.",
			fix: `Wait a few minutes and re-run; \`${host.commandName} status\` shows progress.`,
			searchTerms: "required runtime not ready",
			unit: "apps/core",
		});
	}

	// `/api/health` is public, so a wrong or missing token first shows up here.
	const status = await probeCore(
		ctx,
		target,
		"/api/system/status",
		statusSchema
	);
	if (status.failure === "auth") {
		add(state, {
			id: "core.auth",
			status: "fail",
			title: "Core access",
			detail: tf("Core answers but refuses this CLI's requests ({message}).", {
				message: status.message,
			}),
			fix: tokenFix(host),
			searchTerms: "core 401 unauthorized token",
			unit: "apps/cli",
		});
		return;
	}
	const [sidecars, info] = await Promise.all([
		probeCore(ctx, target, "/api/sidecar/status", sidecarSchema),
		probeCore(ctx, target, "/api/system/info", systemInfoSchema),
	]);
	if (info.value?.gpu_name) {
		state.machine.push([
			"GPU",
			`${info.value.gpu_name}${info.value.vram_human ? ` (${info.value.vram_human})` : ""}`,
		]);
	}
	if (status.value) {
		const gatewayUp = status.value.gateway?.reachable ?? false;
		add(state, {
			id: "gateway.reachable",
			status: gatewayUp ? "pass" : "fail",
			title: "Gateway",
			detail: gatewayUp
				? "Core reaches its Gateway."
				: "Core cannot reach its Gateway; model routing, firewall, and budgets are down.",
			fix: `Restart Core (it supervises the Gateway). If ryu-gateway is missing, re-run the installer: ${installCommand(host)}`,
			searchTerms: "gateway unreachable",
			unit: "apps/gateway",
		});
		const engine = status.value.engine;
		if (engine?.active && engine.running === false) {
			add(state, {
				id: "engine.running",
				status: "warn",
				title: "Inference engine",
				detail: tf(
					"The active engine {active} is not running; local models will not answer.",
					{ active: engine.active }
				),
				fix: `Start it with \`${host.commandName} start ${engine.active}\`.`,
				searchTerms: `${engine.active} engine not running`,
				unit: "apps/core",
			});
		}
	} else {
		add(state, {
			id: "gateway.reachable",
			status: "skip",
			title: "Gateway",
			detail: tf("System status unavailable ({message}).", {
				message: status.message,
			}),
		});
	}

	const missing = sidecars.value?.missing_binaries ?? [];
	if (missing.length > 0) {
		add(state, {
			id: "sidecars.binaries",
			status: "fail",
			title: "Sidecar binaries",
			detail: `Missing: ${missing.map((m) => (m.expected_asset ? `${m.name} (${m.expected_asset})` : m.name)).join(", ")}.`,
			fix: `Re-run the installer to restore them: ${installCommand(host)}`,
			searchTerms: `${missing[0]?.name ?? "sidecar"} binary missing`,
			unit: "apps/core",
		});
	} else if (sidecars.value) {
		add(state, {
			id: "sidecars.binaries",
			status: "pass",
			title: "Sidecar binaries",
			detail: "Every enabled sidecar has its binary.",
		});
	}

	await checkGatewayDoctor(ctx, state, host, target, options);

	const plugins = await probeCore(
		ctx,
		target,
		"/api/plugins/doctor",
		z.object({ counts: z.object({ errors: z.number().catch(0) }) })
	);
	if (plugins.value) {
		const errors = plugins.value.counts.errors;
		add(state, {
			id: "plugins.doctor",
			status: errors > 0 ? "warn" : "pass",
			title: "Plugins",
			detail:
				errors > 0
					? tf(
							"Plugin Doctor found {errors, plural, one {# error} other {# errors}}.",
							{ errors }
						)
					: "Plugin Doctor found no errors.",
			fix: `See them with \`${host.commandName} plugin doctor\`.`,
			searchTerms: "plugin doctor error",
			unit: "apps/core",
		});
	}
}
