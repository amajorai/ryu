import { BrainIcon } from "@hugeicons/core-free-icons";
import { useLiteralMessages } from "@ryu/i18n/react";
import { sileo } from "sileo";
import {
	type CapabilityLayerEntry,
	useCapabilityLayers,
} from "@/src/hooks/useCapabilityLayers.ts";
import {
	type CapabilityProvider,
	canServe,
	describeBindingFailure,
} from "@/src/lib/api/capability-layers.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { TUNNEL_CAPABILITY } from "@/src/lib/api/mesh.ts";
import { enableApp } from "@/src/lib/api/plugins.ts";
import { type LayerOption, NodeLayerMenu } from "./NodeLayerMenu.tsx";
import { PanelSection } from "./NodePanelNav.tsx";
import {
	capabilityLabel,
	layerCaption,
	orderCapabilityLayers,
	providerDetail,
} from "./NodeSelector-capability-layers.tsx";
import { TunnelLayer, useTunnel } from "./NodeSelector-tunnel.tsx";
import { WebSearchAccessMenu } from "./WebSearchAccessMenu.tsx";

/**
 * The "Toolkits" block in the node dropdown: every SELECTABLE capability on the
 * node. Named "Toolkits" in the UI because that is what a user is picking - the
 * set of tools behind web search or browsing - while "layer"/"capability" stays
 * the internal vocabulary in Core and the manifests.
 *
 * node with the app currently serving it, and a swap to any other enabled
 * provider. This is the client face of Core's binding ladder
 * (override > sole provider > declared default > lowest id).
 *
 * Deliberately unlike the Engines block:
 *   - no `available` list — the read model already reports only ENABLED apps,
 *     and installing a provider is the Store's job, not the dropdown's;
 *   - no `running` dot — a binding is a preference with no process behind it,
 *     and a grey dot on something that cannot run reads as broken;
 *   - non-selectable capabilities are absent entirely (the hook drops them):
 *     Core will not auto-pick between them, so a picker would be a lie.
 */
