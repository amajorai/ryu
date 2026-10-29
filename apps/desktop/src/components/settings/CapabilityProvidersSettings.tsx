// apps/desktop/src/components/settings/CapabilityProvidersSettings.tsx
//
// The non-chat half of Settings > Providers: which provider serves image
// generation, voice recognition, audio, video and generated music/sound
// effects, plus where embeddings
// and reranking come from.
//
// # Why this is read-only
//
// Routing is EDITED in the node's Gateway settings, and this page deliberately
// does not offer a second editor. `PUT /v1/config { routing }` assigns the
// routing section WHOLESALE (`apps/gateway/src/api/config.rs`), so any save
// path that does not round-trip every field it did not touch silently erases
// the rest — that is the documented A7 defect behind
// `routingViewIncludesModalityMap`. One save path, in one place, is the whole
// mitigation; a second one here would be a new way to lose a hand-written
// `[routing.modality_map]`.
//
// So this surface answers "what serves this capability?" — which previously had
// no answer outside a node dialog most people never open — and hands editing
// back to the card that already owns it.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useEffect, useMemo, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	fetchGatewayConfig,
	type GatewayConfig,
	type Modality,
	routingViewIncludesModalityMap,
} from "@/src/lib/api/gateway.ts";
import { getFalApiKey, getReplicateApiKey } from "@/src/lib/api/preferences.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/**
 * The capabilities this section covers, in the order the settings page reads
 * top-to-bottom. Chat is deliberately ABSENT: it is the section above this one,
 * and it is routed by the model map rather than the modality map.
 */
const ROUTED_CAPABILITIES: {
	blurb: string;
	label: string;
	modality: Exclude<Modality, "chat">;
}[] = [
	{
		modality: "image",
		label: "Image generation",
		blurb: "Serves POST /v1/images/generations.",
	},
	{
		modality: "stt",
		label: "Voice Recognition",
		blurb: "Serves POST /v1/audio/transcriptions — dictation and voice mode.",
	},
	{
		modality: "tts",
		label: "Audio",
		blurb: "Serves POST /v1/audio/speech — read-aloud and voice replies.",
	},
	{
		modality: "video",
		label: "Video generation",
		blurb:
			"Serves POST /v1/videos/generations. Job-based: the client polls for the result.",
	},
	{
		modality: "audio",
		label: "Music and sound effects",
		blurb:
			"Serves POST /v1/audio/generations. Job-based like video; speech stays on Audio.",
	},
];

