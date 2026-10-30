// Checks that work while Core is down: binaries, data dir, disk, memory, logs.

import { join } from "node:path";
import { logPath } from "@ryuhq/core-client/data-dir";
import {
	redactDiagnosticText,
	type TroubleshootCheck,
} from "@ryuhq/core-client/troubleshoot";
import { tf } from "../i18n/translate.ts";
import {
	DISK_FAIL_BYTES,
	DISK_WARN_BYTES,
	LOCAL_MODEL_RAM_BYTES,
	LOG_TAIL_BYTES,
} from "./troubleshoot-constants.ts";
import type { TroubleshootHost } from "./troubleshoot-host.ts";
import {
	add,
	extractLogErrors,
	gib,
	installCommand,
	type RunState,
	type TroubleshootOptions,
} from "./troubleshoot-probes.ts";
import type { CliContext } from "./types.ts";

/** Installed `ryu-core`/`ryu-gateway`, resolved like the bootstrapper does. */
export function checkBinaries(
	host: TroubleshootHost,
	local: boolean
): TroubleshootCheck[] {
	if (!local) {
		return [
			{
				id: "install.binaries",
				status: "skip",
				title: "Installed binaries",
				detail: "Core is remote; its binaries live on that machine.",
			},
		];
	}
	const core = host.resolveBinary("core");
	const gateway = host.resolveBinary("gateway");
	return [
		core
			? {
					id: "install.core-binary",
					status: "pass",
					title: "Core binary",
					detail: redactDiagnosticText(core, { homeDir: host.homeDir }),
				}
			: {
					id: "install.core-binary",
					status: "fail",
					title: "Core binary",
					detail:
						"ryu-core was not found in RYU_CORE_BIN, <data dir>/bin, or PATH.",
					fix: `Install it: ${installCommand(host)}  (or run \`${host.commandName} troubleshoot --fix\` to download it)`,
					searchTerms: "ryu-core not found install",
					unit: "apps/cli",
				},
		gateway
			? {
					id: "install.gateway-binary",
					status: "pass",
					title: "Gateway binary",
					detail: redactDiagnosticText(gateway, { homeDir: host.homeDir }),
				}
			: {
					id: "install.gateway-binary",
					status: "warn",
					title: "Gateway binary",
					detail:
						"ryu-gateway was not found; Core runs without routing, firewall, and budgets.",
					fix: `Re-run the installer: ${installCommand(host)}`,
					searchTerms: "ryu-gateway missing",
					unit: "apps/gateway",
				},
	];
}

export async function checkDataDir(
	state: RunState,
	host: TroubleshootHost,
	options: TroubleshootOptions
): Promise<void> {
	const shown = redactDiagnosticText(host.dataDir, { homeDir: host.homeDir });
	let probe = await host.probeDir(host.dataDir);
	if (!probe.exists && options.fix) {
		if (options.dryRun) {
			state.fixes.push(`Would create the data directory ${shown}.`);
		} else {
			try {
				await host.makeDir(host.dataDir);
				state.fixes.push(`Created the data directory ${shown}.`);
				probe = await host.probeDir(host.dataDir);
			} catch (error) {
				state.fixes.push(
					`Could not create ${shown}: ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}
	}
	if (!probe.exists) {
		add(state, {
			id: "data-dir",
			status: probe.writable ? "warn" : "fail",
			title: "Data directory",
			detail: probe.writable
				? tf("{shown} does not exist yet; Core creates it on first start.", {
						shown,
					})
				: tf("{shown} does not exist yet, and its parent is not writable.", {
						shown,
					}),
			fix: probe.writable
				? `Start Core, or run \`${host.commandName} troubleshoot --fix\`.`
				: "Set RYU_DIR to a writable folder, or fix the parent folder's permissions.",
			searchTerms: "data directory permission",
			unit: "apps/core",
		});
	} else if (probe.writable) {
		add(state, {
			id: "data-dir",
			status: "pass",
			title: "Data directory",
			detail: tf("{shown} is writable.", { shown }),
		});
	} else {
		add(state, {
			id: "data-dir",
			status: "fail",
			title: "Data directory",
			detail: tf("{shown} is not writable by this user.", { shown }),
			fix:
				host.platform === "win32"
					? "Give your user Full control of the folder (Properties › Security), or set RYU_DIR to a writable folder."
					: `sudo chown -R "$(whoami)" ${shown}  (it was likely created by a root install), or set RYU_DIR.`,
			searchTerms: "permission denied data directory",
			unit: "apps/core",
		});
	}
	if (probe.freeBytes === null) {
		add(state, {
			id: "disk.free",
			status: "skip",
			title: "Free disk space",
			detail: "Could not read free space for the data directory's volume.",
		});
	} else {
		const free = probe.freeBytes;
		state.machine.push(["Disk free (data volume)", gib(free)]);
		add(state, {
			id: "disk.free",
			status:
				free < DISK_FAIL_BYTES
					? "fail"
					: free < DISK_WARN_BYTES
						? "warn"
						: "pass",
			title: "Free disk space",
			detail: tf("{free} free on the data directory's volume.", { free: gib(free) }),
			fix: "Free up space; models and engines need several GB. Move data with RYU_DIR or Settings › Storage.",
			searchTerms: "disk space download failed",
			unit: "apps/core",
		});
	}
}

export function checkMemory(state: RunState, host: TroubleshootHost): void {
	const total = host.memory.totalBytes;
	add(state, {
		id: "memory",
		status: "info",
		title: "Memory",
		detail:
			total < LOCAL_MODEL_RAM_BYTES
				? tf(
						"{total} total; local models will be slow or fail to load. Prefer a cloud provider.",
						{ total: gib(total) }
					)
				: `${gib(total)} total.`,
	});
}

export function logCandidates(
	host: TroubleshootHost,
	env: CliContext["env"]
): string[] {
	const paths = [
		env.RYU_CORE_LOG_PATH,
		env.RYU_CORE_LOG,
		logPath(host.dataDir, "ryu-core.log"),
		// install.sh's fixed default: `${RYU_CORE_LOG:-$HOME/.ryu/ryu-core.log}`.
		join(host.homeDir, ".ryu", "ryu-core.log"),
	].filter((path): path is string => Boolean(path?.trim()));
	return [...new Set(paths)];
}

export async function checkLogs(
	ctx: CliContext,
	state: RunState,
	host: TroubleshootHost
): Promise<string[]> {
	const tails: string[] = [];
	for (const path of logCandidates(host, ctx.env)) {
		const tail = await host.readTail(path, LOG_TAIL_BYTES);
		if (tail !== null) {
			tails.push(tail);
		}
	}
	if (tails.length === 0) {
		add(state, {
			id: "logs",
			status: "skip",
			title: "Core log",
			detail: "No Core log file found.",
		});
		return [];
	}
	const errors = extractLogErrors(tails, host.homeDir);
	add(state, {
		id: "logs",
		status: errors.length > 0 ? "warn" : "pass",
		title: "Core log",
		detail:
			errors.length > 0
				? tf(
						"{count, plural, one {# recent error line} other {# recent error lines}}; latest: {latest}",
						{ count: errors.length, latest: errors.at(-1)?.slice(0, 160) ?? "" }
					)
				: "No recent errors.",
	});
	return errors;
}
