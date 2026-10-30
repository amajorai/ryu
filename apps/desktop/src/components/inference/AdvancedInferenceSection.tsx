// apps/desktop/src/components/inference/AdvancedInferenceSection.tsx
//
// Collapsible "Advanced inference" editor for per-request SAMPLING defaults
// (temperature, top_p, penalties, mirostat, DRY/XTC, raw passthrough) at agent,
// engine, or model scope. Standard OpenAI fields show everywhere; non-standard
// samplers show only for runtimes that read them. Model scope passes the exact
// field list Core reports for the model's engine or cloud provider, so a cloud
// model shows Top K only where its provider accepts it.

import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ryu/ui/components/collapsible.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useMemo, useState } from "react";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { SamplingConfig } from "@/src/lib/api/inference.ts";
import { SamplingCoreGroups } from "./AdvancedInferenceSection-core-groups.tsx";
import { SamplingEngineGroups } from "./AdvancedInferenceSection-engine-groups.tsx";
import { SamplingOutputGroup } from "./AdvancedInferenceSection-output-group.tsx";
import {
	jsonObjectSchema,
	type Key,
	type NumberKey,
	type SamplingFieldsProps,
	type SamplingScope,
	samplingNumberError,
} from "./AdvancedInferenceSection-rules.ts";
import { FieldGroup } from "./fields.tsx";

export type { SamplingScope } from "./AdvancedInferenceSection-rules.ts";