export function LayersSection({
	target,
	enabled,
}: {
	enabled: boolean;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const {
		layers,
		refresh,
		select,
		tunnel: tunnelPlugins,
	} = useCapabilityLayers(target, enabled);
	const rows = orderCapabilityLayers(layers);
	// Hoisted out of `TunnelLayer` so the block knows whether it has ANY row
	// before drawing its header — a Core with no mesh plane and no capability
	// providers must render nothing, not a "Toolkits" heading over emptiness.
	const tunnel = useTunnel(target);

	// Enabling a candidate for a toolkit that currently has none. Distinct from
	// `pick`: there is nothing to swap TO yet, so the action is a lifecycle change
	// on the plugin, after which Core's ladder binds it automatically (sole
	// provider, or the declared default).
	const enableProvider = async (
		provider: CapabilityProvider,
		label: string
	) => {
		try {
			await enableApp(target, provider.id);
			await refresh();
			sileo.success({ title: `${label} → ${provider.name}` });
		} catch (e) {
			sileo.error({
				title:
					e instanceof Error
						? e.message
						: tl("Couldn't enable {name}", { name: provider.name }),
			});
		}
	};

	const pick = async (
		entry: CapabilityLayerEntry,
		provider: CapabilityProvider,
		label: string
	) => {
		// Re-clicking the row that is ALREADY serving the capability is a no-op, the
		// same way re-picking Chat is. Writing here would turn
		// Core's auto-pick into an explicit pin with no visible change and no way
		// back — the dropdown has no "Auto" row to undo it with.
		if (provider.id === entry.bound) {
			return;
		}
		try {
			await select(entry.capability, provider.id);
			sileo.success({ title: `${label} → ${provider.name}` });
		} catch (e) {
			// Core's 409 names the plugin that would break and the binding_error
			// code; surface both rather than a bare "request failed".
			sileo.error({ title: describeBindingFailure(e, provider.name) });
		}
	};

	// The Tunnel keeps the block alive on its own: it is a NODE capability, not a
	// plugin contribution, so it is there on an install with no capability
	// providers at all. Only a Core without the mesh plane (404 → no tunnel data)
	// AND no capabilities collapses the block entirely.
	const hasTunnel = tunnel.data?.status != null;
	if (!enabled || (rows.length === 0 && !hasTunnel)) {
		return null;
	}

	return (
		<PanelSection>
			<TunnelLayer
				enablePlugin={async (provider) => {
					await enableApp(target, provider.id);
				}}
				plugins={tunnelPlugins}
				query={tunnel}
				selectPlugin={(providerId) => select(TUNNEL_CAPABILITY, providerId)}
				target={target}
			/>
			{rows.map(({ entry, icon, label }) => (
				<NodeLayerMenu
					// Candidates that exist but are not enabled. Load-bearing for
					// `web.search`, whose five providers all ship opt-in: without this
					// the toolkit rendered as "No provider bound" with an empty menu and
					// no hint that anything could serve it.
					available={entry.available.map(
						(provider): LayerOption => ({
							name: provider.id,
							label: provider.name,
							active: false,
							detail: provider.isDefault
								? "default · not enabled"
								: "not enabled",
							select: () => enableProvider(provider, label),
						})
					)}
					caption={layerCaption(entry)}
					currentLabel={entry.boundProvider?.name ?? "None"}
					icon={icon}
					installed={entry.providers.map(
						(provider): LayerOption => ({
							name: provider.id,
							label: provider.name,
							active: provider.id === entry.bound,
							detail: providerDetail(provider, entry.providers),
							// A provider that serves NOTHING is shown but NOT selectable.
							// Selecting one resolves the capability to it and then finds
							// nothing to serve, so every tool in the layer disappears —
							// silently, with no error anywhere. Better to say why it
							// cannot be picked than to let the layer go dark.
							//
							// "Serves nothing" is `canServe`, not `!servesVerbs`: verbs are
							// one of two serving surfaces, and gating on them alone marked
							// every route-backed provider dead. `document.parse` is served
							// entirely by route, so all five of its parsers — including the
							// bound default — rendered disabled with "serves no verbs yet"
							// while parsing worked fine, and the layer could not be swapped
							// from here at all.
							disabled: !canServe(provider),
							// Not "serves no verbs yet": verbs are one of two ways to
							// serve, so naming only that one sent a reader looking for a
							// missing verb table on a provider whose real problem is that
							// it declares no serving surface of either kind.
							disabledReason: canServe(provider)
								? null
								: "declares no verbs or route",
							select: () => pick(entry, provider, label),
						})
					)}
					key={entry.capability}
					label={label}
					selectionMode="swap"
					// No version badge. The only version available here is the
					// CAPABILITY CONTRACT version from `provides[].version`, which every
					// manifest in the repo declares as "1.0.0" — so every row would badge
					// an identical, information-free "v1.0.0" in the same slot where the
					// engine rows above show a real build. The provider app's own version
					// would be meaningful, but the read model does not carry it.
					version={null}
				>
					{entry.capability === "web.search" ? (
						<WebSearchAccessMenu enabled={enabled} target={target} />
					) : null}
				</NodeLayerMenu>
			))}
		</PanelSection>
	);
}

/** Typed-decision providers share the binding contract but stay out of Toolkits. */
export function DecisionModelsSection({
	target,
	enabled,
}: {
	enabled: boolean;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const { decisionModels, refresh, select } = useCapabilityLayers(
		target,
		enabled
	);
	if (!enabled || decisionModels.length === 0) {
		return null;
	}

	const enableProvider = async (
		entry: CapabilityLayerEntry,
		provider: CapabilityProvider,
		label: string
	) => {
		try {
			await enableApp(target, provider.id);
			try {
				// Enabling an available provider is an explicit selection, including
				// when Core had no unique provider bound before this choice.
				await select(entry.capability, provider.id);
			} finally {
				await refresh();
			}
			sileo.success({ title: `${label} → ${provider.name}` });
		} catch (error) {
			sileo.error({
				title:
					error instanceof Error
						? error.message
						: tl("Couldn't enable {name}", { name: provider.name }),
			});
		}
	};

	const pickProvider = async (
		entry: CapabilityLayerEntry,
		provider: CapabilityProvider,
		label: string
	) => {
		if (provider.id === entry.bound) {
			return;
		}
		try {
			await select(entry.capability, provider.id);
			sileo.success({ title: `${label} → ${provider.name}` });
		} catch (error) {
			sileo.error({ title: describeBindingFailure(error, provider.name) });
		}
	};

	return (
		<PanelSection title="Decision Models">
			{decisionModels.map((entry) => {
				const label = capabilityLabel(entry, "Typed Decisions");
				return (
					<NodeLayerMenu
						available={entry.available.map(
							(provider): LayerOption => ({
								name: provider.id,
								label: provider.name,
								active: false,
								detail: provider.isDefault
									? "default · not enabled"
									: "not enabled",
								select: () => enableProvider(entry, provider, label),
							})
						)}
						caption={layerCaption(entry)}
						currentLabel={entry.boundProvider?.name ?? "None"}
						icon={BrainIcon}
						installed={entry.providers.map(
							(provider): LayerOption => ({
								name: provider.id,
								label: provider.name,
								active: provider.id === entry.bound,
								detail: providerDetail(provider, entry.providers),
								disabled: !canServe(provider),
								disabledReason: canServe(provider)
									? null
									: "declares no verbs or route",
								select: () => pickProvider(entry, provider, label),
							})
						)}
						key={entry.capability}
						label={label}
						selectionMode="swap"
						version={null}
					/>
				);
			})}
		</PanelSection>
	);
}
