// apps/desktop/src/components/inference/NativeLaunchOptions.tsx
//
// Renders an engine's native launch options (llama-server, whisper-server,
// sd-server, llama-tts, vLLM, SGLang, mlx_lm, ollama serve) from the catalog
// Core serves at `GET /api/engines/{engine}/launch-options`. Values live in
// `LaunchConfig.native`; a blank field removes the key so the engine default
// applies. Core skips values that do not match the catalog at spawn.

import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { GatewayJsonValue } from "@/src/lib/api/gateway-json-contracts.ts";
import {
	getEngineLaunchOptions,
	type NativeLaunchKind,
	type NativeLaunchOption,
} from "@/src/lib/api/inference.ts";
import {
	BoolField,
	EnumField,
	FieldGrid,
	FieldGroup,
	NumberField,
	TextField,
} from "./fields.tsx";

type NativeValues = Record<string, GatewayJsonValue>;

const ENGINE_LABELS = new Map<string, string>([
	["llamacpp", "llama.cpp"],
	["vllm", "vLLM"],
	["sglang", "SGLang"],
	["mlx", "MLX"],
	["mlx-vlm", "MLX-VLM"],
]);

function numberError(
	option: NativeLaunchOption,
	kind: Extract<NativeLaunchKind, { type: "int" | "float" }>,
	value: number,
	tl: LiteralMessage
): string | null {
	const label = option.label;
	if (!Number.isFinite(value)) {
		return tl("{label} must be a finite number.", { label });
	}
	if (kind.type === "int" && !Number.isSafeInteger(value)) {
		return tl("{label} must be a whole number.", { label });
	}
	if (kind.min !== undefined && value < kind.min) {
		return tl("{label} must be at least {min}.", {
			label,
			min: String(kind.min),
		});
	}
	if (kind.max !== undefined && value > kind.max) {
		return tl("{label} must be no greater than {max}.", {
			label,
			max: String(kind.max),
		});
	}
	return null;
}

function targetHint(option: NativeLaunchOption): string {
	const target =
		option.target.type === "env"
			? `env ${option.target.name}`
			: option.target.name;
	return option.help.includes(option.target.name)
		? option.help
		: `${option.help} (${target})`;
}

function groupOptions(
	options: NativeLaunchOption[]
): [string, NativeLaunchOption[]][] {
	const groups = new Map<string, NativeLaunchOption[]>();
	for (const option of options) {
		const list = groups.get(option.group) ?? [];
		list.push(option);
		groups.set(option.group, list);
	}
	return [...groups.entries()];
}

function NativeOptionField({
	option,
	value,
	draftNumber,
	onValue,
	onNumber,
}: {
	option: NativeLaunchOption;
	value: GatewayJsonValue | undefined;
	draftNumber: number | undefined;
	onValue: (value: GatewayJsonValue | undefined) => void;
	onNumber: (value: number | undefined) => void;
}) {
	const hint = targetHint(option);
	const { kind } = option;
	switch (kind.type) {
		case "int":
		case "float":
			return (
				<NumberField
					hint={hint}
					label={option.label}
					max={kind.max}
					min={kind.min}
					onChange={onNumber}
					step={kind.type === "int" ? 1 : 0.01}
					value={draftNumber ?? (typeof value === "number" ? value : undefined)}
				/>
			);
		case "text":
			return (
				<TextField
					hint={hint}
					label={option.label}
					onChange={(text) => onValue(text?.trim() ? text : undefined)}
					value={typeof value === "string" ? value : undefined}
				/>
			);
		case "enum":
			return (
				<EnumField
					hint={hint}
					label={option.label}
					onChange={onValue}
					options={kind.values.map((entry) => ({
						value: entry,
						label: entry,
					}))}
					value={typeof value === "string" ? value : undefined}
				/>
			);
		case "bool":
			// An environment boolean has three states (unset, on, off); a flag is
			// either emitted or not, so switching it off clears the key.
			return option.target.type === "env" ? (
				<EnumField
					hint={hint}
					label={option.label}
					onChange={(choice) =>
						onValue(choice === undefined ? undefined : choice === "on")
					}
					options={[
						{ value: "on", label: "On" },
						{ value: "off", label: "Off" },
					]}
					value={
						typeof value === "boolean" ? (value ? "on" : "off") : undefined
					}
				/>
			) : (
				<BoolField
					hint={hint}
					label={option.label}
					onChange={(checked) => onValue(checked ? true : undefined)}
					value={value === true}
				/>
			);
		default:
			return null;
	}
}

