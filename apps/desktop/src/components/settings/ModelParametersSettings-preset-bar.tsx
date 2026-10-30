// apps/desktop/src/components/settings/ModelParametersSettings-preset-bar.tsx
//
// Node preset controls (apply, save, update, delete) for the selected model.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	applyInferencePreset,
	createInferencePreset,
	deleteInferencePreset,
	getModelLaunchConfig,
	type InferencePreset,
	listInferencePresets,
	type PresetTarget,
	type SamplingConfig,
	updateInferencePreset,
} from "@/src/lib/api/inference.ts";
import {
	errorMessage,
	type ModelKind,
	type SelectedModel,
} from "./ModelParametersSettings-model-selection.ts";
import { SettingsCard } from "./shared/settings-items.tsx";

export function presetsQueryKey(url: string) {
	return ["inference", "presets", url];
}

export function presetFitsKind(
	preset: InferencePreset,
	kind: ModelKind
): boolean {
	return preset.target === "any" || preset.target === kind;
}

/** Apply, save, update, and delete node presets for the selected model. */
export function PresetBar({
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
	const tl = useLiteralMessages();
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
			sileo.success({
				title: tl("Applied “{name}” to {label}", {
					name: preset.name,
					label: model.label,
				}),
			});
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
			sileo.success({
				title: tl("Saved preset “{name}”", { name: preset.name }),
			});
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
			sileo.success({
				title: tl("Updated preset “{name}”", { name: preset.name }),
			});
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
		<SettingsCard className="flex flex-col gap-3 py-3">
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
									{preset.builtin
										? tl("{name} (built-in)", { name: preset.name })
										: preset.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button
						disabled={!selected || busy}
						loading={apply.isPending}
						onClick={() => selected && apply.mutate(selected)}
						size="sm"
						variant="outline"
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
								variant="ghost-muted"
							>
								Update from current
							</Button>
							<Button
								disabled={busy}
								loading={remove.isPending}
								onClick={() => remove.mutate(selected)}
								size="sm"
								variant="ghost-muted"
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
							variant="ghost-muted"
						>
							Save as preset
						</Button>
					)}
				</div>
				{selected?.description ? (
					<p className="text-detail text-muted-foreground">
						{selected.description}
					</p>
				) : null}
				{presetsQuery.isError ? (
					<p className="text-detail text-status-destructive" role="alert">
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
							variant="mono"
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
						<Label className="flex items-center gap-2 font-normal text-sm">
							<Checkbox
								checked={includeLaunch}
								onCheckedChange={(checked) =>
									setIncludeLaunch(checked === true)
								}
							/>
							Include this model's saved launch settings
						</Label>
					) : null}
				</form>
			) : null}
			<p className="text-detail text-muted-foreground">
				Saved on this node. Applying skips any parameter the model does not
				accept.
			</p>
		</SettingsCard>
	);
}
