import {
	Add01Icon,
	Delete01Icon,
	PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { GatewayRoutingConfig } from "@/src/lib/api/gateway.ts";
import {
	fetchGatewayConfig,
	updateGatewayConfig,
} from "@/src/lib/api/gateway.ts";
import { modalityProviderLabel } from "./modality-mapping-dialog.tsx";
import {
	ModelMappingDialog,
	type ModelMappingFormState,
	mappingFromForm,
} from "./model-mapping-dialog.tsx";

/** `RoutingCard`'s model-map rows, each saved immediately against a fresh read. */
export function RoutingModelMappingsSection({
	addMapping,
	isDisabled,
	mappingEntries,
	mappingError,
	mappingProviders,
	onRoutingSaved,
	poolAliases,
	removeMapping,
	target,
}: {
	addMapping: (form: ModelMappingFormState) => Promise<void>;
	isDisabled: boolean;
	mappingEntries: [string, GatewayRoutingConfig["model_map"][string]][];
	mappingError: string | null;
	mappingProviders: string[];
	onRoutingSaved: (next: GatewayRoutingConfig) => void;
	poolAliases: string[];
	removeMapping: (model: string) => Promise<void>;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	return (
		<SettingsSection
			caption={
				poolAliases.length > 0
					? "Named chat pools from Gateway configuration are available as mapping targets."
					: undefined
			}
			headerAction={
				mappingProviders.length > 0 ? (
					<ModelMappingDialog
						description="Route a model name (exact or prefix) to a specific provider. Optionally rewrite the model name before forwarding."
						onSave={addMapping}
						providers={mappingProviders}
						title="Add model mapping"
						trigger={
							<Button disabled={isDisabled} size="sm" variant="ghost">
								<HugeiconsIcon className="size-4" icon={Add01Icon} />
								Add mapping
							</Button>
						}
					/>
				) : (
					<Button disabled size="sm" variant="ghost">
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						Add mapping
					</Button>
				)
			}
			title="Model mappings"
		>
			{mappingError ? (
				<p className="px-3 text-sm text-status-destructive" role="alert">
					{mappingError}
				</p>
			) : null}
			{mappingEntries.length === 0 ? (
				<SettingsCard className="py-3 text-muted-foreground text-sm">
					No model mappings. Requests are routed by built-in prefix rules then
					fall back to the default provider.
				</SettingsCard>
			) : (
				<SettingsGroup>
					{mappingEntries.map(([model, mapping]) => (
						<SettingsItem
							actions={
								<div className="flex shrink-0 items-center gap-1">
									<ModelMappingDialog
										description="Update the provider or model name for this mapping."
										initial={{
											model,
											provider: mapping.provider,
											provider_model: mapping.provider_model ?? "",
										}}
										modelReadOnly
										onSave={async (form) => {
											const cfg = await fetchGatewayConfig(target);
											const updated = mappingFromForm(form);
											const next: GatewayRoutingConfig = {
												...cfg.routing,
												model_map: {
													...cfg.routing.model_map,
													[model]: updated,
												},
											};
											await updateGatewayConfig(target, {
												routing: next,
												expectedRevision: cfg.configRevision ?? undefined,
											});
											onRoutingSaved(next);
										}}
										providers={mappingProviders}
										title="Edit model mapping"
										trigger={
											<Button disabled={isDisabled} size="icon" variant="ghost">
												<HugeiconsIcon
													className="size-3.5"
													icon={PencilEdit01Icon}
												/>
												<span className="sr-only">
													{tl("Edit mapping for {model}", { model })}
												</span>
											</Button>
										}
									/>
									<Button
										disabled={isDisabled}
										onClick={() => removeMapping(model)}
										size="icon"
										variant="ghost"
									>
										<HugeiconsIcon
											className="size-3.5 text-status-destructive"
											icon={Delete01Icon}
										/>
										<span className="sr-only">
											{tl("Remove mapping for {model}", { model })}
										</span>
									</Button>
								</div>
							}
							key={model}
							title={
								<span className="flex min-w-0 flex-col">
									<span className="truncate font-mono">{model}</span>
									<span className="text-muted-foreground text-xs">
										{modalityProviderLabel(mapping.provider)}
										{mapping.provider_model
											? ` → ${mapping.provider_model}`
											: null}
									</span>
								</span>
							}
						/>
					))}
				</SettingsGroup>
			)}
		</SettingsSection>
	);
}
