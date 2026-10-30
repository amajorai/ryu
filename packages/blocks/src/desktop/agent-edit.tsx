"use client";
// Presentational layer of the desktop one-page agent editor. The live app
// (`apps/desktop/src/pages/AgentEditPage.tsx` + its `components/agents/*`
// sub-components) is a thin container that owns all state, hooks, and API
// calls and renders these views with real data + handlers; the storyboard
// renders the same views with mock data and no-op handlers. One source of
// truth, so editing this block changes the real desktop too.
//
// Everything here is presentational: props + no-op default handlers, no hooks
// at module scope, no Tauri / context / stores / `@/...` app imports. Only
// `@ryu/ui/*`, icons, and `react` types. The PlateJS markdown editor used by
// the real "Instructions" field and Prompt Studio cannot render as a pure
// server component, so the block accepts an injected editor node (or falls
// back to a read-only textarea) instead of importing PlateJS.

import { Button } from "@ryu/ui/components/button";
import { Switch } from "@ryu/ui/components/switch";
import type { ReactNode } from "react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./settings-items.tsx";

// The editor's other views live in sibling `agent-edit-*` modules; this module
// stays the public import path for all of them.
export { AgentByoaView, type AgentByoaViewProps } from "./agent-edit-byoa.tsx";
export {
	AgentEvalsView,
	type AgentEvalsViewProps,
	type AuditRow,
	type EvalCaseRow,
	type EvalStat,
	type EvaluatorResultRow,
} from "./agent-edit-evals.tsx";
export type {
	AgentSettingsFormProps,
	ComposioAccountOption,
	ComposioActionRow,
	ComposioTriggerRow,
	SkillRow,
	SpaceRow,
	ToneOptionItem,
	TriggerSubRow,
} from "./agent-edit-form-types.ts";
export {
	AgentIntegrationsView,
	type AgentIntegrationsViewProps,
} from "./agent-edit-integrations.tsx";
export {
	MemorySpacesCard,
	type MemorySpacesCardProps,
} from "./agent-edit-memory-spaces.tsx";
export {
	type PiModelOption,
	type PiProviderMeta,
	RyuPiConfigView,
	type RyuPiConfigViewProps,
	type SlotOption,
} from "./agent-edit-pi-config.tsx";
export {
	AgentPreviewCard,
	type AgentPreviewCardProps,
} from "./agent-edit-preview-card.tsx";
export { AgentSettingsForm } from "./agent-edit-settings-form.tsx";
export { triggerAccountLabel } from "./agent-edit-triggers-panel.tsx";

// ── Claude Code gateway routing (per-agent) ───────────────────────────────────
// The real container wraps this in its Settings primitives + toast; the
// presentational shape is a labelled switch row + a "keep in mind" note.

export interface ClaudeGatewayConfigViewProps {
	enabled?: boolean;
	/** A line shown under the switch while the agent's account access is
	 * limited, since this routing can decide whether its engine starts. */
	limitedNotice?: string | null;
	loaded?: boolean;
	onToggle?: (next: boolean) => void;
}

export function ClaudeGatewayConfigView({
	enabled = true,
	limitedNotice = null,
	loaded = true,
	onToggle,
}: ClaudeGatewayConfigViewProps) {
	return (
		<SettingsSection
			caption={
				<>
					Route Claude Code's model traffic through the Ryu gateway so the
					firewall, PII/DLP redaction, and audit log govern it. Your Claude
					Pro/Max subscription is preserved — the gateway forwards your own
					login upstream unchanged and never uses an API key. Don't set{" "}
					<code>ANTHROPIC_API_KEY</code> or <code>ANTHROPIC_AUTH_TOKEN</code> —
					either overrides your subscription and switches you to API billing.
					The proxy is loopback-only: it only governs Claude Code running on
					this machine, so your subscription login never leaves your device.
				</>
			}
			title="Gateway routing"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={enabled}
							disabled={!loaded}
							id="claude-gateway-routing"
							onCheckedChange={onToggle}
						/>
					}
					description="On (default): Claude Code routes subscription egress through the local gateway (loopback-only), which applies request-side redaction + audit before forwarding your login upstream. Turn it off to keep direct egress. Takes effect the next time Claude Code starts."
					title="Route through Ryu Gateway"
				/>
			</SettingsGroup>
			{limitedNotice ? (
				<p
					className="px-3.5 text-status-warning text-xs leading-snug"
					role="status"
				>
					{limitedNotice}
				</p>
			) : null}
		</SettingsSection>
	);
}

// ── Codex gateway routing (per-agent) ─────────────────────────────────────────
// Mirrors the Claude Code view; Codex's ChatGPT-login (subscription) traffic is
// routed through the gateway passthrough while the OAuth + ChatGPT-Account-ID are
// forwarded upstream unchanged.

export interface CodexGatewayConfigViewProps {
	enabled?: boolean;
	/** A line shown under the switch while the agent's account access is
	 * limited, since this routing can decide whether its engine starts. */
	limitedNotice?: string | null;
	loaded?: boolean;
	onToggle?: (next: boolean) => void;
}