export function AdvancedInferenceSection({
	value,
	onChange,
	disabled,
	localEngine,
	scope = "agent",
	engineId,
	onSave,
	saving = false,
	saved = false,
	saveError,
	supportedFields,
	defaultOpen = false,
}: {
	value: SamplingConfig;
	onChange: (next: SamplingConfig) => void;
	disabled?: boolean;
	/** True when the selected Chat runtime accepts the non-standard sampler fields. */
	localEngine: boolean;
	/** Engine scope saves defaults for every agent using this runtime. */
	scope?: SamplingScope;
	/**
	 * Exact field names the target model honours (Core's
	 * `/api/inference/sampling-fields`). When set, it replaces the coarse
	 * `localEngine` gate field by field.
	 */
	supportedFields?: ReadonlySet<string>;
	defaultOpen?: boolean;
	/** Runtime id when rendering engine-scoped defaults. */
	engineId?: string;
	onSave?: () => void;
	saving?: boolean;
	saved?: boolean;
	saveError?: string | null;
}) {
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(defaultOpen);
	// Whether a field renders: the reported field list wins; otherwise standard
	// fields always show and extensions follow the legacy local-engine gate.
	const shows = (key: Key, legacy = true): boolean =>
		supportedFields ? supportedFields.has(key) : legacy;
	const [numberErrors, setNumberErrors] = useState<
		Partial<Record<Key, string>>
	>({});
	const [numberDrafts, setNumberDrafts] = useState<
		Partial<Record<Key, number>>
	>({});

	// Set or clear a single field, returning a fresh object (no key when unset).
	const set = useMemo(
		() =>
			<K extends Key>(key: K, v: SamplingConfig[K] | undefined): void => {
				const next: SamplingConfig = { ...value };
				if (v === undefined) {
					delete next[key];
				} else {
					next[key] = v;
				}
				onChange(next);
			},
		[value, onChange]
	);

	const num = (key: NumberKey) => numberDrafts[key] ?? value[key] ?? undefined;
	const setNumber = (key: Key, nextValue: number | undefined) => {
		if (nextValue === undefined) {
			setNumberErrors((current) => {
				const next = { ...current };
				delete next[key];
				return next;
			});
			setNumberDrafts((current) => {
				const next = { ...current };
				delete next[key];
				return next;
			});
			set(key, undefined);
			return;
		}
		const error = samplingNumberError(key, nextValue, scope, engineId, tl);
		if (error) {
			setNumberErrors((current) => ({ ...current, [key]: error }));
			setNumberDrafts((current) => ({ ...current, [key]: nextValue }));
			return;
		}
		setNumberErrors((current) => {
			const next = { ...current };
			delete next[key];
			return next;
		});
		setNumberDrafts((current) => {
			const next = { ...current };
			delete next[key];
			return next;
		});
		set(key, nextValue);
	};

	// The raw `extra` passthrough is edited as JSON text with inline validation.
	const [extraText, setExtraText] = useState<string>(() =>
		value.extra && Object.keys(value.extra).length > 0
			? JSON.stringify(value.extra, null, 2)
			: ""
	);
	const [extraError, setExtraError] = useState<string | null>(null);

	const onExtraChange = (text: string) => {
		setExtraText(text);
		if (text.trim() === "") {
			setExtraError(null);
			set("extra", undefined);
			return;
		}
		try {
			const parsed = jsonObjectSchema.safeParse(JSON.parse(text));
			if (!parsed.success) {
				setExtraError("Must be a JSON object");
				return;
			}
			setExtraError(null);
			set("extra", parsed.data);
		} catch {
			setExtraError("Invalid JSON");
		}
	};

	const fieldProps: SamplingFieldsProps = {
		disabled,
		engineId,
		localEngine,
		num,
		scope,
		set,
		setNumber,
		shows,
		supportedFields,
		value,
	};

	return (
		<section
			aria-label={
				scope === "engine"
					? "Engine sampling defaults"
					: scope === "model"
						? "Model sampling parameters"
						: "Advanced inference"
			}
			className="flex flex-col gap-2"
		>
			<Collapsible
				className="flex flex-col gap-2"
				onOpenChange={setOpen}
				open={open}
			>
				<CollapsibleTrigger className="group/disclosure flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left outline-none transition-colors duration-150 hover:bg-muted hover:duration-0 focus-visible:ring-2 focus-visible:ring-ring">
					<span className="font-semibold text-sm">
						{scope === "engine"
							? "Sampling defaults"
							: scope === "model"
								? "Sampling parameters"
								: "Advanced inference"}
					</span>
					<span className="ml-auto text-muted-foreground">
						<HugeiconsIcon
							className="size-4 transition-transform duration-(--duration-fast) ease-move group-data-[panel-open]/disclosure:rotate-90"
							icon={ArrowRight01Icon}
						/>
					</span>
				</CollapsibleTrigger>

				<CollapsibleContent>
					{open ? (
						<SettingsSection
							caption={
								<CaptionInfo
									detail={
										scope === "engine"
											? "These settings override legacy agent defaults; request overrides still take precedence."
											: scope === "model"
												? "Applied on top of engine defaults. Only parameters this model accepts are shown."
												: "Applied to every chat turn for this agent."
									}
								>
									{scope === "engine"
										? "Defaults for every chat turn sent to this engine. Blank uses the engine default."
										: scope === "model"
											? "Applied to every turn that uses this model. Blank uses the default."
											: "Sampling defaults for this agent. Blank uses the engine default."}
								</CaptionInfo>
							}
						>
							{Object.entries(numberErrors).map(([key, message]) => (
								<p
									className="text-status-destructive text-xs"
									key={key}
									role="alert"
								>
									{message}
								</p>
							))}
							<SettingsCard className="flex flex-col gap-6">
								<SamplingCoreGroups {...fieldProps} />

								<SamplingEngineGroups {...fieldProps} />

								<SamplingOutputGroup {...fieldProps} />

								{shows("extra") ? (
									<FieldGroup
										description="Raw JSON merged verbatim into the request body, overriding the fields above. Use for engine knobs not listed here."
										title="Raw passthrough"
									>
										<div className="flex flex-col gap-1.5">
											<Label htmlFor="sampling-extra">
												Extra body fields (JSON)
											</Label>
											<Textarea
												className="min-h-24"
												disabled={disabled}
												id="sampling-extra"
												onChange={(e) => onExtraChange(e.target.value)}
												placeholder={'{\n  "min_keep": 1\n}'}
												value={extraText}
												variant="code-caption"
											/>
											{extraError ? (
												<p
													className="text-status-destructive text-xs"
													role="alert"
												>
													{extraError}
												</p>
											) : null}
										</div>
									</FieldGroup>
								) : null}
								{onSave ? (
									<div className="flex items-center gap-2">
										<Button
											disabled={disabled || saving || Boolean(extraError)}
											loading={saving}
											onClick={onSave}
											variant="outline"
										>
											{scope === "model"
												? "Save model parameters"
												: "Save sampling defaults"}
										</Button>
										{saved ? (
											<span className="text-muted-foreground text-xs">
												{scope === "model"
													? "Saved for this model"
													: "Saved for this engine"}
											</span>
										) : null}
										{saveError ? (
											<p
												className="text-status-destructive text-xs"
												role="alert"
											>
												{saveError}
											</p>
										) : null}
									</div>
								) : null}
							</SettingsCard>
						</SettingsSection>
					) : null}
				</CollapsibleContent>
			</Collapsible>
		</section>
	);
}
