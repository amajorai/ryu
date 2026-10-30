import { SvglIcon } from "@ryu/blocks/web/svgl-icon.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Logo as RyuOrbLogo } from "@ryu/ui/components/logo.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import type { DiscoveredModel } from "@/src/lib/api/pi-config.ts";
import {
	isRyuManagedProvider,
	svglForProvider,
} from "@/src/lib/provider-brand.tsx";

interface ModelPickerProps {
	busy?: boolean;
	idPrefix: string;
	model: string;
	onModelChange: (v: string) => void;
	options: DiscoveredModel[];
	source: string | null;
}

// A model dropdown (discovered/suggested) above a free-text id box that always
// accepts a custom id. The `source` line subtly says whether the list came from
// a live discovery call or the built-in fallback.
export function ModelPicker({
	busy,
	idPrefix,
	model,
	onModelChange,
	options,
	source,
}: ModelPickerProps) {
	const ids = options.map((o) => o.id);
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={`${idPrefix}-model`}>Model</Label>
			{options.length > 0 ? (
				<Select
					items={options.map((o) => ({ value: o.id, label: o.name ?? o.id }))}
					onValueChange={(v) => onModelChange(v ?? "")}
					value={ids.includes(model) ? model : ""}
				>
					<SelectTrigger className="w-full" id={`${idPrefix}-model`}>
						<SelectValue placeholder="Pick a model" />
					</SelectTrigger>
					<SelectContent>
						{options.map((o) => (
							<SelectItem key={o.id} value={o.id}>
								{o.name ?? o.id}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			) : null}
			<Input
				id={
					options.length > 0 ? `${idPrefix}-model-custom` : `${idPrefix}-model`
				}
				onChange={(e) => onModelChange(e.target.value)}
				placeholder="Or type any model id"
				value={model}
			/>
			{busy ? (
				<span className="flex items-center gap-1.5 text-detail text-muted-foreground">
					<Spinner className="size-3.5" /> Discovering models…
				</span>
			) : (
				source && (
					<span className="text-detail text-muted-foreground">
						{source === "discovery"
							? "Models discovered live from the provider."
							: source === "unavailable"
								? "Models are unavailable. Check the connection and granted permissions."
								: source === "saved"
									? "Showing models saved from the last successful discovery."
									: source === "pi"
										? "Models from the installed Pi engine."
										: source === "models.dev"
											? "Models from the models.dev catalog."
											: "Showing suggested models (discovery unavailable)."}
					</span>
				)
			)}
		</div>
	);
}

/**
 * A provider's brand mark: a bundled brand logo when known, else its initial.
 * Just the logo — no border or background chrome. `SvglIcon` renders the
 * light/dark variant per theme for logos that ship both.
 */
export function ProviderBrandMark({
	label,
	providerKey,
}: {
	label: string;
	providerKey: string;
}) {
	if (isRyuManagedProvider(providerKey)) {
		return (
			<span className="flex size-8 shrink-0 items-center justify-center">
				<RyuOrbLogo size="20px" />
			</span>
		);
	}
	const spec = svglForProvider(providerKey);
	if (spec) {
		return (
			<span className="flex size-8 shrink-0 items-center justify-center">
				<SvglIcon className="object-contain" size={20} spec={spec} />
			</span>
		);
	}
	return (
		<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted font-medium text-muted-foreground text-xs">
			{label.slice(0, 1)}
		</span>
	);
}
