// apps/desktop/src/components/settings/ModelParametersSettings.tsx
//
// Per-model parameters for local AND cloud models, plus node-level presets.
//
// Pick a local engine model or a cloud provider model, then tune exactly the
// sampling fields that model receives: Core reports the list per local engine
// or per cloud provider (`/api/inference/sampling-fields`), so llama.cpp shows
// every sampler while Anthropic shows Temperature / Top P / Top K. Local models
// also get their engine-launch settings (context size, GPU layers, ...).
//
// Presets are named parameter bundles stored once on the active node
// (`/api/inference/presets`). Applying one saves its values to the selected
// model, keeping only the fields that model accepts, so one preset serves both
// a llama.cpp model and a cloud model.

import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { sileo } from "sileo";
import { AgentModelPickerField } from "@/components/agent-elements/input/agent-model-picker-field.tsx";
import { AdvancedInferenceSection } from "@/src/components/inference/AdvancedInferenceSection.tsx";
import { ModelLaunchConfigSection } from "@/src/components/inference/ModelLaunchConfigSection.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useEngineModels } from "@/src/hooks/useEngineModels.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	applyInferencePreset,
	createInferencePreset,
	deleteInferencePreset,
	getModelLaunchConfig,
	getModelSamplingConfig,
	getSamplingFieldSupport,
	type InferencePreset,
	listInferencePresets,
	type PresetTarget,
	type SamplingConfig,
	saveModelSamplingConfig,
	updateInferencePreset,
} from "@/src/lib/api/inference.ts";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

/** Engine ids Core resolves to a local runtime (`Engine::from_name`). */
export const LOCAL_ENGINE_IDS = new Set([
	"llamacpp",
	"ollama",
	"vllm",
	"sglang",
	"mlx",
	"mlx-vlm",
	"mlx-serve",
	"omlx",
	"apfel",
	"mesh-llm",
]);

export type ModelKind = "local" | "cloud";

export interface SelectedModel {
	/** Local engine id, for local models. */
	engine?: string;
	id: string;
	kind: ModelKind;
	label: string;
	/** Catalog provider id, for cloud models. */
	provider?: string;
}

const LOCAL_KEY_SEPARATOR = "\u0000";

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

export function presetsQueryKey(url: string) {
	return ["inference", "presets", url];
}

function LocalModelSelect({
	onSelect,
	value,
}: {
	onSelect: (model: SelectedModel) => void;
	value: SelectedModel | null;
}) {
	const engineModels = useEngineModels();
	const groups = useMemo(
		() =>
			Object.entries(engineModels)
				.filter(
					([engine, models]) => LOCAL_ENGINE_IDS.has(engine) && models.length
				)
				.sort(([a], [b]) => a.localeCompare(b)),
		[engineModels]
	);
	const selectedKey =
		value?.kind === "local" && value.engine
			? `${value.engine}${LOCAL_KEY_SEPARATOR}${value.id}`
			: null;

	if (groups.length === 0) {
		return (
			<p className="text-muted-foreground text-sm">
				No local models found on this node. Install one from Store → Models.
			</p>
		);
	}

	return (
		<Select
			onValueChange={(key: string | null) => {
				if (!key) {
					return;
				}
				const [engine, id] = key.split(LOCAL_KEY_SEPARATOR);
				const model = engineModels[engine]?.find((m) => m.id === id);
				if (engine && id) {
					onSelect({
						engine,
						id,
						kind: "local",
						label: model?.name ?? id,
					});
				}
			}}
			value={selectedKey}
		>
			<SelectTrigger aria-label="Local model" className="h-8 w-full">
				<SelectValue placeholder="Select a local model">
					{value?.kind === "local" ? value.label : undefined}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{groups.map(([engine, models]) => (
					<SelectGroup key={engine}>
						<SelectLabel>{engine}</SelectLabel>
						{models.map((model) => (
							<SelectItem
								key={`${engine}:${model.id}`}
								value={`${engine}${LOCAL_KEY_SEPARATOR}${model.id}`}
							>
								{model.name || model.id}
							</SelectItem>
						))}
					</SelectGroup>
				))}
			</SelectContent>
		</Select>
	);
}

