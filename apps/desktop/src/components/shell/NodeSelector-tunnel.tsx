import {
	Settings01Icon,
	WifiConnected01Icon,
} from "@hugeicons/core-free-icons";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useQuery } from "@tanstack/react-query";
import { sileo } from "sileo";
import type { CapabilityLayerEntry } from "@/src/hooks/useCapabilityLayers.ts";
import {
	type CapabilityProvider,
	describeBindingFailure,
} from "@/src/lib/api/capability-layers.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchMeshStatus,
	isPublicTunnelBackend,
	MESH_BACKEND_CLOUDFLARED,
	MESH_BACKEND_HEADSCALE,
	MESH_BACKEND_OPENTUNNEL,
	MESH_BACKEND_PLUGIN,
	MESH_BACKEND_PREF,
	MESH_BACKEND_TAILCAT,
	MESH_BACKEND_TAILSCALE,
	MESH_LOGIN_SERVER_PREF,
	type MeshBackend,
	parseMeshBackend,
	setMeshBackend,
	setMeshEnabled,
} from "@/src/lib/api/mesh.ts";
import { getPreference } from "@/src/lib/api/preferences.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import { watchMeshInstall } from "./mesh-install.ts";
import {
	type LayerAction,
	type LayerOption,
	NodeLayerMenu,
} from "./NodeLayerMenu.tsx";

/** Human label for a tunnel backend. */
const TUNNEL_LABEL = {
	[MESH_BACKEND_CLOUDFLARED]: "Cloudflare Quick Tunnel",
	[MESH_BACKEND_HEADSCALE]: "Headscale",
	[MESH_BACKEND_OPENTUNNEL]: "OpenTunnel",
	[MESH_BACKEND_PLUGIN]: "Plugin tunnel",
	[MESH_BACKEND_TAILSCALE]: "Tailscale",
	[MESH_BACKEND_TAILCAT]: "Tailcat",
} satisfies Record<MeshBackend, string>;

/**
 * The **Tunnel** toolkit: which network backend this node uses, and the
 * enable/disable for the network itself.
 *
 * It sits in the Toolkits block because that is what the user is picking — the
 * thing behind "can my nodes reach each other". The built-in backends read the
 * node's own `mesh-backend` pref; plugin tunnel adapters (apps providing the
 * `network.tunnel` capability) are listed beside them, and picking one pins the
 * capability binding and selects the `plugin` backend. Tailcat is the fresh
 * install default because it needs no account or control server. Tailcat is point-to-point:
 * it exposes this Core through a short-lived address and does not provide peer
 * discovery or a persistent tailnet.
 *
 * Turning it on starts the selected backend. Core downloads the official
 * `tailscale`/`tailscaled` pair for Tailscale/Headscale or the Tailcat CLI for
 * Tailcat when this node has none. `installing` on the enable response is the
 * selected-client signal;
 * {@link watchMeshInstall} waits it out.
 *
 * A backend swap is a SETTING, not a migration: a node already enrolled with
 * Tailscale/Headscale stays enrolled until it re-runs `tailscale up` with an auth
 * key for the new one. Tailcat is restarted with a fresh address, and the toast
 * says as much rather than implying a persistent tailnet move.
 */
export function useTunnel(target: ApiTarget) {
	return useQuery({
		queryKey: ["node-tunnel", target.url],
		queryFn: async () => {
			// `/api/mesh/status` answers 200 with `enabled:false` on a mesh-off node
			// and 404s on a Core with no mesh plane — only the 404 hides this row.
			const status = await fetchMeshStatus(target);
			const [backendPref, loginServer] = await Promise.all([
				getPreference(target, MESH_BACKEND_PREF).catch(() => null),
				getPreference(target, MESH_LOGIN_SERVER_PREF).catch(() => null),
			]);
			return {
				status,
				backend: parseMeshBackend(backendPref, loginServer),
				loginServer: loginServer?.trim() ?? "",
			};
		},
		refetchInterval: 15_000,
		retry: false,
	});
}

