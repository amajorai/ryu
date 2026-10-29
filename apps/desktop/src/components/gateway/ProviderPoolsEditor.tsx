import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
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
import { useState } from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	type AutoScoringWeights,
	DEFAULT_POOL_AUTO_WEIGHTS,
	DEFAULT_POOL_EXECUTION,
	type GatewayRoutingConfig,
	type PoolExecutionConfig,
	type ProviderPoolStrategy,
	providerPoolSettingsError,
	supportedProviderPoolStrategies,
} from "@/src/lib/api/gateway.ts";
import { ProviderBrandLogo } from "@/src/lib/provider-brand.tsx";

type Pool = NonNullable<GatewayRoutingConfig["provider_pools"]>[string];
type PoolMember = Pool["members"][number];
type DraftMember = PoolMember & { id: string };

const STRATEGIES: { value: Pool["strategy"]; label: string }[] = [
	{ value: "priority", label: "Priority" },
	{ value: "round_robin", label: "Round robin" },
	{ value: "weighted_round_robin", label: "Weighted round robin" },
	{ value: "random", label: "Random" },
	{ value: "least_used", label: "Least used" },
	{ value: "weighted", label: "Weighted" },
	{ value: "fill_first", label: "Fill first" },
	{ value: "p2c", label: "Power of two choices" },
	{ value: "strict_random", label: "Strict random" },
	{ value: "cost_optimized", label: "Cost optimized" },
	{ value: "headroom", label: "Headroom" },
	{ value: "reset_window", label: "Reset window" },
	{ value: "reset_aware", label: "Reset aware" },
	{ value: "context_relay", label: "Context relay" },
	{ value: "context_optimized", label: "Context optimized" },
	{ value: "cache_optimized", label: "Cache optimized" },
	{ value: "lkgp", label: "Last known good provider" },
	{ value: "auto", label: "Auto" },
	{ value: "fusion", label: "Fusion" },
	{ value: "pipeline", label: "Pipeline" },
	{ value: "quota_weighted", label: "Quota weighted" },
];

const EXECUTION_FIELDS: {
	key: keyof PoolExecutionConfig;
	label: string;
	minimum: number;
	maximum: number;
}[] = [
	{
		key: "leg_timeout_ms",
		label: "Per-target timeout (ms)",
		minimum: 1,
		maximum: 30_000,
	},
	{
		key: "total_timeout_ms",
		label: "Total timeout (ms)",
		minimum: 1,
		maximum: 120_000,
	},
	{
		key: "max_output_bytes",
		label: "Output limit (bytes)",
		minimum: 1,
		maximum: 262_144,
	},
	{ key: "quorum", label: "Response quorum", minimum: 1, maximum: 8 },
	{ key: "grace_ms", label: "Quorum grace (ms)", minimum: 0, maximum: 5000 },
];

const AUTO_WEIGHT_FIELDS: { key: keyof AutoScoringWeights; label: string }[] = [
	{ key: "quota", label: "Quota" },
	{ key: "health", label: "Health" },
	{ key: "cost_inv", label: "Inverse cost" },
	{ key: "latency_inv", label: "Inverse latency" },
	{ key: "task_fit", label: "Task fit" },
	{ key: "stability", label: "Stability" },
	{ key: "tier_priority", label: "Tier priority" },
	{ key: "tier_affinity", label: "Tier affinity" },
	{ key: "specificity_match", label: "Specificity match" },
	{ key: "context_affinity", label: "Context affinity" },
	{ key: "cache_affinity", label: "Cache affinity" },
	{ key: "session_availability", label: "Session availability" },
	{ key: "reset_window_affinity", label: "Reset-window affinity" },
	{ key: "connection_density", label: "Connection density" },
	{ key: "quality", label: "Quality" },
	{ key: "reliability", label: "Reliability" },
];