export function presetFitsKind(
	preset: InferencePreset,
	kind: ModelKind
): boolean {
	return preset.target === "any" || preset.target === kind;
}

/** Apply, save, update, and delete node presets for the selected model. */
function PresetBar({
	draft,
	fields,
	model,
	onApplied,
	target,
}: {
	draft: SamplingConfig;
	fields: ReadonlySet<string>;
	model: SelectedModel;
	onApplied: (sampling: SamplingConfig) => void;
	target: ApiTarget;
}) {
	const queryClient = useQueryClient();
	const queryKey = presetsQueryKey(target.url);
	const presetsQuery = useQuery({
		queryKey,
		queryFn: () => listInferencePresets(target),
	});
	const presets = (presetsQuery.data ?? []).filter((preset) =>
		presetFitsKind(preset, model.kind)
	);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const selected = presets.find((preset) => preset.id === selectedId) ?? null;
	const [name, setName] = useState("");
	const [includeLaunch, setIncludeLaunch] = useState(false);
	const [savingAs, setSavingAs] = useState(false);
	const isLocal = model.kind === "local";

	const refresh = () =>
		queryClient.invalidateQueries({ queryKey }).catch(() => undefined);

	const apply = useMutation({
		mutationFn: (preset: InferencePreset) =>
			applyInferencePreset(
				target,
				{ id: model.id, local: isLocal },
				preset,
				fields
			),
		onSuccess: (sampling, preset) => {
			queryClient
				.invalidateQueries({ queryKey: ["models", "launch-config", model.id] })
				.catch(() => undefined);
			onApplied(sampling);
			sileo.success({ title: `Applied “${preset.name}” to ${model.label}` });
		},
		onError: (error) =>
			sileo.error({
				title: "Could not apply preset",
				description: errorMessage(error, "Try again."),
			}),
	});

	const presetInput = async (presetName: string, kind: PresetTarget) => ({
		name: presetName,
		sampling: draft,
		target: kind,
		launch:
			isLocal && includeLaunch
				? await getModelLaunchConfig(target, model.id)
				: undefined,
	});

	const saveAs = useMutation({
		mutationFn: async () =>
			createInferencePreset(target, await presetInput(name, model.kind)),
		onSuccess: async (preset) => {
			await refresh();
			setSelectedId(preset.id);
			setSavingAs(false);
			setName("");
			sileo.success({ title: `Saved preset “${preset.name}”` });
		},
		onError: (error) =>
			sileo.error({
				title: "Could not save preset",
				description: errorMessage(error, "Try again."),
			}),
	});

	const overwrite = useMutation({
		mutationFn: async (preset: InferencePreset) =>
			updateInferencePreset(target, preset.id, {
				...(await presetInput(preset.name, preset.target)),
				description: preset.description,
			}),
		onSuccess: async (preset) => {
			await refresh();
			sileo.success({ title: `Updated preset “${preset.name}”` });
		},
		onError: (error) =>
			sileo.error({
				title: "Could not update preset",
				description: errorMessage(error, "Try again."),
			}),
	});

	const remove = useMutation({
		mutationFn: (preset: InferencePreset) =>
			deleteInferencePreset(target, preset.id),
		onSuccess: async () => {
			setSelectedId(null);
			await refresh();
		},
		onError: (error) =>
			sileo.error({
				title: "Could not delete preset",
				description: errorMessage(error, "Try again."),
			}),
	});

	const busy =
		apply.isPending ||
		saveAs.isPending ||
		overwrite.isPending ||
		remove.isPending;

	return (
		<SettingsCard className="flex flex-col gap-3">
			<div className="flex flex-col gap-1.5">
				<Label size="compact" tone="muted">
					Preset
				</Label>
				<div className="flex flex-wrap items-center gap-2">
					<Select
						onValueChange={(id: string | null) => setSelectedId(id)}
						value={selectedId}
					>
						<SelectTrigger aria-label="Preset" className="h-8 min-w-48 flex-1">
							<SelectValue
								placeholder={
									presetsQuery.isLoading
										? "Loading presets…"
										: "Choose a preset"
								}
							>
								{selected?.name}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{presets.map((preset) => (
								<SelectItem key={preset.id} value={preset.id}>
									{preset.builtin ? `${preset.name} (built-in)` : preset.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button
						disabled={!selected || busy}
						loading={apply.isPending}
						onClick={() => selected && apply.mutate(selected)}
						size="sm"
					>
						Apply
					</Button>
					{selected && !selected.builtin ? (
						<>
							<Button
								disabled={busy}
								loading={overwrite.isPending}
								onClick={() => overwrite.mutate(selected)}
								size="sm"
								variant="outline"
							>
								Update from current
							</Button>
							<Button
								disabled={busy}
								loading={remove.isPending}
								onClick={() => remove.mutate(selected)}
								size="sm"
								variant="ghost"
							>
								Delete
							</Button>
						</>
					) : null}
					{savingAs ? null : (
						<Button
							disabled={busy}
							onClick={() => setSavingAs(true)}
							size="sm"
							variant="outline"
						>
							Save as preset
						</Button>
					)}
				</div>
				{selected?.description ? (
					<p className="text-muted-foreground text-xs">
						{selected.description}
					</p>
				) : null}
				{presetsQuery.isError ? (
					<p className="text-status-destructive text-xs" role="alert">
						Could not load presets from this node.
					</p>
				) : null}
			</div>

			{savingAs ? (
				<form
					className="flex flex-col gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (name.trim()) {
							saveAs.mutate();
						}
					}}
				>
					<div className="flex flex-wrap items-center gap-2">
						<Input
							aria-label="Preset name"
							autoFocus
							className="h-8 min-w-48 flex-1"
							onChange={(event) => setName(event.target.value)}
							placeholder="Preset name"
							value={name}
						/>
						<Button
							disabled={!name.trim() || busy}
							loading={saveAs.isPending}
							size="sm"
							type="submit"
						>
							Save
						</Button>
						<Button
							onClick={() => setSavingAs(false)}
							size="sm"
							type="button"
							variant="ghost"
						>
							Cancel
						</Button>
					</div>
					{isLocal ? (
						<Label className="flex items-center gap-2 text-xs">
							<Checkbox
								checked={includeLaunch}
								onCheckedChange={(checked) =>
									setIncludeLaunch(checked === true)
								}
							/>
							Include this model's saved launch settings (context size, GPU
							layers, …)
						</Label>
					) : null}
				</form>
			) : null}
			<p className="text-muted-foreground text-xs">
				Presets are saved on this node. Saving captures the parameters below,
				including unsaved edits. Applying saves a preset to this model and skips
				any parameter the model does not accept.
			</p>
		</SettingsCard>
	);
}

