/* @jsxImportSource @opentui/react */
// Gateway overlay section panels, mirroring the desktop GatewayDialog IA
// (apps/desktop/src/components/gateway/GatewayDialog.tsx). The data-backed panels
// (Overview / Routing / Guardrails / Budgets / Keys) read the single raw gateway
// status snapshot; Identities / Channels / Audit / Evals are lighter, clearly
// labeled panels that point at the desktop app for their write/edit flows, since
// those surfaces need separate endpoints the TUI intentionally does not drive.

import type { ReactNode } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import type { RawStatus } from "./status.ts";
import {
	apiKeyNames,
	asBool,
	asString,
	asStringArray,
	dlpEnabled,
	getPath,
	modelMapEntries,
	requestsTotal,
	routingDefault,
} from "./status.ts";

const KEY_WIDTH = 12;
const DESKTOP_NOTE = "read-only — edit gateway policy in the desktop app";

// A single "key   value" row with a muted, fixed-width label.
function Row({ children, label }: { children: ReactNode; label: string }) {
	const theme = useTheme();
	return (
		<box flexDirection="row" gap={1}>
			<text fg={theme.colors.mutedForeground}>
				{label.padEnd(KEY_WIDTH, " ")}
			</text>
			{children}
		</box>
	);
}

// A row whose value is a status dot + label (● on / ○ off). The status row's off
// state is a red dot (offline); policy indicators use a muted dot when off.
function Indicator({
	danger,
	label,
	on,
	text,
}: {
	danger?: boolean;
	label: string;
	on: boolean;
	text: string;
}) {
	const theme = useTheme();
	const offColor = danger ? theme.colors.error : theme.colors.mutedForeground;
	return (
		<Row label={label}>
			<text fg={on ? theme.colors.success : offColor}>{on ? "●" : "○"}</text>
			<text fg={theme.colors.foreground}>{text}</text>
		</Row>
	);
}

function SectionTitle({ children }: { children: string }) {
	const theme = useTheme();
	return (
		<text fg={theme.colors.primary}>
			<b>{children}</b>
		</text>
	);
}

function Caption({ children }: { children: string }) {
	const theme = useTheme();
	return <text fg={theme.colors.mutedForeground}>{children}</text>;
}

function DesktopNote({ note = DESKTOP_NOTE }: { note?: string }) {
	const theme = useTheme();
	return (
		<box marginTop={1}>
			<text fg={theme.colors.mutedForeground}>{note}</text>
		</box>
	);
}

// ── Overview ────────────────────────────────────────────────────────────────

export function OverviewPanel({ raw }: { raw: RawStatus }) {
	const theme = useTheme();
	const reachable = raw.reachable === true;
	const ec = raw.effective_config;
	const total = reachable ? requestsTotal(raw.metrics) : null;
	const providers = asStringArray(getPath(raw.health, "providers"));
	const firewallOn = asBool(getPath(ec, "firewall", "enabled"));
	const dlpOn = dlpEnabled(ec);
	const budgetOn = asBool(getPath(ec, "budget", "enabled"));
	return (
		<box flexDirection="column" gap={1}>
			<SectionTitle>Overview</SectionTitle>
			<box flexDirection="column">
				<Indicator
					danger
					label="status"
					on={reachable}
					text={reachable ? "online" : "offline"}
				/>
				<Row label="url">
					<text fg={theme.colors.accent}>{asString(raw.url) ?? "—"}</text>
				</Row>
				<Row label="routing">
					<text fg={theme.colors.foreground}>{routingDefault(ec)}</text>
				</Row>
				<Indicator
					label="firewall"
					on={firewallOn}
					text={firewallOn ? "enabled" : "disabled"}
				/>
				<Indicator
					label="dlp"
					on={dlpOn}
					text={dlpOn ? "enabled" : "disabled"}
				/>
				<Indicator
					label="budget"
					on={budgetOn}
					text={budgetOn ? "enabled" : "disabled"}
				/>
				{total === null ? null : (
					<Row label="requests">
						<text fg={theme.colors.foreground}>{String(total)}</text>
					</Row>
				)}
			</box>
			<box flexDirection="column">
				<Caption>
					{providers.length === 0
						? "No providers reported."
						: `${providers.length} provider${providers.length === 1 ? "" : "s"}`}
				</Caption>
				{providers.map((name) => (
					<Row key={name} label="provider">
						<text fg={theme.colors.foreground}>{name}</text>
					</Row>
				))}
			</box>
			<DesktopNote />
		</box>
	);
}

// ── Routing ─────────────────────────────────────────────────────────────────