export function CapabilityProvidersSettings() {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const target = useMemo(() => toTarget(node), [node]);
	const openGateway = useGatewayDialog((s) => s.openGateway);

	const [config, setConfig] = useState<GatewayConfig | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	// Whether the two cloud media providers hold a key. Presence alone activates
	// them in the gateway, so this IS their configured state — there is no
	// separate enable switch to read.
	const [mediaKeys, setMediaKeys] = useState<{
		fal: boolean;
		replicate: boolean;
	} | null>(null);

	useEffect(() => {
		let cancelled = false;
		Promise.all([getReplicateApiKey(target), getFalApiKey(target)])
			.then(([replicate, fal]) => {
				if (!cancelled) {
					setMediaKeys({
						replicate: replicate.length > 0,
						fal: fal.length > 0,
					});
				}
			})
			.catch(() => {
				// Unreadable preferences are not worth an error state here — the rows
				// below simply omit the key hint.
				if (!cancelled) {
					setMediaKeys(null);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [target]);

	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		fetchGatewayConfig(target, controller.signal)
			.then((cfg) => {
				setConfig(cfg);
				setLoading(false);
			})
			.catch((e) => {
				if (controller.signal.aborted) {
					return;
				}
				// A gateway that is simply not running is the ordinary case on a
				// local-only node, not an error worth a red panel.
				setError(
					e instanceof Error ? e.message : "The gateway did not answer."
				);
				setLoading(false);
			});
		return () => controller.abort();
	}, [target]);

	// Three-state, exactly like `SmartRoutingCard`: null until the fetch settles,
	// so a healthy node does not flash the too-old-gateway warning while loading.
	const served =
		config === null ? null : routingViewIncludesModalityMap(config.routing);
	const modalityMap = config?.routing.modality_map ?? {};
	const defaultProvider = config?.routing.default_provider ?? "";

	return (
		<>
			<SettingsSection
				caption="Each capability can be served by a different provider. Chat is routed by the model map; everything below is routed by the gateway's modality map, and falls back to the default provider when it has no entry of its own."
				title="Other capabilities"
			>
				{loading ? (
					<SkeletonRows label="Reading routing…" spacing="comfortable" />
				) : null}

				{!loading && error ? (
					<p className="text-muted-foreground text-sm">
						{tl(
							"This node's gateway did not answer, so its per-capability routing cannot be shown. Image, speech and video calls fall back to whatever the gateway itself is configured with. ({error})",
							{ error }
						)}
					</p>
				) : null}

				{!(loading || error) && served === false ? (
					<p className="text-sm text-status-warning">
						This gateway is too old to report its modality map, so what serves
						each capability cannot be shown — or edited from the app without
						dropping a hand-written{" "}
						<span className="font-mono">[routing.modality_map]</span>. Update
						the gateway.
					</p>
				) : null}

				{!(loading || error) && served ? (
					<SettingsGroup>
						{ROUTED_CAPABILITIES.map(({ modality, label, blurb }) => {
							const mapping = modalityMap[modality];
							return (
								<SettingsItem
									actions={
										<span className="shrink-0 text-muted-foreground text-sm">
											{mapping
												? `${mapping.provider}${mapping.model ? ` · ${mapping.model}` : ""}`
												: defaultProvider
													? tl("{defaultProvider} (default)", {
															defaultProvider,
														})
													: "Unrouted"}
										</span>
									}
									description={blurb}
									key={modality}
									title={label}
								/>
							);
						})}
					</SettingsGroup>
				) : null}

				{!(loading || error) && served ? (
					<div className="pt-1">
						<Button
							onClick={() => openGateway("routing")}
							size="sm"
							variant="ghost"
						>
							Edit capability routing
						</Button>
						<p className="pt-1.5 text-muted-foreground text-xs">
							Routing is edited in one place on purpose. Saving the routing
							section replaces it wholesale, so a second editor here would be a
							second way to erase the parts it did not touch.
						</p>
					</div>
				) : null}
			</SettingsSection>

			<SettingsSection
				caption="Cloud image, video and audio generation. A key alone activates the provider — there is no separate switch — so these two rows ARE the configured state of the media capabilities above."
				title="Media provider keys"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<span className="shrink-0 text-muted-foreground text-sm">
								{mediaKeys === null
									? "—"
									: mediaKeys.replicate
										? "Key set"
										: "No key"}
							</span>
						}
						description="Image and video generation via Replicate."
						title="Replicate"
					/>
					<SettingsItem
						actions={
							<span className="shrink-0 text-muted-foreground text-sm">
								{mediaKeys === null
									? "—"
									: mediaKeys.fal
										? "Key set"
										: "No key"}
							</span>
						}
						description="Image, video and audio generation via fal.ai."
						title="Fal"
					/>
				</SettingsGroup>
				<div className="pt-1">
					<Button onClick={() => openGateway("keys")} size="sm" variant="ghost">
						Manage media keys
					</Button>
					<p className="pt-1.5 text-muted-foreground text-xs">
						Without a key, a capability routed to that provider fails at call
						time rather than at save time — which is why the state is shown here
						next to the routing it explains.
					</p>
				</div>
			</SettingsSection>

			<SettingsSection
				caption="Retrieval runs on this node. Neither is a gateway modality yet, so neither can be pointed at a cloud provider from here."
				title="Embeddings and reranking"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<span className="shrink-0 text-muted-foreground text-sm">
								On this node
							</span>
						}
						description="Turns text into vectors for semantic search over memory, Spaces and tool selection."
						title="Embeddings"
					/>
					<SettingsItem
						actions={
							<span className="shrink-0 text-muted-foreground text-sm">
								On this node
							</span>
						}
						description="Re-scores retrieved passages before they reach the model."
						title="Reranking"
					/>
				</SettingsGroup>
				<p className="pt-1.5 text-muted-foreground text-xs">
					Changing the embedding model invalidates every vector already stored —
					existing memories and documents would stop matching until they are
					re-embedded. A cloud embedding provider therefore needs a re-embed
					path, not just a dropdown, which is why there is no selector here yet.
				</p>
			</SettingsSection>
		</>
	);
}
