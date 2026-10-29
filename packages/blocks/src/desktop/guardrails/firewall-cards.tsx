"use client";

// The firewall and DLP cards: presentational, driven entirely by a
// `GuardrailScopeCtx`. The desktop wraps them with the gateway config adapter
// (node baseline plus org and agent overlays); the web console wraps them with
// the named-policy adapter (`addOnly`, `inheritedUnknown`).

import { useLiteralMessages } from "@ryu/i18n/react";
import type { ReactNode } from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsSection,
} from "../settings-items.tsx";
import { GUARDRAIL_ACTION_LABELS } from "./copy.ts";
import { CustomPatternsEditor } from "./custom-patterns-editor.tsx";
import {
	GuardrailAlertRow,
	GuardrailBoolRow,
	GuardrailPolicyRow,
} from "./firewall-rows.tsx";
import type { GuardrailScopeCtx } from "./types.ts";

export function DlpCard({ ctx }: { ctx: GuardrailScopeCtx }) {
	const tl = useLiteralMessages();
	const resolvedPolicy = ctx.overlay.policy ?? ctx.node.policy;
	const isSanitize = resolvedPolicy === "sanitize";
	const knownPolicy = ctx.inheritedUnknown
		? ctx.overlay.policy
		: resolvedPolicy;

	return (
		<SettingsSection
			caption="Choose which categories are redacted when the firewall policy is set to Sanitize. PII covers email, phone, SSN, credit cards; Secrets covers API keys, tokens, and PEM keys."
			title="DLP / Redaction"
		>
			<div className="flex flex-col gap-3">
				{isSanitize ? null : (
					<SettingsCard className="text-sm text-status-warning">
						{knownPolicy
							? tl(
									"Redaction toggles apply only when the firewall policy is set to Sanitize. Resolved policy for this scope: {policy}.",
									{ policy: GUARDRAIL_ACTION_LABELS[knownPolicy] }
								)
							: tl(
									"Redaction toggles apply only when the firewall policy is set to Sanitize."
								)}
					</SettingsCard>
				)}

				<SettingsGroup>
					<GuardrailBoolRow
						ctx={ctx}
						description="Email, phone numbers, SSN, credit cards, IBANs, IPv4 addresses"
						field="redact_pii"
						title="Redact PII"
					/>
					<GuardrailBoolRow
						ctx={ctx}
						description="API keys, bearer tokens, PEM private keys, database connection strings"
						field="redact_secrets"
						title="Redact secrets"
					/>
				</SettingsGroup>
			</div>
		</SettingsSection>
	);
}

export function FirewallCard({
	alertNote,
	caption,
	ctx,
	patternsCaption,
	showAlert = true,
}: {
	/** Footer under the alert row (where its delivery targets live). */
	alertNote?: ReactNode;
	caption: string;
	ctx: GuardrailScopeCtx;
	/** Overrides the custom patterns caption. */
	patternsCaption?: ReactNode;
	/** A named policy has no alert tier, so its editor hides the row. */
	showAlert?: boolean;
}) {
	return (
		<>
			<SettingsSection caption={caption} title="Guardrails">
				<SettingsGroup>
					<GuardrailBoolRow ctx={ctx} field="enabled" title="Enabled" />
					<GuardrailBoolRow
						ctx={ctx}
						field="scan_inbound"
						title="Scan inbound"
					/>
					<GuardrailBoolRow
						ctx={ctx}
						field="scan_outbound"
						title="Scan outbound"
					/>
					<GuardrailBoolRow
						ctx={ctx}
						description="Record every firewall detection in the audit log"
						field="log_detections"
						title="Log detections"
					/>
					<GuardrailPolicyRow ctx={ctx} />
					{/* Beside `policy`: enforcement (what happens to the request) and
					    alerting (who is told) are orthogonal in the gateway, and
					    reading them together is the only way to see that a Block rule
					    is delivering nothing. */}
					{showAlert ? (
						<GuardrailAlertRow ctx={ctx} description={alertNote} />
					) : null}
				</SettingsGroup>
			</SettingsSection>
			<CustomPatternsEditor
				caption={patternsCaption}
				ctx={ctx}
				key={`${ctx.scope}:${ctx.overlayId}`}
			/>
		</>
	);
}
