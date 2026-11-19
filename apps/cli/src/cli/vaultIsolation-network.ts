// The per-invocation bridge network: creation, IPv4 checks, and pruning of
// stale networks a crashed run left behind. Split from
// `vaultIsolation.ts`, which re-exports the public names.

import {
	type DockerRunner,
	firstLines,
	ISOLATION_LABEL,
	NETWORK_PREFIX,
	OWNER_SUFFIX,
	PRUNE_GRACE_MS,
	SESSION_LABEL,
} from "./vaultIsolation-host.ts";

// ── Networks ─────────────────────────────────────────────────────────────────

export interface IsolationNetwork {
	gateway: string;
	name: string;
	subnet: string;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4ToInt(address: string): number | null {
	const match = IPV4.exec(address);
	if (!match) {
		return null;
	}
	let value = 0;
	for (const part of match.slice(1)) {
		const octet = Number(part);
		if (octet > 255) {
			return null;
		}
		value = value * 256 + octet;
	}
	return value;
}

export function ipv4InCidr(address: string, cidr: string): boolean {
	const [base, bitsText] = cidr.split("/");
	const ip = ipv4ToInt(address);
	const network = ipv4ToInt(base ?? "");
	const bits = Number(bitsText);
	if (ip === null || network === null || !Number.isInteger(bits)) {
		return false;
	}
	if (bits <= 0) {
		return true;
	}
	if (bits > 32) {
		return false;
	}
	const size = 2 ** (32 - bits);
	return Math.floor(ip / size) === Math.floor(network / size);
}

/** Parses `docker network inspect NAME --format '{{json .IPAM.Config}}'`. */
export function parseNetworkConfig(
	name: string,
	stdout: string
): IsolationNetwork {
	let entries: unknown;
	try {
		entries = JSON.parse(stdout.trim() || "null");
	} catch {
		throw new Error(`docker network inspect ${name}: unexpected output`);
	}
	if (Array.isArray(entries)) {
		for (const entry of entries) {
			if (typeof entry !== "object" || entry === null) {
				continue;
			}
			const gateway = Reflect.get(entry, "Gateway");
			const subnet = Reflect.get(entry, "Subnet");
			if (
				typeof gateway === "string" &&
				typeof subnet === "string" &&
				ipv4ToInt(gateway) !== null &&
				ipv4InCidr(gateway, subnet)
			) {
				return { name, gateway, subnet };
			}
		}
	}
	throw new Error(`docker network inspect ${name}: no IPv4 gateway`);
}

export async function createIsolationNetwork(
	docker: DockerRunner,
	id: string
): Promise<IsolationNetwork> {
	const name = `${NETWORK_PREFIX}${id}`;
	const created = await docker([
		"network",
		"create",
		"--driver",
		"bridge",
		"--label",
		`${ISOLATION_LABEL}=1`,
		"--label",
		`${SESSION_LABEL}=${id}`,
		name,
	]);
	if (created.exitCode !== 0) {
		throw new Error(
			`docker network create ${name} failed: ${firstLines(created.stderr, 3)}`
		);
	}
	try {
		const inspected = await docker([
			"network",
			"inspect",
			name,
			"--format",
			"{{json .IPAM.Config}}",
		]);
		if (inspected.exitCode !== 0) {
			throw new Error(
				`docker network inspect ${name} failed: ${firstLines(inspected.stderr, 3)}`
			);
		}
		return parseNetworkConfig(name, inspected.stdout);
	} catch (error) {
		await docker(["network", "rm", name]).catch(() => undefined);
		throw error;
	}
}

export type StaleNetwork = "empty" | "owner-only" | null;

/** Classifies a labeled isolation network created before `cutoffMs` from
 *  `docker network inspect --format '{{json .}}'`: `empty` (no containers),
 *  `owner-only` (only its network-owner container, whose command container
 *  may be gone), or `null` (keep). The command container joins through the
 *  owner's namespace, so it never shows up in the network's container list. */
export function classifyStaleNetwork(
	stdout: string,
	cutoffMs: number
): StaleNetwork {
	let info: unknown;
	try {
		info = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (typeof info !== "object" || info === null) {
		return null;
	}
	const created = Reflect.get(info, "Created");
	const name = Reflect.get(info, "Name");
	if (typeof created !== "string") {
		return null;
	}
	// Docker prints nanoseconds; keep milliseconds for Date.parse.
	const createdMs = Date.parse(created.replace(/(\.\d{3})\d+/, "$1"));
	if (!(Number.isFinite(createdMs) && createdMs < cutoffMs)) {
		return null;
	}
	const containers = Reflect.get(info, "Containers");
	const entries =
		typeof containers === "object" && containers !== null
			? Object.values(containers)
			: [];
	if (entries.length === 0) {
		return "empty";
	}
	const ownerName = `${typeof name === "string" ? name : ""}${OWNER_SUFFIX}`;
	const onlyOwner = entries.every(
		(entry) =>
			typeof entry === "object" &&
			entry !== null &&
			Reflect.get(entry, "Name") === ownerName
	);
	return onlyOwner ? "owner-only" : null;
}

/** True for a labeled isolation network with no containers, created before
 *  `cutoffMs`. */
export function isStaleNetwork(stdout: string, cutoffMs: number): boolean {
	return classifyStaleNetwork(stdout, cutoffMs) === "empty";
}

/** Best-effort removal of isolation networks (and orphaned network owners)
 *  leaked by crashed runs. The grace period keeps a concurrent run's fresh
 *  network alive until its command container starts. */
export async function pruneStaleNetworks(
	docker: DockerRunner,
	nowMs: number
): Promise<void> {
	const listed = await docker([
		"network",
		"ls",
		"--filter",
		`label=${ISOLATION_LABEL}=1`,
		"--format",
		"{{.Name}}",
	]);
	if (listed.exitCode !== 0) {
		return;
	}
	for (const name of listed.stdout.split(/\s+/)) {
		if (!name.startsWith(NETWORK_PREFIX)) {
			continue;
		}
		const inspected = await docker([
			"network",
			"inspect",
			name,
			"--format",
			"{{json .}}",
		]);
		if (inspected.exitCode !== 0) {
			continue;
		}
		const stale = classifyStaleNetwork(
			inspected.stdout,
			nowMs - PRUNE_GRACE_MS
		);
		if (stale === "owner-only") {
			// The command container shares the network's name; when it is gone
			// the owner only holds a dead run's namespace.
			const command = await docker(["container", "inspect", name]);
			if (command.exitCode === 0) {
				continue;
			}
			await docker(["rm", "-f", `${name}${OWNER_SUFFIX}`]);
		}
		if (stale !== null) {
			await docker(["network", "rm", name]);
		}
	}
}
