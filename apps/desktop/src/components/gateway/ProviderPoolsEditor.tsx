import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { useState } from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	type AutoScoringWeights,
	DEFAULT_POOL_EXECUTION,
	type GatewayRoutingConfig,
	type PoolExecutionConfig,
	type ProviderPoolStrategy,
	providerPoolSettingsError,
	supportedProviderPoolStrategies,
} from "@/src/lib/api/gateway.ts";
import { ProviderPoolBasicsFields } from "./ProviderPoolsEditor-basics-fields.tsx";
import { ProviderPoolMemberRow } from "./ProviderPoolsEditor-member-row.tsx";
import {
	type DraftMember,
	type Pool,
	type PoolMember,
	STRATEGIES,
} from "./ProviderPoolsEditor-options.ts";
import { ProviderPoolListItem } from "./ProviderPoolsEditor-pool-list-item.tsx";
import {
	AutoWeightsDetails,
	MultiTargetExecutionSection,
} from "./ProviderPoolsEditor-strategy-sections.tsx";

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
	const tl = useLiteralMessages();
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
				tl(
					"Saved {normalized}. Map a chat model to pool:{normalized}, then restart Gateway.",
					{ normalized }
				)
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
			setError(
				tl("Remove model mappings to {alias} before deleting this pool.", {
					alias,
				})
			);
			return;
		}
		setSaving(true);
		setError(null);
		try {
			await onSave(poolName, null);
			setEditing(null);
			setNotice(
				tl("Removed {poolName}. Restart Gateway to apply the change.", {
					poolName,
				})
			);
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
						<ProviderPoolListItem
							disabled={disabled}
							key={poolName}
							pool={pool}
							poolName={poolName}
							remove={remove}
							saving={saving}
							startEdit={startEdit}
						/>
					))}
				</SettingsGroup>
			) : editing === null ? (
				<SettingsCard className="py-3 text-muted-foreground text-sm">
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
					<ProviderPoolBasicsFields
						controlsDisabled={controlsDisabled}
						cooldownWaitMs={cooldownWaitMs}
						disabled={disabled}
						editing={editing}
						name={name}
						setCooldownWaitMs={setCooldownWaitMs}
						setName={setName}
						setStickyLimit={setStickyLimit}
						setStrategy={setStrategy}
						stickyLimit={stickyLimit}
						strategy={strategy}
						strategyOptions={strategyOptions}
					/>
					<p className="text-muted-foreground text-xs">
						Cost, quota and context measurements can be unknown or stale.
						Missing evidence is not zero cost, unused quota or unlimited
						context; the Gateway applies its supported fallback.
					</p>
					{strategy === "auto" ? (
						<AutoWeightsDetails
							autoWeights={autoWeights}
							controlsDisabled={controlsDisabled}
							setAutoWeights={setAutoWeights}
						/>
					) : null}
					{multiTarget ? (
						<MultiTargetExecutionSection
							controlsDisabled={controlsDisabled}
							execution={execution}
							judgeModel={judgeModel}
							judgeProvider={judgeProvider}
							providerLabel={providerLabel}
							providers={providers}
							setExecution={setExecution}
							setJudgeModel={setJudgeModel}
							setJudgeProvider={setJudgeProvider}
							strategy={strategy}
						/>
					) : null}
					<div className="flex flex-col items-start gap-2 pt-4 sm:flex-row sm:items-center sm:justify-between">
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
						<ProviderPoolMemberRow
							controlsDisabled={controlsDisabled}
							index={index}
							key={member.id}
							member={member}
							providerLabel={providerLabel}
							providers={providers}
							setMembers={setMembers}
							updateMember={updateMember}
						/>
					))}
					<div className="flex items-center gap-2">
						<Button
							disabled={controlsDisabled || saving}
							loading={saving}
							onClick={() => save()}
							size="sm"
							variant="outline"
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
				<p className="px-3 text-status-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
			{notice ? (
				<p className="px-3 text-status-success text-xs" role="status">
					{notice}
				</p>
			) : null}
		</SettingsSection>
	);
}
