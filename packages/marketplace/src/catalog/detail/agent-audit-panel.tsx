import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { useRef, useState } from "react";
import type { CatalogScanResult } from "../host.tsx";

/** An explicit, advisory audit. Hosts remount when the evidence or node changes. */
export function AgentAuditPanel({
	onOpenConversation,
	runAudit,
}: {
	onOpenConversation?: (id: string) => void;
	runAudit: () => Promise<CatalogScanResult>;
}) {
	const tl = useLiteralMessages();
	const [result, setResult] = useState<CatalogScanResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [running, setRunning] = useState(false);
	const inFlight = useRef(false);
	async function audit() {
		if (inFlight.current) {
			return;
		}
		inFlight.current = true;
		setRunning(true);
		setError(null);
		setResult(null);
		try {
			setResult(await runAudit());
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "The audit could not finish."
			);
		} finally {
			inFlight.current = false;
			setRunning(false);
		}
	}
	const assessment = result?.assessment;
	return (
		<section
			className="space-y-3 rounded-lg border p-4"
			data-testid="agent-audit-panel"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0 flex-1">
					<h3 className="font-medium text-sm">Agent audit</h3>
					<p className="mt-1 text-muted-foreground text-xs">
						On demand. Your default agent reviews the evidence using its normal
						permissions. Static checks remain the default.
					</p>
				</div>
				<Button
					data-testid="catalog-scan-button"
					disabled={running}
					loading={running}
					onClick={() => void audit()}
					size="sm"
					variant="outline"
				>
					{running ? "Auditing…" : result ? "Audit again" : "Audit with agent"}
				</Button>
			</div>
			{running ? (
				<p className="text-muted-foreground text-xs" role="status">
					The agent is reviewing the evidence…
				</p>
			) : null}
			{error ? (
				<p
					className="text-sm text-status-destructive"
					data-testid="catalog-scan-error"
					role="alert"
				>
					{tl("Agent audit failed: {error}", { error })}
				</p>
			) : null}
			{result ? (
				<div
					aria-live="polite"
					className="space-y-3 border-t pt-3"
					data-testid="catalog-scan-result"
				>
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-medium text-sm">
							{assessment?.score == null
								? "No advisory score"
								: `${assessment.score}/100 advisory score`}
						</span>
						<Badge variant="secondary">
							{result.status === "complete" ? "Complete" : "Partial"}
						</Badge>
						{result.conversationId && onOpenConversation ? (
							<Button
								onClick={() => {
									if (result.conversationId) {
										onOpenConversation(result.conversationId);
									}
								}}
								size="sm"
								variant="ghost"
							>
								Open audit conversation
							</Button>
						) : null}
						{assessment ? (
							<span className="text-muted-foreground text-xs">
								{tl("{confidence} confidence", {
									confidence: assessment.confidence,
								})}
							</span>
						) : null}
					</div>
					<p className="break-words text-muted-foreground text-xs">
						{tl("{auditDetails}. Static results are unchanged.", {
							auditDetails: `${result.agentId}${
								result.model ? ` · ${result.model}` : ""
							}${
								result.auditedAt
									? ` · ${new Date(result.auditedAt).toLocaleString()}`
									: ""
							}`,
						})}
					</p>
					{assessment ? (
						<>
							<p className="whitespace-pre-wrap break-words text-sm">
								{assessment.summary}
							</p>
							<h4 className="font-medium text-xs">Evidence</h4>
							<ul className="list-disc space-y-1 pl-4 text-muted-foreground text-xs">
								{assessment.evidence.map((item, index) => (
									<li key={`${index}:${item}`}>{item}</li>
								))}
							</ul>
							<h4 className="font-medium text-xs">Recommendations</h4>
							{assessment.recommendations.length ? (
								<ul className="space-y-2">
									{assessment.recommendations.map((item, index) => (
										<li
											className="space-y-1 rounded-lg bg-muted p-3 text-xs"
											key={`${index}:${item.action}`}
										>
											<div className="flex flex-wrap items-center gap-2">
												<Badge variant="outline">{item.priority}</Badge>
												<span className="font-medium">{item.action}</span>
											</div>
											<p className="text-muted-foreground">{item.reason}</p>
										</li>
									))}
								</ul>
							) : (
								<p className="text-muted-foreground text-xs">
									No recommendations in this assessment.
								</p>
							)}
							{assessment.limitations.length ? (
								<>
									<h4 className="font-medium text-xs">Limitations</h4>
									<ul className="list-disc space-y-1 pl-4 text-muted-foreground text-xs">
										{assessment.limitations.map((item, index) => (
											<li key={`${index}:${item}`}>{item}</li>
										))}
									</ul>
								</>
							) : null}
						</>
					) : (
						<p className="whitespace-pre-wrap break-words text-sm">
							{result.report || "The agent returned no report. Try again."}
						</p>
					)}
				</div>
			) : null}
		</section>
	);
}