const PROVIDER_LABELS = new Map<string, string>([
	["anthropic", "Anthropic"],
	["fireworks", "Fireworks AI"],
	["genai", "Gemini"],
	["local", "Local"],
	["mistral", "Mistral"],
	["huggingface", "Hugging Face"],
	["nvidia", "NVIDIA NIM"],
	["openai", "OpenAI"],
	// A donated OpenAI allowance is registered as its own id so its spend is never
	// mixed with the operator's `openai` key; name it apart from OpenAI here too
	// (same text as the modality routing editor in GatewayDialog).
	["openai-credits", "OpenAI (donated credits)"],
	["openrouter", "OpenRouter"],
	["qwen", "Qwen"],
	["together", "Together AI"],
]);

function providerLabel(id: string): string {
	return PROVIDER_LABELS.get(id) ?? id;
}

function strategyLabel(strategy: Pool["strategy"]): string {
	return STRATEGIES.find((item) => item.value === strategy)?.label ?? strategy;
}

export function ProviderPoolsEditor({
	pools,
	modelMap,
	providers,
	disabled,
	onSave,
	supportedStrategies,
}: {
	pools: NonNullable<GatewayRoutingConfig["provider_pools"]>;
	modelMap: GatewayRoutingConfig["model_map"];
	providers: string[];
	disabled: boolean;
	onSave: (name: string, pool: Pool | null) => Promise<void>;
	supportedStrategies?: readonly ProviderPoolStrategy[];
}) {
	const advertisedStrategies =
		supportedProviderPoolStrategies(supportedStrategies);
	const strategyOptions = STRATEGIES.filter((item) =>
		advertisedStrategies.includes(item.value)
	);
	const [editing, setEditing] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [strategy, setStrategy] = useState<Pool["strategy"]>("round_robin");
	const [stickyLimit, setStickyLimit] = useState(1);
	const [cooldownWaitMs, setCooldownWaitMs] = useState(0);
	const [members, setMembers] = useState<DraftMember[]>([]);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [execution, setExecution] = useState<PoolExecutionConfig>({
		...DEFAULT_POOL_EXECUTION,
	});
	const [judgeProvider, setJudgeProvider] = useState("");
	const [judgeModel, setJudgeModel] = useState("");
	const [autoWeights, setAutoWeights] =
		useState<Partial<AutoScoringWeights> | null>(null);
	const strategySupported = strategyOptions.some(
		(item) => item.value === strategy
	);
	const controlsDisabled = disabled || (editing !== "" && !strategySupported);
	const multiTarget = strategy === "fusion" || strategy === "pipeline";

	const startCreate = () => {
		setEditing("");
		setName("");
		setStrategy(
			strategyOptions.find((item) => item.value === "round_robin")?.value ??
				strategyOptions[0]?.value ??
				"round_robin"
		);
		setStickyLimit(1);
		setCooldownWaitMs(0);
		setMembers([]);
		setError(null);
		setNotice(null);
		setExecution({ ...DEFAULT_POOL_EXECUTION });
		setJudgeProvider("");
		setJudgeModel("");
		setAutoWeights(null);
	};

	const startEdit = (poolName: string) => {
		const pool = pools[poolName];
		if (!pool) {
			return;
		}
		setEditing(poolName);
		setName(poolName);
		setStrategy(pool.strategy);
		setStickyLimit(pool.sticky_limit ?? 1);
		setCooldownWaitMs(pool.wait_for_cooldown_ms ?? 0);
		setExecution({ ...DEFAULT_POOL_EXECUTION, ...pool.execution });
		setJudgeProvider(pool.judge?.provider ?? "");
		setJudgeModel(pool.judge?.model ?? "");
		setAutoWeights(pool.auto_weights == null ? null : { ...pool.auto_weights });
		setMembers(
			pool.members.map((member) => ({ ...member, id: crypto.randomUUID() }))
		);
		setError(null);
		setNotice(null);
	};

	const updateMember = (id: string, patch: Partial<PoolMember>) => {
		setMembers((current) =>
			current.map((member) =>
				member.id === id ? { ...member, ...patch } : member
			)
		);
	};

	const addMember = () => {
		const selected =
			providers.find(
				(provider) => !members.some((member) => member.provider === provider)
			) ?? providers[0];
		if (!selected) {
			return;
		}
		setMembers((current) => [
			...current,
			{
				id: crypto.randomUUID(),
				provider: selected,
				model: "",
				priority: 0,
				weight: 1,
				enabled: true,
				last_resort: false,
			},
		]);
	};

	const save = async () => {
		if (!strategySupported) {
			setError(
				"This node does not advertise support for this strategy. The existing pool is read-only."
			);
			return;
		}
		const normalized = name.trim();
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(normalized)) {
			setError(
				"Use 1–64 letters, numbers, hyphens, or underscores for the pool name."
			);
			return;
		}
		if (editing === "" && pools[normalized]) {
			setError("A pool with that name already exists.");
			return;
		}
		if (members.length === 0 || !members.some((member) => member.enabled)) {
			setError("Add at least one enabled provider.");
			return;
		}
		if (
			!Number.isInteger(stickyLimit) ||
			stickyLimit < 1 ||
			stickyLimit > 100
		) {
			setError("Round-robin batch size must be 1–100.");
			return;
		}
		if (
			new Set(
				members.map((member) =>
					JSON.stringify([member.provider, member.model.trim()])
				)
			).size !== members.length
		) {
			setError(
				"Each exact provider/model target can appear only once in a pool."
			);
			return;
		}
		if (
			!Number.isInteger(cooldownWaitMs) ||
			cooldownWaitMs < 0 ||
			cooldownWaitMs > 30_000
		) {
			setError("Cooldown wait must be 0–30,000 milliseconds.");
			return;
		}
		for (const member of members) {
			if (!(providers.includes(member.provider) && member.model.trim())) {
				setError(
					"Choose a connected chat provider and enter its exact model ID."
				);
				return;
			}
			if (
				!Number.isInteger(member.priority) ||
				member.priority < 0 ||
				member.priority > 255 ||
				!Number.isInteger(member.weight) ||
				member.weight < (member.enabled ? 1 : 0) ||
				member.weight > 65_535
			) {
				setError(
					"Priority must be 0–255 and enabled members need a positive weight."
				);
				return;
			}
		}
		const previous = editing ? pools[editing] : undefined;
		const nextPool: Pool = {
			...previous,
			strategy,
			sticky_limit: strategy === "round_robin" ? stickyLimit : 1,
			wait_for_cooldown_ms: cooldownWaitMs,
			members: members.map(({ id: _id, ...member }) => ({
				...member,
				model: member.model.trim(),
			})),
			...(multiTarget ? { execution: { ...execution } } : undefined),
			...(strategy === "auto"
				? autoWeights == null
					? previous?.auto_weights
						? { auto_weights: null }
						: {}
					: { auto_weights: { ...autoWeights } }
				: undefined),
			...(strategy === "fusion"
				? { judge: { provider: judgeProvider, model: judgeModel.trim() } }
				: previous?.judge
					? { judge: null }
					: {}),
		};
		const settingsError = providerPoolSettingsError(nextPool);
		if (
			settingsError ||
			(strategy === "fusion" && !providers.includes(judgeProvider))
		) {
			setError(
				settingsError ??
					"Choose a connected chat provider for the fusion judge."
			);
			return;
		}
		setSaving(true);
		setError(null);
		try {
			await onSave(normalized, nextPool);
			setEditing(null);
			setNotice(
				`Saved ${normalized}. Map a chat model to pool:${normalized}, then restart Gateway.`
			);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not save the pool."
			);
		} finally {
			setSaving(false);
		}
	};

	const remove = async (poolName: string) => {
		const alias = `pool:${poolName}`;
		if (Object.values(modelMap).some((mapping) => mapping.provider === alias)) {
			setError(`Remove model mappings to ${alias} before deleting this pool.`);
			return;
		}
		setSaving(true);
		setError(null);
		try {
			await onSave(poolName, null);
			setEditing(null);
			setNotice(`Removed ${poolName}. Restart Gateway to apply the change.`);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not remove the pool."
			);
		} finally {
			setSaving(false);
		}
	};

	const poolEntries = Object.entries(pools);
	return (
		<SettingsSection
			caption={
				<>
					Choose the exact upstream model for each provider. Sessions stay on
					one member to reuse its prompt cache. Gateway restart required after
					changes. A rate-limited pool member cools down, and plain chat retries
					another eligible member in the same request.
				</>
			}
			headerAction={
				<Button
					disabled={
						disabled ||
						providers.length === 0 ||
						Object.keys(pools).length >= 128 ||
						strategyOptions.length === 0
					}
					onClick={startCreate}
					size="sm"
					variant="ghost"
				>
					Create pool
				</Button>
			}
			title="Direct chat pools"
		>
			{poolEntries.length > 0 ? (
				<SettingsGroup>
					{poolEntries.map(([poolName, pool]) => (
						<SettingsItem
							actions={
								<div className="flex flex-wrap items-center gap-2">
									<Badge variant="secondary">pool:{poolName}</Badge>
									<Button
										aria-label={`Edit pool ${poolName}`}
										disabled={disabled || saving}
										onClick={() => startEdit(poolName)}
										size="sm"
										variant="ghost"
									>
										Edit
									</Button>
									<Button
										aria-label={`Remove pool ${poolName}`}
										disabled={disabled || saving}
										onClick={() => remove(poolName)}
										size="sm"
										variant="ghost"
									>
										Remove
									</Button>
								</div>
							}
							key={poolName}
							title={
								<span className="block min-w-0">
									<span className="block truncate" title={poolName}>
										{poolName}
									</span>
									<span className="mt-0.5 block text-muted-foreground text-xs">
										{strategyLabel(pool.strategy)} ·{" "}
										{pool.strategy === "round_robin" &&
										(pool.sticky_limit ?? 1) > 1
											? `${pool.sticky_limit} new sessions per member · `
											: null}
										{pool.members.filter((member) => member.enabled).length}{" "}
										active members
									</span>
								</span>
							}
						/>
					))}
				</SettingsGroup>
			) : editing === null ? (
				<SettingsCard className="text-center text-muted-foreground text-sm">
					No direct chat pools yet.
				</SettingsCard>
			) : null}
			{editing === null ? null : (
				<SettingsCard className="flex flex-col gap-4">
					{strategySupported ? null : (
						<p className="text-sm text-status-warning" role="status">
							This node does not advertise this strategy. Its saved settings are
							shown read-only.
						</p>
					)}
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="provider-pool-name">Pool name</Label>
							<Input
								disabled={disabled || editing !== ""}
								id="provider-pool-name"
								onChange={(event) => setName(event.target.value)}
								value={name}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="provider-pool-strategy">Routing strategy</Label>
							<Select
								disabled={controlsDisabled}
								items={strategyOptions}
								onValueChange={(value) => {
									const option = strategyOptions.find(
										(item) => item.value === value
									);
									if (option) {
										setStrategy(option.value);
									}
								}}
								value={strategy}
							>
								<SelectTrigger id="provider-pool-strategy">
									<SelectValue>{strategyLabel(strategy)}</SelectValue>
								</SelectTrigger>
								<SelectContent
									align="start"
									alignItemWithTrigger={false}
									className="min-w-52"
								>
									{strategyOptions.map((item) => (
										<SelectItem key={item.value} value={item.value}>
											{item.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						{strategy === "round_robin" ? (
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="provider-pool-sticky-limit">
									New sessions per member
								</Label>
								<Input
									disabled={controlsDisabled}
									id="provider-pool-sticky-limit"
									max={100}
									min={1}
									onChange={(event) =>
										setStickyLimit(Number(event.target.value))
									}
									type="number"
									value={stickyLimit}
								/>
								<p className="text-muted-foreground text-xs">
									Assign this many new sessions before rotating. Existing
									sessions stay on their member.
								</p>
							</div>
						) : null}
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="provider-pool-cooldown-wait">
								Cooldown wait (ms)
							</Label>
							<Input
								disabled={controlsDisabled}
								id="provider-pool-cooldown-wait"
								max={30_000}
								min={0}
								onChange={(event) =>
									setCooldownWaitMs(Number(event.target.value))
								}
								step={100}
								type="number"
								value={cooldownWaitMs}
							/>
							<p className="text-muted-foreground text-xs">
								Wait briefly for a known cooldown when every member is
								unavailable. Zero fails immediately; cancelling the request
								cancels its wait.
							</p>
						</div>
					</div>
					<p className="text-muted-foreground text-xs">
						Cost, quota and context measurements can be unknown or stale.
						Missing evidence is not zero cost, unused quota or unlimited
						context; the Gateway applies its supported fallback.
					</p>
					{strategy === "auto" ? (
						<details className="border-border/60 border-t pt-3">
							<summary className="cursor-pointer font-medium text-sm">
								Advanced Auto scoring weights
							</summary>
							<div className="mt-3 space-y-3">
								<p className="text-muted-foreground text-xs">
									Weights change ranking, not the reported signals. With no
									custom configuration, the full pinned default set applies. In
									a custom partial configuration, unset fields are zero. Values
									must be finite, 0–1,000, with a positive total.
								</p>
								<div className="flex items-center gap-2">
									<Switch
										checked={autoWeights !== null}
										disabled={controlsDisabled}
										id="pool-auto-custom"
										onCheckedChange={(checked) =>
											setAutoWeights(
												checked ? { ...DEFAULT_POOL_AUTO_WEIGHTS } : null
											)
										}
									/>
									<Label htmlFor="pool-auto-custom">
										Customize Auto weights
									</Label>
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
					) : null}
					{multiTarget ? (
						<section
							aria-label="Multi-target execution"
							className="space-y-3 border-border/60 border-t pt-3"
						>
							<p className="font-medium text-sm">
								{strategy === "fusion"
									? "Fusion execution"
									: "Pipeline execution"}
							</p>
							<p className="text-muted-foreground text-xs">
								{strategy === "fusion"
									? "Collect independent text responses, then synthesize with the judge. Tool-bearing requests are sent directly to the judge rather than running multiple tool legs."
									: "Run text targets in member order within the total deadline."}{" "}
								Each accepted target call can incur its own provider charge,
								including the fusion judge. At most eight targets can be
								enabled.
							</p>
							<div className="grid gap-3 sm:grid-cols-2">
								{EXECUTION_FIELDS.map((field) => (
									<div className="space-y-1.5" key={field.key}>
										<Label htmlFor={`pool-execution-${field.key}`}>
											{field.label}
										</Label>
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
					) : null}
					<div className="flex flex-col items-start gap-2 border-border/60 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
						<div>
							<Label>Provider members</Label>
							<p className="text-muted-foreground text-xs">
								Lower priority numbers run first. Weights apply to weighted
								random selection and legacy weighted rotation.
							</p>
							<p
								className="text-muted-foreground text-xs"
								id="pool-context-help"
							>
								Context capacity is a model limit; leave it blank when unknown.
								Models sharing a provider do not have separate account quota
								pools.
							</p>
						</div>
						<Button
							disabled={
								controlsDisabled ||
								providers.length === 0 ||
								members.length >= 32
							}
							onClick={addMember}
							size="sm"
							variant="ghost"
						>
							Add provider
						</Button>
					</div>
					{members.map((member, index) => (
						<div
							className="grid items-end gap-2 border-border/60 border-t pt-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_7rem_5rem_5rem_auto_auto]"
							key={member.id}
						>
							<div className="flex flex-col gap-1">
								<Label htmlFor={`pool-provider-${member.id}`}>
									Provider {index + 1}
								</Label>
								<div className="flex items-center gap-1.5">
									<ProviderBrandLogo providerKey={member.provider} size={16} />
									<Select
										disabled={controlsDisabled}
										items={providers.map((provider) => ({
											value: provider,
											label: providerLabel(provider),
										}))}
										onValueChange={(value) =>
											value && updateMember(member.id, { provider: value })
										}
										value={member.provider}
									>
										<SelectTrigger id={`pool-provider-${member.id}`}>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{providers.map((provider) => (
												<SelectItem key={provider} value={provider}>
													<span className="flex items-center gap-2">
														<ProviderBrandLogo
															providerKey={provider}
															size={14}
														/>
														{providerLabel(provider)}
													</span>
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor={`pool-model-${member.id}`}>
									Upstream model
								</Label>
								<Input
									disabled={controlsDisabled}
									id={`pool-model-${member.id}`}
									onChange={(event) =>
										updateMember(member.id, { model: event.target.value })
									}
									placeholder="Exact model ID"
									value={member.model}
								/>
							</div>
							<div className="space-y-1">
								<Label htmlFor={`pool-context-${member.id}`}>
									Context tokens
								</Label>
								<Input
									aria-describedby="pool-context-help"
									disabled={controlsDisabled}
									id={`pool-context-${member.id}`}
									max={2_000_000}
									min={1}
									onChange={(event) =>
										updateMember(member.id, {
											context_tokens:
												event.target.value.trim() === ""
													? undefined
													: Number(event.target.value),
										})
									}
									placeholder="Unknown"
									type="number"
									value={member.context_tokens ?? ""}
								/>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor={`pool-priority-${member.id}`}>Priority</Label>
								<Input
									disabled={controlsDisabled}
									id={`pool-priority-${member.id}`}
									max={255}
									min={0}
									onChange={(event) =>
										updateMember(member.id, {
											priority: Number(event.target.value),
										})
									}
									type="number"
									value={member.priority}
								/>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor={`pool-weight-${member.id}`}>Weight</Label>
								<Input
									disabled={controlsDisabled}
									id={`pool-weight-${member.id}`}
									max={65_535}
									min={0}
									onChange={(event) =>
										updateMember(member.id, {
											weight: Number(event.target.value),
										})
									}
									type="number"
									value={member.weight}
								/>
							</div>
							<div className="flex flex-col items-center gap-1">
								<Label htmlFor={`pool-enabled-${member.id}`}>On</Label>
								<Switch
									checked={member.enabled}
									disabled={controlsDisabled}
									id={`pool-enabled-${member.id}`}
									onCheckedChange={(enabled) =>
										updateMember(member.id, { enabled })
									}
								/>
							</div>
							<Button
								aria-label={`Remove ${member.provider} from pool`}
								disabled={controlsDisabled}
								onClick={() =>
									setMembers((current) =>
										current.filter((item) => item.id !== member.id)
									)
								}
								size="sm"
								variant="ghost"
							>
								Remove
							</Button>
							<div className="flex flex-col gap-1 sm:col-span-full">
								<div className="flex items-center gap-2">
									<Switch
										checked={member.last_resort ?? false}
										disabled={controlsDisabled}
										id={`pool-last-resort-${member.id}`}
										onCheckedChange={(lastResort) =>
											updateMember(member.id, { last_resort: lastResort })
										}
									/>
									<Label htmlFor={`pool-last-resort-${member.id}`}>
										Last resort
									</Label>
								</div>
								<p className="text-muted-foreground text-xs">
									Use after regular members are unavailable. Active sessions
									stay on this member while healthy.
								</p>
							</div>
						</div>
					))}
					<div className="flex items-center gap-2">
						<Button
							disabled={controlsDisabled || saving}
							loading={saving}
							onClick={() => save()}
							size="sm"
						>
							Save pool
						</Button>
						<Button onClick={() => setEditing(null)} size="sm" variant="ghost">
							Cancel
						</Button>
					</div>
				</SettingsCard>
			)}
			{error ? (
				<p className="px-3.5 text-status-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
			{notice ? (
				<p className="px-3.5 text-status-success text-xs" role="status">
					{notice}
				</p>
			) : null}
		</SettingsSection>
	);
}