export function RoutingPanel({ raw }: { raw: RawStatus }) {
	const theme = useTheme();
	const ec = raw.effective_config;
	const mappings = modelMapEntries(ec);
	const smartOn = asBool(getPath(ec, "routing", "smart_routing", "enabled"));
	return (
		<box flexDirection="column" gap={1}>
			<SectionTitle>Routing</SectionTitle>
			<Caption>
				User-level model routing, evaluated before any upstream provider.
			</Caption>
			<box flexDirection="column">
				<Row label="default">
					<text fg={theme.colors.foreground}>{routingDefault(ec)}</text>
				</Row>
				<Indicator
					label="smart"
					on={smartOn}
					text={smartOn ? "enabled" : "disabled"}
				/>
			</box>
			<box flexDirection="column">
				<Caption>
					{mappings.length === 0
						? "No model mappings — requests use built-in prefix rules then the default."
						: "Model mappings"}
				</Caption>
				{mappings.map((entry) => (
					<box flexDirection="row" gap={1} key={entry.model}>
						<text fg={theme.colors.foreground}>{entry.model}</text>
						<text fg={theme.colors.mutedForeground}>→</text>
						<text fg={theme.colors.accent}>{entry.provider}</text>
					</box>
				))}
			</box>
			<DesktopNote />
		</box>
	);
}

// ── Guardrails ──────────────────────────────────────────────────────────────

export function GuardrailsPanel({ raw }: { raw: RawStatus }) {
	const ec = raw.effective_config;
	const firewallOn = asBool(getPath(ec, "firewall", "enabled"));
	const dlpOn = dlpEnabled(ec);
	return (
		<box flexDirection="column" gap={1}>
			<SectionTitle>Guardrails</SectionTitle>
			<Caption>
				Firewall rules and PII/DLP redaction run at the gateway before a request
				leaves for any provider.
			</Caption>
			<box flexDirection="column">
				<Indicator
					label="firewall"
					on={firewallOn}
					text={firewallOn ? "enabled" : "disabled"}
				/>
				<Indicator
					label="dlp"
					on={dlpOn}
					text={dlpOn ? "enabled" : "disabled"}
				/>
			</box>
			<DesktopNote />
		</box>
	);
}

// ── Budgets ─────────────────────────────────────────────────────────────────

export function BudgetsPanel({ raw }: { raw: RawStatus }) {
	const ec = raw.effective_config;
	const budgetOn = asBool(getPath(ec, "budget", "enabled"));
	return (
		<box flexDirection="column" gap={1}>
			<SectionTitle>Budgets</SectionTitle>
			<Caption>
				Per-agent token budgets with notify, downgrade, restrict, or stop
				actions when a limit is reached.
			</Caption>
			<Indicator
				label="budgets"
				on={budgetOn}
				text={budgetOn ? "enabled" : "disabled"}
			/>
			<DesktopNote note="read-only — add or edit budget rules in the desktop app" />
		</box>
	);
}

// ── Keys ────────────────────────────────────────────────────────────────────

export function KeysPanel({ raw }: { raw: RawStatus }) {
	const theme = useTheme();
	const ec = raw.effective_config;
	const requireAuth = asBool(getPath(ec, "auth", "require_auth"));
	const names = apiKeyNames(ec);
	return (
		<box flexDirection="column" gap={1}>
			<SectionTitle>Keys</SectionTitle>
			<Caption>
				Gateway API keys are redacted — only names are shown. Issue or revoke
				keys in the web dashboard.
			</Caption>
			<Indicator
				danger={!requireAuth}
				label="auth"
				on={requireAuth}
				text={requireAuth ? "required" : "disabled"}
			/>
			<box flexDirection="column">
				<Caption>
					{names.length === 0 ? "No API keys configured." : "API keys"}
				</Caption>
				{names.map((name) => (
					<Row key={name} label="key">
						<text fg={theme.colors.foreground}>{name}</text>
					</Row>
				))}
			</box>
			<DesktopNote note="read-only — manage provider (BYOK) and gateway keys in the desktop app" />
		</box>
	);
}

// ── Lighter, labeled panels (write/edit flows live in desktop) ───────────────

function InfoPanel({
	body,
	note,
	title,
}: {
	body: string;
	note: string;
	title: string;
}) {
	return (
		<box flexDirection="column" gap={1}>
			<SectionTitle>{title}</SectionTitle>
			<Caption>{body}</Caption>
			<DesktopNote note={note} />
		</box>
	);
}

export function IdentitiesPanel() {
	return (
		<InfoPanel
			body="Per-domain agent logins, governed by the gateway. Credentials are encrypted at rest and never sent to the model. Bind a profile to an agent to let it act on those domains."
			note="manage identities in the desktop app"
			title="Identities"
		/>
	);
}

export function ChannelsPanel() {
	return (
		<InfoPanel
			body="Channel bots run on the gateway and are account-global — not scoped to the active node. A bot routes to a single agent or a team."
			note="configure channels in the desktop app"
			title="Channels"
		/>
	);
}

export function AuditPanel() {
	return (
		<InfoPanel
			body="Immutable log of gateway policy decisions — routed, blocked, budgeted, and redacted requests, with timestamps and reasons."
			note="browse the full audit log in the desktop app"
			title="Audit"
		/>
	);
}

export function EvalsPanel() {
	return (
		<InfoPanel
			body="Run scored evaluations against the gateway to compare models and routing rules on your own test cases."
			note="run and review evals in the desktop app"
			title="Evals"
		/>
	);
}
