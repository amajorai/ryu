import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
} from "@ryu/ui/components/select.tsx";
import type { Dispatch, SetStateAction } from "react";
import type { OpenRouterProvider } from "@/src/lib/api/openrouter.ts";
import type {
	OpenRouterOption,
	OpenRouterOptions,
} from "@/src/lib/api/preferences.ts";
import {
	PROVIDER_LIST_ID,
	type ProviderListKey,
	sortStrategy,
	sortStrategyLabel,
	stringList,
} from "./NodeRoutingSettings-options.ts";
import { OrderedProviderEditor } from "./NodeRoutingSettings-provider-editors.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/** The "OpenRouter routing" section: strategy and provider order, or the Business upsell. */
export function NodeRoutingOpenRouterSection({
	businessOrg,
	providers,
	providerOptions,
	controlsDisabled,
	catalogError,
	setCatalogReload,
	changeOption,
	changeProviderList,
	openPricing,
	authenticated,
	billing,
}: {
	businessOrg: boolean;
	providers: OpenRouterProvider[];
	providerOptions: OpenRouterOptions | null;
	controlsDisabled: boolean;
	catalogError: string | null;
	setCatalogReload: Dispatch<SetStateAction<number>>;
	changeOption: (key: string, value: OpenRouterOption | undefined) => void;
	changeProviderList: (
		key: "order" | ProviderListKey,
		values: string[]
	) => void;
	openPricing: () => void;
	authenticated: boolean;
	billing: { loading: boolean };
}) {
	const tl = useLiteralMessages();
	return (
		<SettingsSection
			caption="Choose where OpenRouter sends managed requests, how it fails over, and which provider privacy and performance requirements apply."
			title="OpenRouter routing"
		>
			{businessOrg ? (
				<>
					<datalist id={PROVIDER_LIST_ID}>
						{providers.map((provider) => (
							<option key={provider.slug} value={provider.slug}>
								{provider.name}
							</option>
						))}
					</datalist>
					<SettingsGroup>
						<SettingsItem
							actions={
								<Select
									disabled={controlsDisabled}
									onValueChange={(value) => {
										if (value !== "custom") {
											changeOption(
												"sort",
												value === "default" ? undefined : value
											);
										}
									}}
									value={sortStrategy(providerOptions)}
								>
									<SelectTrigger
										aria-label="OpenRouter provider strategy"
										className="w-64"
										variant="default"
									>
										{sortStrategyLabel(sortStrategy(providerOptions))}
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="default">
											OpenRouter health-aware default
										</SelectItem>
										<SelectItem value="throughput">
											Higher throughput first
										</SelectItem>
										<SelectItem value="latency">Lower latency first</SelectItem>
										<SelectItem value="price">Lower price first</SelectItem>
										<SelectItem value="custom">
											Custom (advanced JSON)
										</SelectItem>
									</SelectContent>
								</Select>
							}
							description="The default uses OpenRouter's live provider health routing. A sort strategy or provider order replaces that default balancing behavior; choose one when you need a specific tradeoff."
							title="Provider strategy"
						/>
						<SettingsItem
							description="Provider slugs come from OpenRouter's public list. Enter any custom slug if it is not listed."
							title="Provider order"
						>
							<div className="space-y-2 pb-1">
								<OrderedProviderEditor
									disabled={controlsDisabled}
									onChange={(values) => changeProviderList("order", values)}
									providers={providers}
									values={stringList(providerOptions?.order)}
								/>
								{catalogError ? (
									<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
										<span>{catalogError}</span>
										<Button
											disabled={controlsDisabled}
											onClick={() => setCatalogReload((value) => value + 1)}
											size="sm"
											variant="outline"
										>
											Reload list
										</Button>
									</div>
								) : providers.length === 0 ? (
									<p className="text-muted-foreground text-xs">
										Loading OpenRouter providers…
									</p>
								) : null}
							</div>
						</SettingsItem>
					</SettingsGroup>
				</>
			) : (
				<SettingsGroup>
					<SettingsItem
						actions={
							<Button onClick={openPricing} size="sm" variant="outline">
								View Business plans
							</Button>
						}
						description={
							<>
								{tl(
									"OpenRouter provider controls are available to Business organizations. Choose upstream providers, uptime and fallback behavior, ZDR, and other request-level routing requirements on the Business plan."
								)}
								{authenticated && billing.loading ? (
									<span className="mt-1 block">
										Checking the active organization's plan…
									</span>
								) : null}
							</>
						}
						title="Business plan required"
					/>
				</SettingsGroup>
			)}
		</SettingsSection>
	);
}
