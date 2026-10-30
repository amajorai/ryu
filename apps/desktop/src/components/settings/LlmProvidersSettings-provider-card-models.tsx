import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { ModelPicker } from "./LlmProvidersSettings-model-picker.tsx";
import type { ProviderCardState } from "./LlmProvidersSettings-provider-card-state.ts";

/** Model picker, per-model toggles, thinking level, and activation. */
export function ProviderModelsSection({ state }: { state: ProviderCardState }) {
	const tl = useLiteralMessages();
	const {
		activateLabel,
		activating,
		activationIsCurrent,
		allModelsEnabled,
		discovering,
		handleActivate,
		handleToggleAllModels,
		handleToggleModel,
		isChatgptPlan,
		model,
		modelOptions,
		provider,
		runDiscovery,
		setModel,
		setThinkingLevel,
		source,
		thinkingLevel,
		thinkingLevels,
		togglingModel,
	} = state;
	return (
		<>
			<ModelPicker
				busy={discovering}
				idPrefix={provider.id}
				model={model}
				onModelChange={setModel}
				options={modelOptions}
				source={source}
			/>

			{modelOptions.length > 0 ? (
				<div className="flex flex-col gap-1.5">
					<div className="flex items-center justify-between gap-2">
						<Label>Enabled models</Label>
						<div className="flex items-center gap-2">
							<span className="text-detail text-muted-foreground">
								{allModelsEnabled ? "All enabled" : "Some disabled"}
							</span>
							<Switch
								aria-label={tl("Enable all {label} models", {
									label: provider.label,
								})}
								checked={allModelsEnabled}
								disabled={togglingModel !== null}
								onCheckedChange={handleToggleAllModels}
							/>
						</div>
					</div>
					<div className="flex max-h-48 flex-col overflow-y-auto">
						{modelOptions.map((m) => {
							// Absent from the overrides map ⇒ enabled by default.
							const enabled = provider.modelOverrides?.[m.id] !== false;
							return (
								<div
									className="flex min-h-9 items-center justify-between gap-2"
									key={m.id}
								>
									<span className="min-w-0 truncate text-sm">
										{m.name ?? m.id}
									</span>
									<Switch
										aria-label={tl("Enable {label} model {model}", {
											label: provider.label,
											model: m.name ?? m.id,
										})}
										checked={enabled}
										disabled={
											togglingModel === "__all__" || togglingModel === m.id
										}
										onCheckedChange={(next) => handleToggleModel(m.id, next)}
									/>
								</div>
							);
						})}
					</div>
				</div>
			) : null}

			<div className="flex flex-wrap items-end justify-between gap-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`thinking-${provider.id}`}>Thinking level</Label>
					<Select
						items={[
							{ value: "", label: "Provider default" },
							...thinkingLevels.map((l) => ({ value: l, label: l })),
						]}
						onValueChange={(v) => setThinkingLevel(v ?? "")}
						value={thinkingLevel}
					>
						<SelectTrigger className="w-44" id={`thinking-${provider.id}`}>
							<SelectValue placeholder="Provider default" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="">Provider default</SelectItem>
							{thinkingLevels.map((l) => (
								<SelectItem key={l} value={l}>
									{l}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="flex items-center gap-2">
					{provider.supportsDiscovery === false ? null : (
						<Button
							disabled={discovering}
							onClick={runDiscovery}
							size="sm"
							variant="ghost"
						>
							{discovering ? "Loading…" : "Discover models"}
						</Button>
					)}
					<Button
						disabled={
							activating ||
							activationIsCurrent ||
							((provider.custom || isChatgptPlan) && model.trim() === "")
						}
						onClick={handleActivate}
						size="sm"
						variant="mono"
					>
						{activateLabel(activating)}
					</Button>
				</div>
			</div>
		</>
	);
}