export function NativeLaunchOptions({
	engineId,
	engineChoices,
	value,
	onChange,
	onValidityChange,
}: {
	/** Engine whose catalog to render; the first choice when choices are given. */
	engineId: string;
	/** Per-model scope: engines the model may be served by. */
	engineChoices?: string[];
	value: NativeValues | undefined;
	onChange: (value: NativeValues | undefined) => void;
	onValidityChange: (valid: boolean) => void;
}) {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const target: ApiTarget = {
		url: node.url,
		token: node.token ?? null,
		userJwt: node.userJwt ?? null,
	};
	const [selectedEngine, setSelectedEngine] = useState(engineId);
	const [numberDrafts, setNumberDrafts] = useState<Record<string, number>>({});
	const [errors, setErrors] = useState<Record<string, string>>({});
	const selectId = useId();
	const activeEngine = engineChoices?.includes(selectedEngine)
		? selectedEngine
		: engineId;

	const catalogQuery = useQuery({
		queryKey: ["engines", "launch-options", target.url, activeEngine],
		queryFn: () => getEngineLaunchOptions(target, activeEngine),
		staleTime: Number.POSITIVE_INFINITY,
	});

	const hasErrors = Object.keys(errors).length > 0;
	useEffect(() => {
		onValidityChange(!hasErrors);
	}, [hasErrors, onValidityChange]);

	const setOption = (key: string, next: GatewayJsonValue | undefined) => {
		const updated: NativeValues = { ...(value ?? {}) };
		if (next === undefined) {
			delete updated[key];
		} else {
			updated[key] = next;
		}
		onChange(Object.keys(updated).length > 0 ? updated : undefined);
	};
	const clearDraft = (key: string) => {
		setNumberDrafts(({ [key]: _dropped, ...rest }) => rest);
		setErrors(({ [key]: _dropped, ...rest }) => rest);
	};
	const setNumber = (option: NativeLaunchOption, next: number | undefined) => {
		const { kind } = option;
		if (kind.type !== "int" && kind.type !== "float") {
			return;
		}
		if (next === undefined) {
			clearDraft(option.key);
			setOption(option.key, undefined);
			return;
		}
		const error = numberError(option, kind, next, tl);
		if (error) {
			setNumberDrafts((current) => ({ ...current, [option.key]: next }));
			setErrors((current) => ({ ...current, [option.key]: error }));
			return;
		}
		clearDraft(option.key);
		setOption(option.key, next);
	};

	const options = catalogQuery.data ?? [];
	if (!catalogQuery.isLoading && options.length === 0 && !engineChoices) {
		return null;
	}

	return (
		<FieldGroup
			description="Native flags and server settings for this runtime, beyond the fields above. Leave a field blank to keep the engine default."
			title="Native engine options"
		>
			{engineChoices && engineChoices.length > 1 ? (
				<div className="flex max-w-xs flex-col gap-1.5">
					<Label htmlFor={selectId}>Options for engine</Label>
					<Select
						items={engineChoices.map((id) => ({
							value: id,
							label: ENGINE_LABELS.get(id) ?? id,
						}))}
						onValueChange={(next) => {
							if (next) {
								setSelectedEngine(next);
							}
						}}
						value={activeEngine}
					>
						<SelectTrigger id={selectId}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{engineChoices.map((id) => (
								<SelectItem key={id} value={id}>
									{ENGINE_LABELS.get(id) ?? id}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<p className="text-muted-foreground text-xs">
						Values are saved together; each engine applies only its own options
						when it serves this model.
					</p>
				</div>
			) : null}
			{Object.entries(errors).map(([key, message]) => (
				<p className="text-status-destructive text-xs" key={key} role="alert">
					{message}
				</p>
			))}
			{catalogQuery.isLoading ? (
				<SkeletonRows label="Loading engine options…" spacing="comfortable" />
			) : catalogQuery.isError ? (
				<p className="text-status-destructive text-xs" role="alert">
					Could not load this engine's native options.
				</p>
			) : (
				groupOptions(options).map(([group, entries]) => (
					<div className="flex flex-col gap-2" key={group}>
						<h5 className="font-medium text-muted-foreground text-xs">
							{group}
						</h5>
						<FieldGrid>
							{entries.map((option) => (
								<NativeOptionField
									draftNumber={numberDrafts[option.key]}
									key={option.key}
									onNumber={(next) => setNumber(option, next)}
									onValue={(next) => setOption(option.key, next)}
									option={option}
									value={value?.[option.key]}
								/>
							))}
						</FieldGrid>
					</div>
				))
			)}
		</FieldGroup>
	);
}
