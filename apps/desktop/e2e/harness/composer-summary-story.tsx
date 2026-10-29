import type {} from "./proof-css-custom-properties.d.ts";
// Standalone browser story for the composer's status line — the REAL
// `ComposerSettingsMenu` trigger, rendered from the same section shapes the
// composer hook builds.
//
// The trigger used to spell every setting out as its own bulleted segment
// (`Ryu · Claude Sonnet 4.5 · Accept edits · High`). It now compacts: the
// permission mode is its icon + colour, reasoning effort is a glanceable bar
// meter, model and usage labels collapse at the composer's own width, and the
// ACP harness sits in parentheses on the agent name. The composition rules are
// unit-tested (`composer-trigger-summary.test.ts`); what only a browser can
// answer is whether that verdict RENDERS — that the icon-only mode still paints
// an icon rather than an empty gap, the meter remains announced, and the
// container-width density changes do not clip the textarea controls.
//
// The second mount is opencode's real shape, taken from an actual `opencode acp`
// probe: its `mode` config option is decorated (category `"mode"`) but its
// default value `build` matches no approval style, so it MUST keep its text —
// icon-only there would erase the setting from the bar.
//
// Hermetic: the menu is presentational, so no Core node, no Tauri, no context.

import { approvalModeStyle } from "@ryu/blocks/composer/composer-approval-style.ts";
import { IconCpu } from "@tabler/icons-react";
import { createRoot } from "react-dom/client";
import {
	ComposerSettingsMenu,
	type ComposerSettingsSection,
} from "../../components/agent-elements/input/composer-settings-menu.tsx";
import "../../src/index.css";
import { useMemo, useState } from "react";

function noop() {
	return undefined;
}

/** The flagship's shape: agent + model + advertised approval modes + effort. */
const RYU_SECTIONS: ComposerSettingsSection[] = [
	{
		key: "agent",
		label: "Agent",
		ariaLabel: "Select agent",
		// What `useComposerAgentControls` composes: the agent name carrying its
		// harness, because "Ryu" alone never said which ACP agent is driving.
		activeName: "Ryu (pi)",
		items: [{ id: "ryu", name: "Ryu" }],
		value: "ryu",
		onChange: noop,
	},
	{
		key: "model",
		label: "Model",
		ariaLabel: "Select model",
		items: [{ id: "sonnet", name: "Claude Sonnet 4.5" }],
		value: "sonnet",
		onChange: noop,
	},
	{
		key: "approval",
		label: "Approval",
		ariaLabel: "Permission mode",
		decorate: approvalModeStyle,
		items: [
			{ id: "acceptEdits", name: "Accept edits" },
			{ id: "bypassPermissions", name: "Bypass permissions" },
		],
		value: "acceptEdits",
		onChange: noop,
	},
	{
		key: "cfg-thought_level",
		label: "Thinking",
		ariaLabel: "Reasoning effort",
		items: [
			{ id: "off", name: "Off" },
			{ id: "medium", name: "Medium" },
			{ id: "high", name: "High" },
		],
		value: "high",
		onChange: noop,
		variant: "slider",
	},
];

/** opencode's shape: a decorated mode option whose value resolves NO decoration. */
const OPENCODE_SECTIONS: ComposerSettingsSection[] = [
	{
		key: "agent",
		label: "Agent",
		ariaLabel: "Select agent",
		activeName: "OpenCode",
		items: [{ id: "acp:opencode", name: "OpenCode" }],
		value: "acp:opencode",
		onChange: noop,
	},
	{
		key: "cfg-mode",
		label: "Session Mode",
		ariaLabel: "Session Mode",
		decorate: approvalModeStyle,
		items: [
			{ id: "build", name: "Build" },
			{ id: "plan", name: "Plan" },
		],
		value: "build",
		onChange: noop,
	},
];

// The real composer keeps the model picker beside the agent/settings picker.
// Keeping that same split here makes the container-query story exercise the
// exact narrow-row shape rather than a decorative approximation.
const COMPOSER_SECTIONS = RYU_SECTIONS.filter(
	(section) => section.key !== "model"
);

function ComposerPreview({
	label,
	testId,
	width,
}: {
	label: string;
	testId: string;
	width: number;
}) {
	return (
		<section className="flex flex-col gap-2" data-testid={testId}>
			<div className="flex items-center justify-between text-muted-foreground text-xs">
				<h2 className="font-medium text-foreground">{label}</h2>
				<span>{width}px container</span>
			</div>
			<div
				className="composer-container w-(--proof-composer-width) min-w-0 rounded-2xl bg-muted p-3"
				style={{ "--proof-composer-width": `${width}px` }}
			>
				<textarea
					aria-label={`${label} message`}
					className="min-h-16 w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
					placeholder="Ask anything…"
					rows={2}
				/>
				<div className="mt-3 flex min-w-0 items-center gap-1">
					<ComposerSettingsMenu sections={COMPOSER_SECTIONS} />
					<button
						aria-label="Choose provider and model"
						className="composer-model-trigger max-w-44 truncate rounded-md px-2 py-1 text-muted-foreground text-xs hover:bg-muted/50 hover:text-foreground"
						title="Claude Sonnet 4.5"
						type="button"
					>
						<IconCpu
							aria-hidden="true"
							className="composer-model-icon size-3.5 shrink-0"
						/>
						<span className="composer-model-name truncate">
							Claude Sonnet 4.5
						</span>
					</button>
				</div>
			</div>
		</section>
	);
}

function Story() {
	const [approval, setApproval] = useState("acceptEdits");
	const ryuSections = useMemo(
		() =>
			RYU_SECTIONS.map((section) =>
				section.key === "approval"
					? { ...section, onChange: setApproval, value: approval }
					: section
			),
		[approval]
	);
	return (
		<div className="flex min-h-screen flex-col gap-8 bg-background p-6">
			<section className="flex flex-col gap-2" data-testid="ryu">
				<h2 className="font-medium text-sm">Flagship</h2>
				<ComposerSettingsMenu sections={ryuSections} />
			</section>
			<section className="flex flex-col gap-2" data-testid="opencode">
				<h2 className="font-medium text-sm">opencode</h2>
				<ComposerSettingsMenu sections={OPENCODE_SECTIONS} />
			</section>
			{/* The chat-with-history trigger, which names only the agent. The harness
			    rides along there too — it is part of the agent's NAME, not a fourth
			    segment — so compact reads `Ryu (pi)` and not a bare `Ryu`. Pinned
			    because that is the trigger a user looks at all day. */}
			<section className="flex flex-col gap-2" data-testid="ryu-compact">
				<h2 className="font-medium text-sm">Flagship (compact)</h2>
				<ComposerSettingsMenu compact sections={ryuSections} />
			</section>
			<section className="flex flex-col gap-3" data-testid="adaptive">
				<h2 className="font-medium text-sm">Composer width adaptation</h2>
				<ComposerPreview label="Wide" testId="adaptive-wide" width={680} />
				<ComposerPreview label="Medium" testId="adaptive-medium" width={420} />
				<ComposerPreview label="Tight" testId="adaptive-tight" width={300} />
			</section>
		</div>
	);
}

const container = document.getElementById("root");
if (container) {
	createRoot(container).render(<Story />);
}
