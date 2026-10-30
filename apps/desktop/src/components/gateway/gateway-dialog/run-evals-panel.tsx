import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { CaptionInfo, StatusText } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	NO_DEFAULT_MODEL_INPUT_HINT,
	useNodeDefaultModel,
} from "@/src/hooks/useNodeDefaultModel.ts";
import { ApiError, type ApiTarget } from "@/src/lib/api/client.ts";
import type {
	EvalCaseScore,
	EvalRunAggregate,
	EvalRunResult,
} from "@/src/lib/api/gateway.ts";
import { runGatewayEvals } from "@/src/lib/api/gateway.ts";

function scoreBarColor(pct: number): string {
	if (pct >= 80) {
		return "bg-success";
	}
	if (pct >= 50) {
		return "bg-warning";
	}
	return "bg-destructive";
}

function scoreBar(value: number) {
	const pct = Math.round(value * 100);
	const color = scoreBarColor(pct);
	const gatewayScoreVariables1: CSSProperties & {
		"--gateway-score-width": string;
	} = { "--gateway-score-width": `${pct}%` };
	return (
		<div className="flex items-center gap-2">
			<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
				<div
					className={`h-full rounded-full ${color}`}
					data-gateway-score-bar=""
					style={gatewayScoreVariables1}
				/>
			</div>
			<span className="w-10 text-right text-xs tabular-nums">{pct}%</span>
		</div>
	);
}

function AggregateCard({ agg }: { agg: EvalRunAggregate }) {
	const tl = useLiteralMessages();
	return (
		<SettingsSection
			caption={tl(
				"Summary across all {count, plural, one {{total} case} other {{total} cases}}.",
				{ count: agg.total_cases, total: String(agg.total_cases) }
			)}
			title="Aggregate"
		>
			<SettingsCard className="grid grid-cols-2 gap-x-8 gap-y-3">
				<div>
					<div className="mb-1 text-muted-foreground text-xs">Overall</div>
					{scoreBar(agg.mean_overall)}
				</div>
				<div>
					<div className="mb-1 text-muted-foreground text-xs">Latency</div>
					{agg.latency_available_cases === 0 ? (
						<span className="text-muted-foreground text-sm">Not measured</span>
					) : (
						scoreBar(agg.mean_latency)
					)}
				</div>
				<div>
					<div className="mb-1 text-muted-foreground text-xs">
						Token efficiency
					</div>
					{scoreBar(agg.mean_token_efficiency)}
				</div>
				<div>
					<div className="mb-1 text-muted-foreground text-xs">
						Policy pass rate
					</div>
					{agg.policy_available_cases === 0 ? (
						<span className="text-muted-foreground text-sm">Not measured</span>
					) : (
						scoreBar(agg.policy_pass_rate)
					)}
				</div>
				{agg.mean_substring_match === null ? null : (
					<div>
						<div className="mb-1 text-muted-foreground text-xs">
							Substring match
						</div>
						{scoreBar(agg.mean_substring_match)}
					</div>
				)}
			</SettingsCard>
		</SettingsSection>
	);
}

