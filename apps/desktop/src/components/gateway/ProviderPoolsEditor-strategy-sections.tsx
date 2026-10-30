import { useLiteralMessages } from "@ryu/i18n/react";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import type { Dispatch, SetStateAction } from "react";
import {
	type AutoScoringWeights,
	DEFAULT_POOL_AUTO_WEIGHTS,
	type PoolExecutionConfig,
} from "@/src/lib/api/gateway.ts";
import {
	AUTO_WEIGHT_FIELDS,
	EXECUTION_FIELDS,
	type Pool,
} from "./ProviderPoolsEditor-options.ts";

export function AutoWeightsDetails({
	autoWeights,
	setAutoWeights,
	controlsDisabled,
}: {
	autoWeights: Partial<AutoScoringWeights> | null;
	setAutoWeights: Dispatch<SetStateAction<Partial<AutoScoringWeights> | null>>;
	controlsDisabled: boolean;
}) {
	return (
		<details className="pt-4">
			<summary className="cursor-pointer font-medium text-sm">
				Advanced Auto scoring weights
			</summary>
			<div className="mt-3 space-y-3">
				<p className="text-muted-foreground text-xs">
					Weights change ranking, not the reported signals. With no custom
					configuration, the full pinned default set applies. In a custom
					partial configuration, unset fields are zero. Values must be finite,
					0–1,000, with a positive total.
				</p>
				<div className="flex items-center gap-2">
					<Switch
						checked={autoWeights !== null}
						disabled={controlsDisabled}
						id="pool-auto-custom"
						onCheckedChange={(checked) =>
							setAutoWeights(checked ? { ...DEFAULT_POOL_AUTO_WEIGHTS } : null)
						}
					/>
					<Label htmlFor="pool-auto-custom">Customize Auto weights</Label>
				</div>
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{AUTO_WEIGHT_FIELDS.map(({ key, label }) => (
						<div className="space-y-1.5" key={key}>
							<Label htmlFor={`pool-auto-${key}`}>{label}</Label>
							<Input
								disabled={controlsDisabled || autoWeights === null}
								id={`pool-auto-${key}`}
								max={1000}
								min={0}
								onChange={(event) =>
									setAutoWeights((current) => {
										if (current === null) {
											return current;
										}
										if (event.target.value.trim() === "") {
											const { [key]: _removed, ...remaining } = current;
											return remaining;
										}
										return {
											...current,
											[key]: Number(event.target.value),
										};
									})
								}
								placeholder="0 (unset)"
								step="any"
								type="number"
								value={
									autoWeights === null
										? DEFAULT_POOL_AUTO_WEIGHTS[key]
										: (autoWeights[key] ?? "")
								}
							/>
						</div>
					))}
				</div>
			</div>
		</details>
	);
}

export function MultiTargetExecutionSection({
	strategy,
	execution,
	setExecution,
	controlsDisabled,
	providers,
	providerLabel,
	judgeProvider,
	setJudgeProvider,
	judgeModel,
	setJudgeModel,
}: {
	strategy: Pool["strategy"];
	execution: PoolExecutionConfig;
	setExecution: Dispatch<SetStateAction<PoolExecutionConfig>>;
	controlsDisabled: boolean;
	providers: string[];
	providerLabel: (id: string) => string;
	judgeProvider: string;
	setJudgeProvider: (provider: string) => void;
	judgeModel: string;
	setJudgeModel: (model: string) => void;
}) {
	const tl = useLiteralMessages();
	return (
		<section aria-label="Multi-target execution" className="space-y-3 pt-4">
			<p className="font-medium text-sm">
				{strategy === "fusion" ? "Fusion execution" : "Pipeline execution"}
			</p>
			<p className="text-muted-foreground text-xs">
				{strategy === "fusion"
					? tl(
							"Collect independent text responses, then synthesize with the judge. Tool-bearing requests are sent directly to the judge rather than running multiple tool legs. Each accepted target call can incur its own provider charge, including the fusion judge. At most eight targets can be enabled."
						)
					: tl(
							"Run text targets in member order within the total deadline. Each accepted target call can incur its own provider charge, including the fusion judge. At most eight targets can be enabled."
						)}
			</p>
			<div className="grid gap-3 sm:grid-cols-2">
				{EXECUTION_FIELDS.map((field) => (
					<div className="space-y-1.5" key={field.key}>
						<Label htmlFor={`pool-execution-${field.key}`}>{field.label}</Label>
						<Input
							disabled={controlsDisabled}
							id={`pool-execution-${field.key}`}
							max={field.maximum}
							min={field.minimum}
							onChange={(event) =>
								setExecution((current) => ({
									...current,
									[field.key]: Number(event.target.value),
								}))
							}
							type="number"
							value={execution[field.key]}
						/>
					</div>
				))}
			</div>
			{strategy === "fusion" ? (
				<div className="grid gap-3 sm:grid-cols-2">
					<div className="space-y-1.5">
						<Label htmlFor="pool-judge-provider">Judge provider</Label>
						<Select
							disabled={controlsDisabled}
							items={providers.map((provider) => ({
								value: provider,
								label: providerLabel(provider),
							}))}
							onValueChange={(value) => {
								if (value && providers.includes(value)) {
									setJudgeProvider(value);
								}
							}}
							value={judgeProvider}
						>
							<SelectTrigger id="pool-judge-provider">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{providers.map((provider) => (
									<SelectItem key={provider} value={provider}>
										{providerLabel(provider)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="pool-judge-model">Judge model</Label>
						<Input
							disabled={controlsDisabled}
							id="pool-judge-model"
							maxLength={256}
							onChange={(event) => setJudgeModel(event.target.value)}
							placeholder="Exact upstream model ID"
							value={judgeModel}
						/>
					</div>
				</div>
			) : null}
		</section>
	);
}
