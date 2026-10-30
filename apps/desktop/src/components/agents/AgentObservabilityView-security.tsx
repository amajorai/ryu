import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { InlineErrorRow } from "@/src/components/chat/InlineErrorRow.tsx";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { NO_DEFAULT_MODEL_HINT } from "@/src/hooks/useNodeDefaultModel.ts";
import type { RedTeamRunResult } from "@/src/lib/api/gateway.ts";

export interface ObservabilitySecuritySectionProps {
	effectiveModel: string;
	modelLoading: boolean;
	onRun: () => void;
	securityError: string | null;
	securityResult: RedTeamRunResult | null;
	securityRunning: boolean;
}

export function ObservabilitySecuritySection({
	effectiveModel,
	modelLoading,
	onRun,
	securityError,
	securityResult,
	securityRunning,
}: ObservabilitySecuritySectionProps) {
	const tl = useLiteralMessages();
	return (
		<>
			<SettingsSection
				caption="Probe for prompt injection, jailbreaks, PII leaks, tool misuse and toxic output."
				title="Security sweep"
			>
				<SettingsCard
					className="flex flex-col gap-3"
					data-testid="observability-security"
				>
					<div className="flex flex-wrap items-start justify-between gap-3">
						<div className="min-w-0">
							<p className="font-semibold text-sm">Agent safety probes</p>
							<p className="mt-0.5 text-detail text-muted-foreground">
								Fixed probes on the production path. No real tool runs.
							</p>
							{effectiveModel ? (
								<p className="mt-0.5 text-detail text-muted-foreground">
									Model:{" "}
									<span className="text-foreground">{effectiveModel}</span>
								</p>
							) : null}
							{effectiveModel || modelLoading ? null : (
								<p
									className="mt-0.5 text-detail text-muted-foreground"
									data-testid="observability-security-no-model"
								>
									{NO_DEFAULT_MODEL_HINT}
								</p>
							)}
						</div>
						<Button
							data-testid="observability-security-run"
							disabled={!effectiveModel}
							loading={securityRunning}
							onClick={onRun}
							size="sm"
							variant="outline"
						>
							Run security checks
						</Button>
					</div>

					{securityError ? (
						<InlineErrorRow
							details={securityError}
							message="The security checks could not run."
							onRetry={onRun}
						/>
					) : null}

					{securityResult ? (
						<div
							className="flex flex-col gap-2"
							data-testid="observability-security-result"
						>
							<div className="flex flex-wrap items-center gap-2 text-sm">
								<span className="tabular-nums">
									{securityResult.summary.protected}/
									{securityResult.summary.total} protected
								</span>
								{securityResult.summary.needs_attention > 0 ? (
									<Badge variant="destructive">
										{tl("{count} needs attention", {
											count: String(securityResult.summary.needs_attention),
										})}
									</Badge>
								) : null}
								<span className="text-muted-foreground text-xs">
									{securityResult.model}
								</span>
							</div>
							<div>
								{securityResult.strategies.map((strategy) => (
									<div
										className="flex flex-wrap items-start justify-between gap-2 border-border border-t py-2 text-sm first:border-t-0"
										key={strategy.id}
									>
										<div className="min-w-0">
											<p className="font-medium">{strategy.name}</p>
											<p className="mt-0.5 text-detail text-muted-foreground">
												{strategy.detail}
											</p>
										</div>
										{strategy.protected ? (
											<span className="text-muted-foreground text-xs">
												Protected
											</span>
										) : (
											<Badge variant="destructive">Needs attention</Badge>
										)}
									</div>
								))}
							</div>
						</div>
					) : null}
				</SettingsCard>
			</SettingsSection>

			<p className="text-detail text-muted-foreground">
				Turn a failure into a regression test from the Quality tests tab.
			</p>
		</>
	);
}
