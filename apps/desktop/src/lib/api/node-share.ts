import type { RyuNodeShareOrigin } from "@ryu/app-host/app-bridge";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import type { MeshStatus } from "@/src/lib/api/mesh.ts";
import { fetchMeshStatus } from "@/src/lib/api/mesh.ts";
import type { Node } from "@/src/store/useNodeStore.ts";

/** A node URL is shareable only when it is a bare HTTP(S) origin. */
function originFromUrl(raw: string): string | null {
	try {
		const parsed = new URL(raw.trim());
		if (
			(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
			parsed.username ||
			parsed.password ||
			parsed.search ||
			parsed.hash ||
			(parsed.pathname !== "" && parsed.pathname !== "/") ||
			!parsed.hostname ||
			isLocalHost(parsed.hostname)
		) {
			return null;
		}
		return parsed.origin;
	} catch {
		return null;
	}
}

function isLocalHost(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "0.0.0.0" ||
		host === "::" ||
		host === "::1"
	) {
		return true;
	}
	const octets = host.split(".");
	return (
		octets.length === 4 &&
		octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet)) &&
		octets[0] === "127" &&
		octets.every((octet) => Number(octet) <= 255)
	);
}

function meshOrigin(hostname: string, nodeUrl: string): string | null {
	const host = hostname.trim().replace(/\.$/, "");
	if (!host || /[/?#@\s]/.test(host) || isLocalHost(host)) {
		return null;
	}
	try {
		const active = new URL(nodeUrl);
		const port = active.port || (active.protocol === "https:" ? "443" : "80");
		const formattedHost = host.includes(":") ? `[${host}]` : host;
		return originFromUrl(`http://${formattedHost}:${port}`);
	} catch {
		return null;
	}
}

/**
 * Project the active node and, when Core confirms a reachable mesh, one or more
 * mesh origins into link-safe values. This function is pure so it can be tested
 * without reading credentials or making a network request.
 */
export function shareOriginsForNode(
	node: Pick<Node, "url">,
	mesh: MeshStatus | null
): RyuNodeShareOrigin[] {
	const origins: RyuNodeShareOrigin[] = [];
	const seen = new Set<string>();
	const add = (origin: string | null, source: RyuNodeShareOrigin["source"]) => {
		if (!origin || seen.has(origin)) {
			return;
		}
		seen.add(origin);
		origins.push({ origin, source, reachable: true });
	};

	add(originFromUrl(node.url), "active");
	if (!(mesh?.enabled && mesh.reachable)) {
		return origins;
	}
	add(meshOrigin(mesh.magicDnsName ?? "", node.url), "mesh");
	for (const ip of mesh.tailscaleIps ?? []) {
		add(meshOrigin(ip, node.url), "mesh");
	}
	return origins;
}

/** Resolve the current node's secret-free share origins at call time. */
export async function resolveNodeShareOrigins(
	node: Pick<Node, "url" | "token" | "userJwt">
): Promise<RyuNodeShareOrigin[]> {
	let mesh: MeshStatus | null = null;
	try {
		const target: ApiTarget = toTarget(node);
		mesh = await fetchMeshStatus(target);
	} catch {
		// An older/unreachable Core simply contributes no mesh origin; a public
		// active-node origin remains valid when the node record already has one.
	}
	return shareOriginsForNode(node, mesh);
}