type TunnelQuery = ReturnType<typeof useTunnel>;

export function TunnelLayer({
	target,
	query,
	plugins,
	selectPlugin,
	enablePlugin,
}: {
	enablePlugin: (provider: CapabilityProvider) => Promise<void>;
	plugins: CapabilityLayerEntry | null;
	query: TunnelQuery;
	selectPlugin: (providerId: string) => Promise<void>;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const openGateway = useGatewayDialog((s) => s.openGateway);

	const status = query.data?.status ?? null;
	const backend = query.data?.backend ?? MESH_BACKEND_TAILCAT;
	const pluginName =
		plugins?.boundProvider?.name ??
		status?.tunnelProvider?.name ??
		TUNNEL_LABEL[MESH_BACKEND_PLUGIN];
	const backendLabel = (value: MeshBackend) =>
		value === MESH_BACKEND_PLUGIN ? pluginName : TUNNEL_LABEL[value];
	const loginServer = query.data?.loginServer ?? "";
	const enabled = status?.enabled ?? false;
	const needsControlServer =
		backend === MESH_BACKEND_HEADSCALE && loginServer === "";

	const toggleMesh = async (next: boolean) => {
		try {
			const result = await setMeshEnabled(target, next);
			await query.refetch();
			if (next && result.installing) {
				await watchMeshInstall(target, backend);
				await query.refetch();
				return;
			}
			if (next && result.startError) {
				sileo.warning({
					title: result.canInstall
						? "Tunnel enabled, but it did not start"
						: backend === MESH_BACKEND_TAILCAT
							? "Tailcat could not be installed automatically"
							: isPublicTunnelBackend(backend)
								? tl("{backend} could not start", {
										backend: backendLabel(backend),
									})
								: "Mesh client could not be installed automatically",
					description: result.startError,
				});
				return;
			}
			sileo.success({
				title: next ? "Tunnel on" : "Tunnel off",
				description: next
					? backend === MESH_BACKEND_TAILCAT
						? "This computer now has a short-lived Tailcat address to share."
						: backend === MESH_BACKEND_CLOUDFLARED
							? "A temporary public URL is ready. Protected Core routes still require RYU_TOKEN."
							: isPublicTunnelBackend(backend)
								? "A public URL is being prepared. Protected Core routes still require RYU_TOKEN."
								: "This computer joins the selected private network."
					: "This computer has left the private network.",
			});
		} catch (e) {
			sileo.error({
				title:
					e instanceof Error ? e.message : "Couldn't change the tunnel state",
			});
		}
	};

	const pickBackend = async (next: MeshBackend, restart = false) => {
		if (next === backend && !restart) {
			return;
		}
		let result: Awaited<ReturnType<typeof setMeshBackend>>;
		try {
			result = await setMeshBackend(target, next, enabled);
		} catch (error) {
			sileo.error({
				title:
					error instanceof Error
						? error.message
						: "Couldn't switch the network backend",
			});
			return;
		}
		await query.refetch();
		if (enabled && result.installing) {
			await watchMeshInstall(target, next);
			await query.refetch();
			return;
		}
		if (enabled && result.startError) {
			if (next === MESH_BACKEND_HEADSCALE && loginServer === "") {
				sileo.warning({
					title: "Tunnel set to Headscale",
					description: "Add your control server URL to finish setting it up.",
					button: {
						title: "Add URL",
						onClick: () => openGateway("network"),
					},
				});
			} else {
				sileo.warning({
					title: tl("{backend} selected, but it did not start", {
						backend: backendLabel(next),
					}),
					description: result.startError,
				});
			}
			return;
		}
		if (next === MESH_BACKEND_HEADSCALE && loginServer === "") {
			// Core REFUSES to enrol against Headscale with no control server rather
			// than silently falling back to Tailscale's SaaS, so say so here instead
			// of letting the node fail at start with the same sentence.
			sileo.warning({
				title: "Tunnel set to Headscale",
				description: "Add your control server URL to finish setting it up.",
				button: {
					title: "Add URL",
					onClick: () => openGateway("network"),
				},
			});
			return;
		}
		sileo.success({
			title: `Network → ${backendLabel(next)}`,
			description: enabled
				? next === MESH_BACKEND_TAILCAT
					? "The listener was restarted with a new short-lived address."
					: next === MESH_BACKEND_CLOUDFLARED
						? "A temporary public URL is active. Anyone with the URL can reach Core's public routes."
						: isPublicTunnelBackend(next)
							? "A public URL is being prepared. Anyone with the URL can reach Core's public routes."
							: "The selected network backend was restarted. An already-enrolled Tailscale or Headscale computer keeps its current tailnet until it re-enrols with a new auth key."
				: undefined,
		});
	};

	// A plugin tunnel row pins the `network.tunnel` binding, then selects the
	// `plugin` backend. Re-posting the backend while it is already on makes Core
	// stop the previously started provider and start the newly bound one.
	const pickPlugin = async (provider: CapabilityProvider) => {
		const alreadyActive =
			backend === MESH_BACKEND_PLUGIN && plugins?.bound === provider.id;
		if (alreadyActive) {
			return;
		}
		try {
			if (plugins?.bound !== provider.id) {
				await selectPlugin(provider.id);
			}
		} catch (error) {
			sileo.error({ title: describeBindingFailure(error, provider.name) });
			return;
		}
		await pickBackend(MESH_BACKEND_PLUGIN, backend === MESH_BACKEND_PLUGIN);
	};

	// Enabling a disabled tunnel app from this menu is a selection, not just a
	// lifecycle change: pin it and switch the VPN layer to it in the same click.
	const enableAndPickPlugin = async (provider: CapabilityProvider) => {
		try {
			await enablePlugin(provider);
			await selectPlugin(provider.id);
		} catch (error) {
			sileo.error({ title: describeBindingFailure(error, provider.name) });
			return;
		}
		await pickBackend(MESH_BACKEND_PLUGIN, backend === MESH_BACKEND_PLUGIN);
	};

	// No mesh plane on this Core (an older binary) — no row, rather than a fake one.
	if (status === null) {
		return null;
	}

	const actions: LayerAction[] = [
		{
			id: enabled ? "disable" : "enable",
			label: enabled
				? "Turn off"
				: isPublicTunnelBackend(backend)
					? "Start public tunnel"
					: "Turn on",
			busyLabel: enabled
				? "Turning off…"
				: isPublicTunnelBackend(backend)
					? "Starting public tunnel…"
					: "Connecting…",
			// No download icon on "Turn on": most nodes already have the client, and
			// promising a download on a machine that just starts a daemon is the kind
			// of small lie that makes a UI untrustworthy.
			run: () => toggleMesh(!enabled),
			tone: enabled ? "destructive" : "default",
		},
	];
	if (needsControlServer) {
		actions.push({
			id: "control-server",
			label: "Set control server URL…",
			icon: Settings01Icon,
			run: () => openGateway("network"),
		});
	}
	const publicUrl = status.publicUrl;
	if (isPublicTunnelBackend(backend) && publicUrl) {
		actions.push({
			id: "copy-public-url",
			label: "Copy public URL",
			run: async () => {
				try {
					await navigator.clipboard.writeText(publicUrl);
					sileo.success({ title: "Public URL copied" });
				} catch {
					sileo.error({ title: "Couldn't copy the public URL" });
				}
			},
		});
	}

	const caption = (() => {
		if (needsControlServer) {
			return "Needs a control server URL";
		}
		if (!enabled) {
			if (backend === MESH_BACKEND_CLOUDFLARED) {
				return "Off · public temporary URL";
			}
			if (backend === MESH_BACKEND_OPENTUNNEL) {
				return "Off · public stable URL";
			}
			if (backend === MESH_BACKEND_PLUGIN) {
				return `Off · ${pluginName}`;
			}
			if (backend === MESH_BACKEND_HEADSCALE) {
				return `Off · ${loginServer}`;
			}
			return backend === MESH_BACKEND_TAILCAT
				? "Off · Tailcat"
				: "Off · Tailscale SaaS";
		}
		if (status.backendError && !status.reachable) {
			return status.backendError;
		}
		if (status.reachable) {
			if (backend === MESH_BACKEND_CLOUDFLARED) {
				return status.cloudflaredUrl
					? "Cloudflare URL ready"
					: "Cloudflare connected";
			}
			if (
				backend === MESH_BACKEND_OPENTUNNEL ||
				backend === MESH_BACKEND_PLUGIN
			) {
				return status.publicUrl ? "Public URL ready" : "Connected";
			}
			if (backend === MESH_BACKEND_TAILCAT) {
				return status.tailcatAddress
					? "Tailcat address ready"
					: "Tailcat connected";
			}
			return status.magicDnsName
				? `Connected as ${status.magicDnsName}`
				: "Connected";
		}
		if (status.backendState === "Provisioning") {
			// First OpenTunnel start waits on certificate issuance (minutes).
			return "Creating tunnel certificate…";
		}
		return "Connecting…";
	})();

	const pluginRows = (plugins?.providers ?? []).map(
		(provider): LayerOption => ({
			name: `plugin:${provider.id}`,
			label: provider.name,
			active: backend === MESH_BACKEND_PLUGIN && plugins?.bound === provider.id,
			detail: "plugin · public URL",
			select: () => pickPlugin(provider),
		})
	);
	const availablePlugins = (plugins?.available ?? []).map(
		(provider): LayerOption => ({
			name: `plugin:${provider.id}`,
			label: provider.name,
			active: false,
			detail: "plugin · not enabled",
			select: () => enableAndPickPlugin(provider),
		})
	);

	return (
		<NodeLayerMenu
			actions={actions}
			available={availablePlugins}
			caption={caption}
			currentLabel={backendLabel(backend)}
			icon={WifiConnected01Icon}
			installed={[
				{
					name: MESH_BACKEND_CLOUDFLARED,
					label: TUNNEL_LABEL[MESH_BACKEND_CLOUDFLARED],
					active: backend === MESH_BACKEND_CLOUDFLARED,
					detail: "public · temporary · anyone with URL",
					select: () => pickBackend(MESH_BACKEND_CLOUDFLARED),
				},
				{
					name: MESH_BACKEND_OPENTUNNEL,
					label: TUNNEL_LABEL[MESH_BACKEND_OPENTUNNEL],
					active: backend === MESH_BACKEND_OPENTUNNEL,
					detail: "public · stable URL · macOS & Linux",
					select: () => pickBackend(MESH_BACKEND_OPENTUNNEL),
				},
				{
					name: MESH_BACKEND_HEADSCALE,
					label: TUNNEL_LABEL[MESH_BACKEND_HEADSCALE],
					active: backend === MESH_BACKEND_HEADSCALE,
					// Honest about the one thing that stops it working. The row stays
					// SELECTABLE — picking it is how a user gets the prompt for the URL.
					detail: loginServer === "" ? "needs control server" : "self-hosted",
					select: () => pickBackend(MESH_BACKEND_HEADSCALE),
				},
				{
					name: MESH_BACKEND_TAILSCALE,
					label: TUNNEL_LABEL[MESH_BACKEND_TAILSCALE],
					active: backend === MESH_BACKEND_TAILSCALE,
					detail: "hosted",
					select: () => pickBackend(MESH_BACKEND_TAILSCALE),
				},
				{
					name: MESH_BACKEND_TAILCAT,
					label: TUNNEL_LABEL[MESH_BACKEND_TAILCAT],
					active: backend === MESH_BACKEND_TAILCAT,
					detail: "point-to-point",
					select: () => pickBackend(MESH_BACKEND_TAILCAT),
				},
				...pluginRows,
			]}
			label="VPN"
			// The mesh is a real process, so the dot means connected — not "a backend
			// is selected". A selected-but-off tunnel is honestly down.
			running={enabled ? status.reachable : false}
			selectionMode="swap"
		/>
	);
}