export function CodexGatewayConfigView({
	enabled = true,
	limitedNotice = null,
	loaded = true,
	onToggle,
}: CodexGatewayConfigViewProps) {
	return (
		<SettingsSection
			caption={
				<>
					Route Codex's model traffic through the Ryu gateway so the firewall,
					PII/DLP redaction, and audit log govern it. This governs your{" "}
					<strong>ChatGPT-login</strong> (subscription) Codex — the gateway
					forwards your own OAuth login and account id upstream unchanged and
					never injects an API key, so your subscription billing is preserved.
					The proxy is loopback-only: it only governs Codex running on this
					machine, so your subscription login never leaves your device.
				</>
			}
			title="Gateway routing"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={enabled}
							disabled={!loaded}
							id="codex-gateway-routing"
							onCheckedChange={onToggle}
						/>
					}
					description="On (default): Codex routes subscription egress through the local gateway (loopback-only), which applies request-side redaction + audit before forwarding your login upstream. Turn it off to keep direct egress. Takes effect the next time Codex starts."
					title="Route through Ryu Gateway"
				/>
			</SettingsGroup>
			{limitedNotice ? (
				<p
					className="px-3.5 text-status-warning text-xs leading-snug"
					role="status"
				>
					{limitedNotice}
				</p>
			) : null}
		</SettingsSection>
	);
}

// ── Generic per-agent gateway routing (BYO OpenAI-compatible agents) ──────────
// The "point any agent at the Ryu gateway via the OpenAI base-URL swap" toggle.
// Like the Claude/Codex views, this is Gateway-governed by default, but it is
// honest about scope: it only takes effect for an agent whose client
// reads OPENAI_BASE_URL — i.e. an OpenAI-compatible BYO agent.

export interface GatewayRoutingConfigViewProps {
	enabled?: boolean;
	/** A line shown under the switch while the agent's account access is
	 * limited, since this routing can decide whether its engine starts. */
	limitedNotice?: string | null;
	loaded?: boolean;
	onToggle?: (next: boolean) => void;
}

export function GatewayRoutingConfigView({
	enabled = true,
	limitedNotice = null,
	loaded = true,
	onToggle,
}: GatewayRoutingConfigViewProps) {
	return (
		<SettingsSection
			caption={
				<>
					Point this agent at the Ryu gateway instead of a provider. When on,
					Ryu injects <code>OPENAI_BASE_URL</code> + <code>OPENAI_API_KEY</code>{" "}
					(the local gateway) into the agent at launch, so its model calls are
					governed by the firewall, PII/DLP redaction, budgets, and audit log —
					no manual environment wiring on your part. This only takes effect for
					agents that read <code>OPENAI_BASE_URL</code> (an OpenAI-compatible
					agent); agents that speak another wire format or use their own gateway
					ignore it. The gateway is loopback-only, so the agent's traffic is
					governed on this machine before it leaves your device.
				</>
			}
			title="Gateway routing"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={enabled}
							disabled={!loaded}
							id="agent-gateway-routing"
							onCheckedChange={onToggle}
						/>
					}
					description="On (default): the agent's OpenAI-compatible endpoint uses the local gateway (loopback-only), where its traffic is governed. Turn it off to keep direct provider egress. Takes effect the next time the agent starts."
					title="Route through Ryu Gateway"
				/>
			</SettingsGroup>
			{limitedNotice ? (
				<p
					className="px-3.5 text-status-warning text-xs leading-snug"
					role="status"
				>
					{limitedNotice}
				</p>
			) : null}
		</SettingsSection>
	);
}

// ── Prompt Studio (faithful reconstruction) ───────────────────────────────────
// The real Prompt Studio embeds a PlateJS markdown editor, which cannot render
// as a pure presentational server component. The container renders the real
// `PromptStudio` directly; this view is only used by the storyboard to show the
// shape. It accepts an injected editor node so the live path can pass the real
// editor if it ever becomes server-renderable.

export interface AgentPromptStudioViewProps {
	editor?: ReactNode;
	formError?: string | null;
	onCancel?: () => void;
	onSave?: () => void;
	saveDisabled?: boolean;
	saving?: boolean;
	systemPrompt?: string;
}

export function AgentPromptStudioView({
	editor,
	systemPrompt = "",
	formError,
	saving,
	saveDisabled,
	onSave,
	onCancel,
}: AgentPromptStudioViewProps) {
	return (
		<div className="mx-auto flex max-w-2xl flex-col gap-6">
			{editor ?? (
				<section className="flex flex-col gap-2">
					<h2 className="font-medium text-base">Prompt Studio</h2>
					<p className="text-muted-foreground text-xs">
						PlateJS markdown editor for the system prompt.
					</p>
					<div className="rounded-lg border bg-card p-4 text-sm leading-relaxed">
						<pre className="whitespace-pre-wrap font-sans">{systemPrompt}</pre>
					</div>
				</section>
			)}

			{formError ? (
				<p className="text-sm text-status-destructive">{formError}</p>
			) : null}

			<div className="flex gap-2">
				<Button disabled={saveDisabled} loading={saving} onClick={onSave}>
					Save prompt
				</Button>
				<Button onClick={onCancel} variant="ghost">
					Cancel
				</Button>
			</div>
		</div>
	);
}
