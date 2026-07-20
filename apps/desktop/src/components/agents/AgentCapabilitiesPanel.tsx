// apps/desktop/src/components/agents/AgentCapabilitiesPanel.tsx
//
// The agent edit page's Capabilities section. Shows what the agent's bound model
// supports (tools / reasoning / vision) — auto-detected per Jan's approach (ACP
// `session/new` probe or the local GGUF chat template) — and lets the user
// override each with a tri-state Auto / On / Off control (Jan's
// `_userConfiguredCapabilities`). The effective flags gate the composer controls
// and annotate the Tools allowlist below.

import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { useCallback } from "react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useAgentCapabilities } from "@/src/hooks/useAgentCapabilities.ts";
import type {
	CapabilityOverrides,
	CapabilityReport,
} from "@/src/lib/api/capabilities.ts";

/** Tri-state for one capability override: auto-detect, force on, force off. */
type TriState = "auto" | "on" | "off";

const TRI_OPTIONS: { value: TriState; label: string }[] = [
	{ value: "auto", label: "Auto" },
	{ value: "on", label: "On" },
	{ value: "off", label: "Off" },
];

function overrideToTri(value: boolean | null | undefined): TriState {
	if (value === true) {
		return "on";
	}
	if (value === false) {
		return "off";
	}
	return "auto";
}

function triToOverride(tri: TriState): boolean | null {
	if (tri === "on") {
		return true;
	}
	if (tri === "off") {
		return false;
	}
	return null;
}

type CapKey = keyof CapabilityOverrides;

const ROWS: {
	key: CapKey;
	label: string;
	hint: string;
}[] = [
	{
		key: "tools",
		label: "Tools",
		hint: "Call MCP tools and skills.",
	},
	{
		key: "reasoning",
		label: "Thinking",
		hint: "Emit a separate reasoning / thinking channel.",
	},
	{
		key: "vision",
		label: "Vision",
		hint: "Accept image input.",
	},
];

function sourceLabel(source: string): string {
	switch (source) {
		case "acp_probe":
			return "detected from the agent's session config";
		case "acp_probe+gguf":
			return "detected from the agent's session config and the local model";
		case "gguf":
			return "detected from the model's chat template";
		default:
			return "not auto-detected for this agent";
	}
}

/** A small segmented Auto / On / Off control for one capability. */
function TriToggle({
	value,
	onChange,
	disabled,
	ariaLabel,
}: {
	value: TriState;
	onChange: (next: TriState) => void;
	disabled?: boolean;
	ariaLabel: string;
}) {
	return (
		<fieldset
			aria-label={ariaLabel}
			className="m-0 inline-flex min-w-0 items-center rounded-md border p-0.5"
		>
			{TRI_OPTIONS.map((opt) => (
				<Button
					aria-pressed={value === opt.value}
					className={cn(
						"h-6 px-2 text-xs",
						value === opt.value && "bg-accent text-accent-foreground"
					)}
					disabled={disabled}
					key={opt.value}
					onClick={() => onChange(opt.value)}
					size="sm"
					type="button"
					variant="ghost"
				>
					{opt.label}
				</Button>
			))}
		</fieldset>
	);
}

export function AgentCapabilitiesPanel({
	agentId,
	disabled,
}: {
	agentId: string;
	disabled?: boolean;
}) {
	const { capabilities, loading, saving, setOverrides } =
		useAgentCapabilities(agentId);

	const handleChange = useCallback(
		(report: CapabilityReport, key: CapKey, tri: TriState) => {
			// Always send all three override fields — the PUT replaces the record,
			// so omitting one would reset it to auto.
			const next: CapabilityOverrides = {
				tools: report.overrides.tools ?? null,
				reasoning: report.overrides.reasoning ?? null,
				vision: report.overrides.vision ?? null,
			};
			next[key] = triToOverride(tri);
			setOverrides(next).catch(() => undefined);
		},
		[setOverrides]
	);

	return (
		<SettingsSection
			caption="What this agent's model supports. Auto-detected from the agent's model; override any of them. These gate the composer controls — a model with tools off shows no tools affordance."
			title="Capabilities"
		>
			{loading && !capabilities ? (
				<p className="text-muted-foreground text-xs">Detecting capabilities…</p>
			) : null}

			{capabilities ? (
				<>
					<SettingsGroup>
						{ROWS.map((row) => {
							const detected = capabilities.detected[row.key as "tools"];
							const tri = overrideToTri(capabilities.overrides[row.key]);
							return (
								<SettingsItem
									actions={
										<TriToggle
											ariaLabel={`${row.label} capability`}
											disabled={disabled || saving}
											onChange={(next) =>
												handleChange(capabilities, row.key, next)
											}
											value={tri}
										/>
									}
									description={`${row.hint} (${detected ? "supported" : "not supported"}, ${sourceLabel(capabilities.source)})`}
									key={row.key}
									title={row.label}
								/>
							);
						})}
					</SettingsGroup>

					{capabilities.tools ? null : (
						<p className="text-warning text-xs dark:text-warning">
							Tools are off for this agent's model — the tool allowlist below
							has no effect until you turn Tools on.
						</p>
					)}
				</>
			) : null}
		</SettingsSection>
	);
}
