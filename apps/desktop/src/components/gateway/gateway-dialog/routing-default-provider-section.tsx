import { Button } from "@ryu/ui/components/button.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
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
import { PROVIDER_LABELS } from "./model-mapping-dialog.tsx";

/** `RoutingCard`'s first section: load errors, reachability and the default provider. */
export function RoutingDefaultProviderSection({
	configError,
	draft,
	isDisabled,
	onRetry,
	patchDraft,
	providers,
	reachable,
}: {
	configError: string | null;
	draft: GatewayRoutingConfig | null;
	isDisabled: boolean;
	onRetry: () => void;
	patchDraft: (patch: Partial<GatewayRoutingConfig>) => void;
	providers: ProviderKind[];
	reachable: boolean;
}) {
	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						<>
							Ryu applies firewall rules, PII/DLP and per-agent budgets here,
							before a request leaves for any provider. OpenRouter's own routing
							and guardrails run on top and do not replace them. Use{" "}
							<span className="font-mono">openrouter/auto</span>,{" "}
							<span className="font-mono">openrouter/pareto-code</span> or any{" "}
							<span className="font-mono">openrouter/&lt;model&gt;</span> slug.
						</>
					}
				>
					Runs before any upstream provider routing.
				</CaptionInfo>
			}
			title="Routing"
		>
			<div className="flex flex-col gap-3">
				{reachable && configError ? (
					<SettingsCard className="flex flex-wrap items-center justify-between gap-3">
						<p
							className="min-w-0 flex-1 break-words text-muted-foreground text-sm"
							role="alert"
						>
							{configError}
						</p>
						<Button onClick={onRetry} size="sm" variant="secondary">
							Retry
						</Button>
					</SettingsCard>
				) : null}
				{reachable ? null : (
					<SettingsCard className="text-muted-foreground text-sm">
						Gateway unreachable, so controls are disabled. Start the gateway and
						refresh to configure routing.
					</SettingsCard>
				)}

				<SettingsGroup>
					<SettingsItem
						actions={
							<Select
								disabled={isDisabled || providers.length === 0}
								items={providers.map((p) => ({
									value: p,
									label: PROVIDER_LABELS[p] ?? p,
								}))}
								onValueChange={(v) => v && patchDraft({ default_provider: v })}
								value={draft?.default_provider ?? "openai"}
							>
								<SelectTrigger className="w-48" id="routing-default-provider">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{providers.map((p) => (
										<SelectItem key={p} value={p}>
											{PROVIDER_LABELS[p] ?? p}
										</SelectItem>
									))}
									{providers.length === 0 ? (
										<SelectItem disabled value="__none__">
											No providers configured
										</SelectItem>
									) : null}
								</SelectContent>
							</Select>
						}
						description="Used when no model-map entry matches the requested model name."
						title={
							<Label htmlFor="routing-default-provider">Default provider</Label>
						}
					/>
				</SettingsGroup>
			</div>
		</SettingsSection>
	);
}