export function ModelParameterEditor({
	model,
	target,
}: {
	model: SelectedModel;
	target: ApiTarget;
}) {
	const queryClient = useQueryClient();
	const samplingKey = ["models", "sampling-config", target.url, model.id];
	const supportQuery = useQuery({
		queryKey: [
			"inference",
			"sampling-fields",
			target.url,
			model.engine ?? "",
			model.provider ?? "",
		],
		queryFn: () =>
			getSamplingFieldSupport(target, {
				engine: model.engine,
				provider: model.provider,
			}),
		staleTime: 5 * 60 * 1000,
	});
	const samplingQuery = useQuery({
		queryKey: samplingKey,
		queryFn: () => getModelSamplingConfig(target, model.id),
	});
	const fields = useMemo(
		() => new Set(supportQuery.data?.fields ?? []),
		[supportQuery.data]
	);
	// Bumped when a preset replaces the saved values so the form remounts with
	// them (its JSON editors keep internal text state).
	const [revision, setRevision] = useState(0);
	const [draft, setDraft] = useState<SamplingConfig | null>(null);
	const value = draft ?? samplingQuery.data ?? {};

	const save = useMutation({
		mutationFn: (config: SamplingConfig) =>
			saveModelSamplingConfig(target, model.id, config),
		onSuccess: async () => {
			await queryClient
				.invalidateQueries({ queryKey: samplingKey })
				.catch(() => undefined);
		},
	});

	if (supportQuery.isLoading || samplingQuery.isLoading) {
		return (
			<div className="flex items-center gap-2 py-2 text-muted-foreground text-sm">
				<Spinner className="size-4" />
				Loading model parameters…
			</div>
		);
	}
	if (supportQuery.isError || samplingQuery.isError) {
		return (
			<div
				className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2"
				role="alert"
			>
				<p className="text-sm text-status-destructive">
					Could not load this model's parameters.
				</p>
				<Button
					onClick={() => {
						supportQuery.refetch().catch(() => undefined);
						samplingQuery.refetch().catch(() => undefined);
					}}
					size="sm"
					variant="outline"
				>
					Retry
				</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			<PresetBar
				draft={value}
				fields={fields}
				model={model}
				onApplied={(sampling) => {
					queryClient.setQueryData(samplingKey, sampling);
					setDraft(null);
					save.reset();
					setRevision((current) => current + 1);
				}}
				target={target}
			/>
			<AdvancedInferenceSection
				defaultOpen
				engineId={model.engine}
				key={`${model.id}:${revision}`}
				localEngine={model.kind === "local"}
				onChange={setDraft}
				onSave={() => save.mutate(value)}
				saved={save.isSuccess && draft === null}
				saveError={
					save.isError ? errorMessage(save.error, "Could not save") : null
				}
				saving={save.isPending}
				scope="model"
				supportedFields={fields}
				value={value}
			/>
			{model.kind === "local" ? (
				<ModelLaunchConfigSection
					key={model.id}
					modelId={model.id}
					subtitle={model.label}
				/>
			) : (
				<p className="rounded-md border border-dashed px-3 py-2 text-muted-foreground text-xs">
					Cloud models have no launch settings. These parameters apply when Ryu
					routes the chat through the gateway; external agents such as Claude
					Code or Codex use their own settings.
				</p>
			)}
		</div>
	);
}

export function ModelParametersSettings() {
	const node = useActiveNode();
	const target: ApiTarget = {
		url: node.url,
		token: node.token ?? null,
		userJwt: node.userJwt ?? null,
	};
	const [kind, setKind] = useState<ModelKind>("local");
	const [selected, setSelected] = useState<SelectedModel | null>(null);
	const current = selected?.kind === kind ? selected : null;

	return (
		<SettingsSection
			caption="Tune generation parameters for any local or cloud model on this node, and save reusable presets. Model parameters override engine defaults; agents and individual requests can still override them."
			title="Model parameters"
		>
			<SettingsCard className="flex flex-col gap-3">
				<ToggleGroup
					appearance="segmented"
					aria-label="Model type"
					onValueChange={(values: string[]) => {
						const next = values[0];
						if (next === "local" || next === "cloud") {
							setKind(next);
						}
					}}
					spacing={0}
					value={[kind]}
					variant="default"
				>
					<ToggleGroupItem density="segmented" value="local">
						Local models
					</ToggleGroupItem>
					<ToggleGroupItem density="segmented" value="cloud">
						Cloud models
					</ToggleGroupItem>
				</ToggleGroup>
				{kind === "local" ? (
					<LocalModelSelect onSelect={setSelected} value={current} />
				) : (
					<AgentModelPickerField
						ariaLabel="Cloud model"
						mode="model"
						onChange={(id) => setSelected({ id, kind: "cloud", label: id })}
						onModelPick={(provider, id) =>
							setSelected({
								id,
								kind: "cloud",
								label: id,
								provider: provider ?? undefined,
							})
						}
						placeholder="Select a cloud model"
						target={target}
						value={current?.id ?? ""}
					/>
				)}
			</SettingsCard>
			{current ? (
				<ModelParameterEditor
					key={`${current.kind}:${current.engine ?? current.provider ?? ""}:${current.id}`}
					model={current}
					target={target}
				/>
			) : null}
		</SettingsSection>
	);
}
