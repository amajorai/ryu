import {
	Add01Icon,
	Delete01Icon,
	PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { InfoHint } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsGroup,
	SettingsItem,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { Modality, ModalityMapping } from "@/src/lib/api/gateway.ts";
import { MODALITIES } from "@/src/lib/api/gateway.ts";
import {
	MODALITY_COPY,
	ModalityMappingDialog,
	modalityProviderLabel,
} from "./modality-mapping-dialog.tsx";

/** One modality row's second line: what this modality actually does today. */
function ModalityRowDescription({
	mapping,
	defaultProvider,
	configuredProviders,
}: {
	mapping: ModalityMapping | undefined;
	defaultProvider: string;
	configuredProviders: string[];
}) {
	const tl = useLiteralMessages();
	if (!mapping) {
		// An unmapped modality is not an empty setting, it is an explicit
		// fallback — say so. This is also the gateway's own vocabulary:
		// `GET /v1/modalities` reports `"provider": "default"` for exactly this
		// state (apps/gateway/src/api/multimodal.rs).
		//
		// Deliberately NOT "falls back to <default_provider>" full stop. Step 3 of
		// `route_modality` is ordinary MODEL routing, and `RoutingTables::route`
		// tries the exact model map, then the longest user prefix, then the
		// built-in prefix table, and only then `default_provider` — so an unmapped
		// image request for `dall-e-3` can land on a built-in prefix rule and never
		// reach the default at all. Naming the default as the destination would be
		// wrong for exactly the requests most likely to hit this row.
		return (
			<span className="text-muted-foreground">
				{tl(
					"Falls back to the default provider; strictly, to ordinary model routing, which lands on {provider} when no model mapping or built-in prefix rule matches the requested model.",
					{ provider: modalityProviderLabel(defaultProvider) }
				)}
			</span>
		);
	}
	// An EMPTY list means "we do not know yet", not "nothing is registered": the
	// card receives `health?.providers ?? []`, so a health query that is still in
	// flight or that failed is indistinguishable from a gateway with no providers.
	// Flagging on that would put "not configured on this node" under a perfectly
	// good mapping every time the dialog opens — the same false-alarm shape the
	// `served === null` gate exists to prevent one level up.
	const unavailable =
		configuredProviders.length > 0 &&
		!configuredProviders.includes(mapping.provider);
	return (
		<>
			{modalityProviderLabel(mapping.provider)}
			{mapping.model ? ` → ${mapping.model}` : null}
			{unavailable ? (
				<span className="text-status-warning">
					{" "}
					— not configured on this node
				</span>
			) : null}
		</>
	);
}

/**
 * The six modality rows. Extracted from {@link RoutingCard} so each editor in
 * that card stays independently readable, and because the row list comes from
 * `MODALITIES` (the Rust enum's wire form) rather than from whatever happens to
 * be configured — an UNMAPPED modality has to be visible to state what it falls
 * back to.
 *
 * `served` is the load-bearing prop; see `routingViewIncludesModalityMap`. When
 * it is false there is nothing safe to render, because this app cannot
 * round-trip a field the node never sent. It is strictly two-state here: the
 * caller must not mount this component until the config has actually loaded, or
 * "not loaded yet" and "unreachable" would both render the too-old-gateway
 * warning and accuse a perfectly healthy node of being about to lose data.
 */
export function ModalityRoutingRows({
	served,
	modalityMap,
	defaultProvider,
	configuredProviders,
	disabled,
	onSave,
}: {
	served: boolean;
	modalityMap: Partial<Record<Modality, ModalityMapping>>;
	defaultProvider: string;
	configuredProviders: string[];
	disabled: boolean;
	onSave: (
		modality: Modality,
		mapping: { model?: string; provider: string } | null
	) => Promise<void>;
}) {
	const tl = useLiteralMessages();
	if (!served) {
		return (
			<p className="py-3 text-muted-foreground text-sm" role="note">
				<span className="text-status-warning">Update the gateway</span> to edit
				media routing here.{" "}
				<InfoHint label="Why media routing is unavailable">
					This gateway does not report its modality map, so it cannot be edited
					or preserved: saving routing here drops a hand-written{" "}
					<span className="font-mono">[routing.modality_map]</span> in{" "}
					<span className="font-mono">gateway.toml</span>.
				</InfoHint>
			</p>
		);
	}
	return (
		<SettingsGroup>
			{MODALITIES.map((modality) => {
				const mapping = modalityMap[modality];
				// Keep the stored provider selectable even when this node no longer
				// reports it (key removed, sidecar uninstalled) so opening the row
				// cannot silently re-home a working mapping onto another provider.
				const options =
					mapping && !configuredProviders.includes(mapping.provider)
						? [...configuredProviders, mapping.provider]
						: configuredProviders;
				return (
					<SettingsItem
						actions={
							<div className="flex shrink-0 items-center gap-1">
								<ModalityMappingDialog
									initial={{
										provider: mapping?.provider ?? options[0] ?? "",
										model: mapping?.model ?? "",
									}}
									modality={modality}
									onSave={(form) =>
										onSave(modality, {
											provider: form.provider,
											model: form.model,
										})
									}
									providers={options}
									trigger={
										<Button disabled={disabled} size="icon" variant="ghost">
											<HugeiconsIcon
												className="size-3.5"
												icon={mapping ? PencilEdit01Icon : Add01Icon}
											/>
											<span className="sr-only">
												{mapping
													? tl("Edit {label} routing", {
															label: MODALITY_COPY[modality].label,
														})
													: tl("Set {label} routing", {
															label: MODALITY_COPY[modality].label,
														})}
											</span>
										</Button>
									}
								/>
								<Button
									disabled={disabled || !mapping}
									onClick={() => onSave(modality, null)}
									size="icon"
									variant="ghost"
								>
									<HugeiconsIcon
										className="size-3.5 text-status-destructive"
										icon={Delete01Icon}
									/>
									<span className="sr-only">
										{tl("Clear {label} routing", {
											label: MODALITY_COPY[modality].label,
										})}
									</span>
								</Button>
							</div>
						}
						key={modality}
						title={
							<span className="flex min-w-0 flex-col">
								<span>{MODALITY_COPY[modality].label}</span>
								<span className="text-muted-foreground text-xs">
									<ModalityRowDescription
										configuredProviders={configuredProviders}
										defaultProvider={defaultProvider}
										mapping={mapping}
									/>
								</span>
							</span>
						}
					/>
				);
			})}
		</SettingsGroup>
	);
}
