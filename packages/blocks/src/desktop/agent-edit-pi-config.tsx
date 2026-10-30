"use client";

import { CheckmarkBadge04Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import { PiModelPicker } from "./agent-edit-pi-model-picker.tsx";
import { SettingsCard, SettingsSection } from "./settings-items.tsx";

// ── Ryu Pi config (model + provider for the managed Pi) ───────────────────────

export interface PiProviderMeta {
	authKind?: string;
	configured?: boolean;
	id: string;
	label: string;
	/** "gateway" | "direct" — kept as a loose string to match Core's catalog. */
	routing?: string;
	suggestedModels?: string[];
}

/** One pickable model row for the Pi config searchable picker. */
export interface PiModelOption {
	group?: string | null;
	id: string;
	name: string;
}

/** A compact id/label option shared by the editor's injected selectors. */
export interface SlotOption {
	id: string;
	label: string;
}

export interface RyuPiConfigViewProps {
	apiKey?: string;
	apiTypeItems?: SlotOption[];
	canSave?: boolean;
	configDir?: string | null;
	customApi?: string;
	customBaseUrl?: string;
	/** Custom-provider fields. */
	customId?: string;
	error?: string | null;
	isCustomNew?: boolean;
	loading?: boolean;
	model?: string;
	/** Pickable models (grouped by provider). Renders a searchable picker above the free-text id box. */
	modelOptions?: PiModelOption[];
	/** True while provider model discovery is in flight. */
	modelsLoading?: boolean;
	onApiKeyChange?: (v: string) => void;
	onCustomApiChange?: (v: string) => void;
	onCustomBaseUrlChange?: (v: string) => void;
	onCustomIdChange?: (v: string) => void;
	onModelChange?: (v: string) => void;
	onProviderChange?: (v: string) => void;
	onSave?: () => void;
	onThinkingLevelChange?: (v: string) => void;
	/** Selected provider id (or the custom sentinel). */
	provider?: string;
	providerItems?: SlotOption[];
	/** "gateway" | "direct" — loose string to match Core's catalog payload. */
	routing?: string;
	saved?: boolean;
	saveError?: string | null;
	saving?: boolean;
	selectedMeta?: PiProviderMeta | null;
	showApiKey?: boolean;
	thinkingItems?: SlotOption[];
	thinkingLevel?: string;
}

function LabeledSelect({
	id,
	label,
	items,
	value,
	placeholder,
	onValueChange,
}: {
	id: string;
	label: string;
	items: SlotOption[];
	value: string;
	placeholder?: string;
	onValueChange?: (v: string) => void;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id}>{label}</Label>
			<Select
				items={items.map((i) => ({ value: i.id, label: i.label }))}
				onValueChange={(v) => onValueChange?.(v ?? "")}
				value={value}
			>
				<SelectTrigger className="w-full" id={id}>
					<SelectValue placeholder={placeholder} />
				</SelectTrigger>
				<SelectContent>
					{items.map((opt) => (
						<SelectItem key={opt.id} value={opt.id}>
							{opt.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

function CredentialHint({ meta }: { meta: PiProviderMeta }) {
	if (meta.configured) {
		return (
			<span className="flex items-center gap-1 text-muted-foreground text-xs">
				<HugeiconsIcon
					className="size-3 text-status-success"
					icon={CheckmarkBadge04Icon}
				/>
				Credential configured
			</span>
		);
	}
	let hint: string | null = null;
	if (meta.authKind === "api-key") {
		hint = "No credential yet — add an API key below.";
	} else if (meta.authKind === "subscription") {
		hint = "Subscription provider — sign in with Pi /login.";
	}
	if (!hint) {
		return null;
	}
	return <span className="text-muted-foreground text-xs">{hint}</span>;
}

/** Placeholder text for the model-id input, varying by options + routing. */
function modelIdPlaceholder(hasOptions: boolean, routing: string): string {
	if (hasOptions) {
		return "…or type a custom model id";
	}
	if (routing === "gateway") {
		return "Model id the Gateway routes (e.g. gpt-4o)";
	}
	return "Model id for this provider";
}

export function RyuPiConfigView({
	loading,
	error,
	routing = "gateway",
	configDir,
	provider = "",
	providerItems = [],
	selectedMeta,
	isCustomNew = false,
	customId = "",
	customApi = "openai-completions",
	customBaseUrl = "",
	apiTypeItems = [],
	model = "",
	modelOptions = [],
	modelsLoading = false,
	thinkingLevel = "",
	thinkingItems = [],
	showApiKey = false,
	apiKey = "",
	canSave = false,
	saving,
	saved,
	saveError,
	onProviderChange,
	onCustomIdChange,
	onCustomApiChange,
	onCustomBaseUrlChange,
	onModelChange,
	onThinkingLevelChange,
	onApiKeyChange,
	onSave,
}: RyuPiConfigViewProps) {
	const tl = useLiteralMessages();
	if (loading) {
		return (
			<div className="flex items-center gap-2 text-muted-foreground text-sm">
				<Spinner className="size-4" /> Loading Pi configuration…
			</div>
		);
	}
	if (error) {
		return (
			<div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-status-destructive">
				{tl("Failed to load Pi configuration: {error}", { error })}
			</div>
		);
	}

	return (
		<SettingsSection
			caption={
				<>
					The Ryu agent runs Core&apos;s own Pi against an isolated config
					(never your personal <code>~/.pi</code>). Pick the provider and model
					Pi should use.
				</>
			}
			headerAction={
				<Badge
					size="compact"
					variant={routing === "gateway" ? "default" : "secondary"}
				>
					{routing === "gateway" ? "Gateway governed" : "Direct egress"}
				</Badge>
			}
			title="Pi model & provider"
		>
			<SettingsCard className="flex flex-col gap-4">
				<div className="flex flex-col gap-1.5">
					<LabeledSelect
						id="pi-provider"
						items={providerItems}
						label="Provider"
						onValueChange={onProviderChange}
						placeholder="Select a provider"
						value={provider}
					/>
					{selectedMeta && !isCustomNew ? (
						<CredentialHint meta={selectedMeta} />
					) : null}
				</div>

				{isCustomNew ? (
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="pi-custom-id">Provider id</Label>
							<Input
								id="pi-custom-id"
								onChange={(e) => onCustomIdChange?.(e.target.value)}
								placeholder="ollama"
								value={customId}
							/>
						</div>
						<LabeledSelect
							id="pi-custom-api"
							items={apiTypeItems}
							label="API type"
							onValueChange={(v) =>
								onCustomApiChange?.(v || "openai-completions")
							}
							value={customApi}
						/>
						<div className="flex flex-col gap-1.5 sm:col-span-2">
							<Label htmlFor="pi-custom-url">Base URL</Label>
							<Input
								id="pi-custom-url"
								onChange={(e) => onCustomBaseUrlChange?.(e.target.value)}
								placeholder="http://localhost:11434/v1"
								value={customBaseUrl}
							/>
						</div>
					</div>
				) : null}

				<div className="flex flex-col gap-1.5">
					<Label htmlFor="pi-model">Model</Label>
					{modelOptions.length > 0 ? (
						<PiModelPicker
							id="pi-model"
							loading={modelsLoading}
							onValueChange={onModelChange}
							options={modelOptions}
							value={model}
						/>
					) : null}
					<Input
						id={modelOptions.length > 0 ? "pi-model-custom" : "pi-model"}
						onChange={(e) => onModelChange?.(e.target.value)}
						placeholder={modelIdPlaceholder(modelOptions.length > 0, routing)}
						value={model}
					/>
				</div>

				<LabeledSelect
					id="pi-thinking"
					items={thinkingItems}
					label="Thinking level"
					onValueChange={(v) => onThinkingLevelChange?.(v || "")}
					value={thinkingLevel}
				/>

				{showApiKey ? (
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="pi-key">API key</Label>
						<Input
							autoComplete="off"
							id="pi-key"
							onChange={(e) => onApiKeyChange?.(e.target.value)}
							placeholder={
								selectedMeta?.configured
									? "Stored — leave blank to keep"
									: "Stored in auth.json"
							}
							type="password"
							value={apiKey}
						/>
						<span className="text-muted-foreground text-xs">
							Direct-provider calls bypass the Ryu Gateway. The key is written
							only to Ryu&apos;s isolated Pi config.
						</span>
					</div>
				) : null}

				{saveError ? (
					<p className="text-status-destructive text-xs">{saveError}</p>
				) : null}
				<div className="flex items-center gap-3">
					<Button
						disabled={!canSave}
						loading={saving}
						onClick={onSave}
						type="button"
					>
						Save Pi config
					</Button>
					{saved && !saving ? (
						<span className="flex items-center gap-1 text-status-success text-xs">
							<HugeiconsIcon className="size-3" icon={CheckmarkBadge04Icon} />
							Saved
						</span>
					) : null}
					{configDir ? (
						<span
							className="type-compact ml-auto truncate text-muted-foreground"
							title={configDir}
						>
							{configDir}
						</span>
					) : null}
				</div>
			</SettingsCard>
		</SettingsSection>
	);
}
