import {
	Add01Icon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	Delete01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type {
	GatewayRoutingConfig,
	ProviderKind,
} from "@/src/lib/api/gateway.ts";
import { modalityProviderLabel } from "./modality-mapping-dialog.tsx";
import { PROVIDER_LABELS } from "./model-mapping-dialog.tsx";

/** `RoutingCard`'s fallback chain: per-provider cost tier, order and removal. */
export function RoutingFallbackChainSection({
	addFallback,
	draft,
	isDisabled,
	moveFallback,
	patchDraft,
	providers,
	removeFallback,
}: {
	addFallback: (provider: ProviderKind) => void;
	draft: GatewayRoutingConfig | null;
	isDisabled: boolean;
	moveFallback: (index: number, direction: "up" | "down") => void;
	patchDraft: (patch: Partial<GatewayRoutingConfig>) => void;
	providers: ProviderKind[];
	removeFallback: (provider: string) => void;
}) {
	const tl = useLiteralMessages();
	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"Lower cost tiers go first; use the arrows to order providers within a tier."
					}
				>
					{"Tried in order when the primary provider is unavailable."}
				</CaptionInfo>
			}
			title="Fallback chain"
		>
			{(draft?.fallback_chain ?? []).length === 0 ? (
				<SettingsCard className="py-3 text-muted-foreground text-sm">
					No fallback chain configured. Add providers below to enable automatic
					fallback.
				</SettingsCard>
			) : (
				<SettingsGroup>
					{(draft?.fallback_chain ?? []).map((provider, i) => (
						<SettingsItem
							actions={
								<div className="flex items-center gap-1">
									<Select
										disabled={isDisabled}
										items={[
											{ value: "0", label: "Subscription" },
											{ value: "1", label: "Low cost" },
											{ value: "2", label: "Free" },
										]}
										onValueChange={(value) => {
											if (value && draft) {
												patchDraft({
													provider_tiers: {
														...draft.provider_tiers,
														[provider]: Number(value),
													},
												});
											}
										}}
										value={String(draft?.provider_tiers?.[provider] ?? 0)}
									>
										<SelectTrigger
											aria-label={tl("Cost tier for {provider}", { provider })}
											className="w-32"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="0">Subscription</SelectItem>
											<SelectItem value="1">Low cost</SelectItem>
											<SelectItem value="2">Free</SelectItem>
										</SelectContent>
									</Select>
									<Button
										disabled={isDisabled || i === 0}
										onClick={() => moveFallback(i, "up")}
										size="icon"
										variant="ghost"
									>
										<HugeiconsIcon className="size-3.5" icon={ArrowUp01Icon} />
										<span className="sr-only">Move up</span>
									</Button>
									<Button
										disabled={
											isDisabled ||
											i === (draft?.fallback_chain ?? []).length - 1
										}
										onClick={() => moveFallback(i, "down")}
										size="icon"
										variant="ghost"
									>
										<HugeiconsIcon
											className="size-3.5"
											icon={ArrowDown01Icon}
										/>
										<span className="sr-only">Move down</span>
									</Button>
									<Button
										disabled={isDisabled}
										onClick={() => removeFallback(provider)}
										size="icon"
										variant="ghost"
									>
										<HugeiconsIcon
											className="size-3.5 text-status-destructive"
											icon={Delete01Icon}
										/>
										<span className="sr-only">
											{tl("Remove {provider} from fallback chain", {
												provider,
											})}
										</span>
									</Button>
								</div>
							}
							key={provider}
							title={modalityProviderLabel(provider)}
						/>
					))}
				</SettingsGroup>
			)}
			{providers.length > 0 ? (
				<div className="flex flex-wrap gap-2 px-1.5">
					{providers
						.filter((p) => !(draft?.fallback_chain ?? []).includes(p))
						.map((p) => (
							<Button
								disabled={isDisabled}
								key={p}
								onClick={() => addFallback(p)}
								size="sm"
								variant="ghost"
							>
								<HugeiconsIcon className="size-3.5" icon={Add01Icon} />
								{PROVIDER_LABELS[p] ?? p}
							</Button>
						))}
				</div>
			) : null}
		</SettingsSection>
	);
}
