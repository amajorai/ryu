import { useLiteralMessages } from "@ryu/i18n/react";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import type { OpenRouterProvider } from "@/src/lib/api/openrouter.ts";
import {
	NODE_ROUTING_PREFS_MAX_BYTES,
	type NodeRoutingPreferences,
	type OpenRouterOption,
	type OpenRouterOptions,
} from "@/src/lib/api/preferences.ts";
import {
	ModelFallbackEditor,
	PercentileEditor,
	PriceInput,
} from "./NodeRoutingSettings-field-editors.tsx";
import {
	dataCollectionLabel,
	isRecord,
	numericText,
	optionNumber,
	type Percentile,
	type ProviderListKey,
	percentileValues,
	QUANTIZATIONS,
	stringList,
} from "./NodeRoutingSettings-options.ts";
import { ProviderListEditor } from "./NodeRoutingSettings-provider-editors.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/** The Business-only OpenRouter sections, from provider limits to advanced JSON. */
export function NodeRoutingBusinessSections({
	prefs,
	providers,
	providerOptions,
	controlsDisabled,
	loaded,
	saving,
	advancedText,
	advancedError,
	changeOption,
	changeProviderList,
	changePercentile,
	changePrice,
	setModelFallbacks,
	updateAdvanced,
}: {
	prefs: NodeRoutingPreferences;
	providers: OpenRouterProvider[];
	providerOptions: OpenRouterOptions | null;
	controlsDisabled: boolean;
	loaded: boolean;
	saving: boolean;
	advancedText: string;
	advancedError: string | null;
	changeOption: (key: string, value: OpenRouterOption | undefined) => void;
	changeProviderList: (
		key: "order" | ProviderListKey,
		values: string[]
	) => void;
	changePercentile: (
		key: "preferred_min_throughput" | "preferred_max_latency",
		percentile: Percentile,
		raw: string
	) => void;
	changePrice: (
		key: "prompt" | "completion" | "request" | "image",
		raw: string
	) => void;
	setModelFallbacks: (values: string[]) => void;
	updateAdvanced: (raw: string) => void;
}) {
	const tl = useLiteralMessages();
	return (
		<>
			<SettingsSection
				caption="When an allowlist is set, OpenRouter can only choose from those providers. Provider restrictions still apply alongside your organization's managed allowlist."
				title="Limit providers"
			>
				<SettingsCard className="grid gap-5 md:grid-cols-2">
					<ProviderListEditor
						disabled={controlsDisabled}
						label="Only these providers"
						onChange={(values) => changeProviderList("only", values)}
						providers={providers}
						values={stringList(providerOptions?.only)}
					/>
					<ProviderListEditor
						disabled={controlsDisabled}
						label="Never use these providers"
						onChange={(values) => changeProviderList("ignore", values)}
						providers={providers}
						values={stringList(providerOptions?.ignore)}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection title="Fallback behavior">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Allow provider fallbacks"
								checked={providerOptions?.allow_fallbacks !== false}
								disabled={controlsDisabled}
								onCheckedChange={(checked) =>
									changeOption("allow_fallbacks", checked ? undefined : false)
								}
							/>
						}
						description="If a matching provider is unavailable, let OpenRouter try another provider that meets the same rules."
						title="Allow provider fallbacks"
					/>
					<SettingsItem
						description="OpenRouter tries these model ids after the primary model. Add them in preference order."
						title="Model fallbacks"
					>
						<div className="pb-1">
							<ModelFallbackEditor
								disabled={controlsDisabled}
								onChange={setModelFallbacks}
								values={prefs.openrouter_model_fallbacks}
							/>
						</div>
					</SettingsItem>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="Your organization's managed privacy policy can enforce stricter provider requirements."
				title="Privacy and data use"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Select disabled={true} value="deny">
								<SelectTrigger
									aria-label="OpenRouter data collection"
									className="w-72"
									variant="default"
								>
									{dataCollectionLabel("deny")}
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="default">OpenRouter default</SelectItem>
									<SelectItem value="allow">Allow collection</SelectItem>
									<SelectItem value="deny">
										Exclude data-collecting providers
									</SelectItem>
								</SelectContent>
							</Select>
						}
						description="Data-collecting providers are excluded for every plan."
						title="Data collection"
					/>
					<SettingsItem
						actions={
							<Switch
								aria-label="Require Zero Data Retention (ZDR)"
								checked={true}
								disabled={true}
								onCheckedChange={() => {}}
							/>
						}
						description="Required for every plan. OpenRouter requests use endpoints that meet its ZDR policy. Tools and plugins have separate policies."
						title="Require Zero Data Retention (ZDR)"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection title="Provider requirements">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Require parameter support"
								checked={providerOptions?.require_parameters === true}
								disabled={controlsDisabled}
								onCheckedChange={(checked) =>
									changeOption("require_parameters", checked ? true : undefined)
								}
							/>
						}
						description="Only route to providers that support every parameter included in the request."
						title="Require parameter support"
					/>
					<SettingsItem
						actions={
							<Switch
								aria-label="Require distillable text"
								checked={providerOptions?.enforce_distillable_text === true}
								disabled={controlsDisabled}
								onCheckedChange={(checked) =>
									changeOption(
										"enforce_distillable_text",
										checked ? true : undefined
									)
								}
							/>
						}
						description="Only select providers that permit model distillation from text outputs."
						title="Require distillable text"
					/>
					<SettingsItem
						description="Leave all unchecked to let OpenRouter select any available precision."
						title="Quantization"
					>
						<div className="grid grid-cols-2 gap-x-4 gap-y-2 pb-1 sm:grid-cols-3 lg:grid-cols-4">
							{QUANTIZATIONS.map((quantization) => {
								const selected = stringList(
									providerOptions?.quantizations
								).includes(quantization);
								return (
									<label
										className="flex items-center gap-2 text-sm"
										key={quantization}
									>
										<Checkbox
											aria-label={tl("{quantization} quantization", {
												quantization,
											})}
											checked={selected}
											disabled={controlsDisabled}
											onCheckedChange={(checked) => {
												const values = stringList(
													providerOptions?.quantizations
												);
												const next = checked
													? [...values, quantization]
													: values.filter((item) => item !== quantization);
												changeOption(
													"quantizations",
													next.length ? next : undefined
												);
											}}
										/>
										{quantization}
									</label>
								);
							})}
						</div>
					</SettingsItem>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="These preferences help OpenRouter rank matching providers; they do not guarantee a latency or throughput level."
				title="Performance preferences"
			>
				<SettingsGroup>
					<PercentileEditor
						disabled={controlsDisabled}
						keyName="preferred_min_throughput"
						label="Preferred minimum throughput"
						onChange={changePercentile}
						unit="tokens per second"
						values={percentileValues(
							providerOptions,
							"preferred_min_throughput"
						)}
					/>
					<PercentileEditor
						disabled={controlsDisabled}
						keyName="preferred_max_latency"
						label="Preferred maximum latency"
						onChange={changePercentile}
						unit="seconds"
						values={percentileValues(providerOptions, "preferred_max_latency")}
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="Leave a limit blank to use the provider's price. These are OpenRouter request caps and use dollars."
				title="Maximum price"
			>
				<SettingsGroup>
					<PriceInput
						disabled={controlsDisabled}
						label="Prompt ($ per million tokens)"
						onChange={(raw) => changePrice("prompt", raw)}
						value={numericText(
							isRecord(providerOptions?.max_price)
								? optionNumber(providerOptions.max_price, "prompt")
								: undefined
						)}
					/>
					<PriceInput
						disabled={controlsDisabled}
						label="Completion ($ per million tokens)"
						onChange={(raw) => changePrice("completion", raw)}
						value={numericText(
							isRecord(providerOptions?.max_price)
								? optionNumber(providerOptions.max_price, "completion")
								: undefined
						)}
					/>
					<PriceInput
						disabled={controlsDisabled}
						label="Request ($ per request)"
						onChange={(raw) => changePrice("request", raw)}
						value={numericText(
							isRecord(providerOptions?.max_price)
								? optionNumber(providerOptions.max_price, "request")
								: undefined
						)}
					/>
					<PriceInput
						disabled={controlsDisabled}
						label="Image ($ per image)"
						onChange={(raw) => changePrice("image", raw)}
						value={numericText(
							isRecord(providerOptions?.max_price)
								? optionNumber(providerOptions.max_price, "image")
								: undefined
						)}
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="These controls require an active organization on the Business plan. Managed organization privacy rules take precedence when they are stricter than these routing preferences."
				title="Advanced provider options"
			>
				<SettingsCard>
					<details>
						<summary className="cursor-pointer text-sm">
							Edit complete OpenRouter provider JSON
						</summary>
						<p className="my-3 text-muted-foreground text-xs">
							All current and future fields from OpenRouter's{" "}
							<code>provider</code> request object can be set here. Typed
							controls stay in sync with this editor.
						</p>
						<Textarea
							aria-label="Advanced OpenRouter provider options JSON"
							className="min-h-44"
							disabled={!loaded || saving}
							maxLength={NODE_ROUTING_PREFS_MAX_BYTES}
							onChange={(event) => updateAdvanced(event.target.value)}
							placeholder="Leave blank to use the OpenRouter default routing."
							value={advancedText}
							variant="code-caption"
						/>
						{advancedError ? (
							<p className="mt-2 text-destructive text-xs">{advancedError}</p>
						) : null}
					</details>
				</SettingsCard>
			</SettingsSection>
		</>
	);
}
