// apps/desktop/src/components/settings/ModelParametersSettings-local-model-select.tsx
//
// Local engine model picker for the model parameters settings.

import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { useMemo } from "react";
import { useEngineModels } from "@/src/hooks/useEngineModels.ts";
import {
	LOCAL_ENGINE_IDS,
	type SelectedModel,
} from "./ModelParametersSettings-model-selection.ts";

const LOCAL_KEY_SEPARATOR = "\u0000";

export function LocalModelSelect({
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