function CasesTable({ cases }: { cases: EvalCaseScore[] }) {
	return (
		<SettingsSection caption="Per-prompt scores." title="Cases">
			<SettingsCard className="overflow-x-auto">
				<table className="w-full text-sm">
					<thead>
						<tr className="border-b text-left text-muted-foreground text-xs">
							<th className="pr-4 pb-2 font-medium">Prompt</th>
							<th className="pr-4 pb-2 font-medium">Overall</th>
							<th className="pr-4 pb-2 font-medium">Latency</th>
							<th className="pr-4 pb-2 font-medium">Token eff.</th>
							<th className="pr-4 pb-2 font-medium">Policy</th>
							<th className="pb-2 font-medium">Substr.</th>
						</tr>
					</thead>
					<tbody>
						{cases.map((c) => (
							<tr className="border-b last:border-0" key={c.prompt}>
								<td className="max-w-48 truncate py-2 pr-4">
									<Tooltip>
										<TooltipTrigger render={<span>{c.prompt}</span>} />
										<TooltipContent>{c.prompt}</TooltipContent>
									</Tooltip>
								</td>
								<td className="py-2 pr-4 text-xs tabular-nums">
									{Math.round(c.overall * 100)}%
								</td>
								<td className="py-2 pr-4 text-xs tabular-nums">
									{c.latency_available === false
										? "—"
										: `${Math.round(c.latency_score * 100)}%`}
								</td>
								<td className="py-2 pr-4 text-xs tabular-nums">
									{Math.round(c.token_efficiency * 100)}%
								</td>
								<td className="py-2 pr-4">
									{c.policy_available === false ? (
										<span className="text-muted-foreground text-xs">
											not measured
										</span>
									) : c.policy_pass ? (
										<span className="text-muted-foreground">Pass</span>
									) : (
										<StatusText tone="destructive">Fail</StatusText>
									)}
								</td>
								<td className="py-2 text-xs tabular-nums">
									{c.substring_match === null
										? "—"
										: `${Math.round(c.substring_match * 100)}%`}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</SettingsCard>
		</SettingsSection>
	);
}

export function RunEvalsPanel({ target }: { target: ApiTarget }) {
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<EvalRunResult | null>(null);
	const [runError, setRunError] = useState<string | null>(null);
	const nodeDefault = useNodeDefaultModel(target);
	const [model, setModel] = useState("");
	// Pre-fill the node's default model once it resolves; a typed id wins.
	const modelEditedRef = useRef(false);
	useEffect(() => {
		if (nodeDefault.model && !modelEditedRef.current) {
			setModel(nodeDefault.model);
		}
	}, [nodeDefault.model]);
	const abortRef = useRef<AbortController | null>(null);
	const runModel = model.trim();

	const handleRun = async () => {
		if (!runModel) {
			return;
		}
		abortRef.current?.abort();
		const ac = new AbortController();
		abortRef.current = ac;
		setRunning(true);
		setRunError(null);
		setResult(null);
		try {
			const res = await runGatewayEvals(
				target,
				{ model: runModel, dataset: [] },
				ac.signal
			);
			setResult(res);
		} catch (e) {
			if (!(e instanceof DOMException && e.name === "AbortError")) {
				setRunError(
					e instanceof ApiError && e.serverMessage
						? e.serverMessage
						: e instanceof Error
							? e.message
							: "Eval run failed."
				);
			}
		} finally {
			setRunning(false);
		}
	};

	return (
		<>
			<SettingsSection
				caption={
					<CaptionInfo
						detail={
							"Replay the built-in 3-case dataset through the gateway pipeline and get a scorecard: latency, token efficiency, policy pass, and optional substring match. LLM-judge scoring needs a per-case rubric; it lives in Prompt Studio."
						}
					>
						{
							"Replay a built-in 3-case dataset through the gateway and score it."
						}
					</CaptionInfo>
				}
				title="Run evals"
			>
				<div className="flex flex-col gap-4">
					<SettingsGroup>
						<SettingsItem
							actions={
								<div className="flex items-center gap-2">
									<Input
										className="w-48"
										id="eval-model"
										onChange={(e) => {
											modelEditedRef.current = true;
											setModel(e.target.value);
										}}
										placeholder="Model id"
										value={model}
									/>
									<Button
										disabled={!runModel}
										loading={running}
										onClick={() => {
											handleRun().catch((_e) => undefined);
										}}
										size="sm"
										variant="outline"
									>
										{running ? "Running…" : "Run"}
									</Button>
								</div>
							}
							description={
								runModel || nodeDefault.loading
									? undefined
									: NO_DEFAULT_MODEL_INPUT_HINT
							}
							title={<Label htmlFor="eval-model">Model</Label>}
						/>
					</SettingsGroup>

					{runError ? (
						<SettingsCard className="text-sm text-status-destructive">
							{runError}
						</SettingsCard>
					) : null}
				</div>
			</SettingsSection>
			{result ? (
				<>
					<AggregateCard agg={result.aggregate} />
					<CasesTable cases={result.cases} />
				</>
			) : null}
		</>
	);
}
