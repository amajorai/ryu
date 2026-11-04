// Gateway Doctor findings rendered from their stable `checkId` on the client.
//
// Gateway builds each finding's summary, detail and recommended action as
// English sentences (apps/gateway/src/api/doctor.rs, the policy drift codes in
// apps/gateway/src/policy/drift.rs, and the three findings Core appends in its
// Gateway doctor proxy). The posture card maps the check id to whole tl()
// messages instead, so every sentence reaches the catalog. The few dynamic
// details (bind address, config path, on/off switches, provider id) are read
// back out of the English detail; when a detail no longer matches, or a check
// id is new, the card falls back to the English the Gateway sent.

import type { LiteralMessage } from "@ryu/i18n/react";

/** The display fields of a finding, as the Gateway serialises them. */
export interface DoctorFindingSource {
	checkId: string;
	detail: string;
	recommendedAction?: string;
	severity: string;
	summary: string;
}

/** The three separately translated sentences a finding row shows. */
export interface DoctorFindingCopy {
	action?: string;
	detail: string;
	summary: string;
}

type Values = Record<string, string>;

interface FindingCopyEntry {
	action: (tl: LiteralMessage) => string;
	/** `null` when the dynamic parts could not be read from the English detail. */
	detail: (tl: LiteralMessage, detail: string) => string | null;
	summary: (tl: LiteralMessage) => string;
}

function capture(
	pattern: RegExp,
	detail: string,
	names: string[]
): Values | null {
	const match = pattern.exec(detail);
	if (!match) {
		return null;
	}
	const values: Values = {};
	for (const [index, name] of names.entries()) {
		const value = match[index + 1];
		if (value === undefined) {
			return null;
		}
		values[name] = value;
	}
	return values;
}

function staticEntry(
	summary: (tl: LiteralMessage) => string,
	detail: (tl: LiteralMessage) => string,
	action: (tl: LiteralMessage) => string
): FindingCopyEntry {
	return { action, detail: (tl) => detail(tl), summary };
}

const driftSummary = (tl: LiteralMessage) =>
	tl("Policy settings contradict each other");
const driftAction = (tl: LiteralMessage) =>
	tl("Open the affected Gateway setting and resolve the contradiction.");
const pipelineAction = (tl: LiteralMessage) =>
	tl("Restore the default pipeline order and restart Gateway.");

const ENTRIES: Record<string, FindingCopyEntry> = {
	"configuration.load-failed": {
		action: (tl) => tl("Fix the configuration file, then restart Gateway."),
		detail: (tl, detail) => {
			const values = capture(
				/^The running process may be using startup defaults because (.+?) could not be read: (.*)$/su,
				detail,
				["path", "error"]
			);
			return values
				? tl(
						"The running process may be using startup defaults because {path} could not be read: {error}",
						values
					)
				: null;
		},
		summary: (tl) => tl("Gateway configuration could not be loaded"),
	},
	"security.config-permissions": {
		action: (tl) =>
			tl(
				"Restrict gateway.toml to the Gateway account (usually mode 0600) after checking service ownership."
			),
		detail: (tl, detail) => {
			const values = capture(/^(.+) has mode ([0-7]+); /su, detail, [
				"path",
				"mode",
			]);
			return values
				? tl(
						"{path} has mode {mode}; provider and auth metadata should normally be readable only by the Gateway account.",
						values
					)
				: null;
		},
		summary: (tl) => tl("Gateway configuration is readable by other users"),
	},
	"security.exposed-without-auth": {
		action: (tl) =>
			tl(
				"Bind Gateway to loopback or enable authentication before exposing it."
			),
		detail: (tl, detail) => {
			const values = capture(
				/^Gateway is bound to (.+?) but auth is disabled\./su,
				detail,
				["bind"]
			);
			return values
				? tl(
						"Gateway is bound to {bind} but auth is disabled. This would expose provider credentials and billable traffic to the network.",
						values
					)
				: null;
		},
		summary: (tl) => tl("Gateway is exposed without authentication"),
	},
	"security.firewall-disabled": staticEntry(
		(tl) => tl("Tool execution is running without the firewall"),
		(tl) =>
			tl(
				"Gateway tools or Composio are enabled while inbound and outbound DLP inspection is disabled."
			),
		(tl) => tl("Enable the firewall before using tool or Composio execution.")
	),
	"security.partial-firewall-scan": {
		action: (tl) =>
			tl(
				"Keep both inbound and outbound scanning enabled unless you have a documented exception."
			),
		detail: (tl, detail) => {
			const values = capture(
				/^Inbound scanning is (on|off); outbound scanning is (on|off)\.$/u,
				detail,
				["inbound", "outbound"]
			);
			return values
				? tl(
						"Inbound scanning is {inbound, select, on {on} other {off}}; outbound scanning is {outbound, select, on {on} other {off}}.",
						values
					)
				: null;
		},
		summary: (tl) => tl("Firewall scanning is only partially enabled"),
	},
	"security.redaction-disabled": {
		action: (tl) =>
			tl(
				"Enable secret and PII redaction to keep detected sensitive data out of forwarded content."
			),
		detail: (tl, detail) => {
			const values = capture(
				/^Secret redaction is (on|off); PII redaction is (on|off)\.$/u,
				detail,
				["secrets", "pii"]
			);
			return values
				? tl(
						"Secret redaction is {secrets, select, on {on} other {off}}; PII redaction is {pii, select, on {on} other {off}}.",
						values
					)
				: null;
		},
		summary: (tl) => tl("Sensitive-data redaction is incomplete"),
	},
	"security.untrusted-results-unwrapped": staticEntry(
		(tl) => tl("Untrusted tool results are not wrapped"),
		(tl) =>
			tl(
				"External tool output can re-enter model context without boundary markers."
			),
		(tl) => tl("Enable untrusted tool-result wrapping.")
	),
	"security.firewall-stage-missing": staticEntry(
		(tl) => tl("Firewall stage is missing from the running pipeline"),
		(tl) =>
			tl("The active request pipeline does not contain the firewall stage."),
		pipelineAction
	),
	"security.audit-stage-missing": staticEntry(
		(tl) => tl("Audit stage is missing from the running pipeline"),
		(tl) =>
			tl(
				"Audit is enabled in configuration but is not present in the active pipeline order."
			),
		pipelineAction
	),
	"performance.rate-limit-disabled": staticEntry(
		(tl) => tl("Rate limiting is disabled"),
		(tl) =>
			tl("Requests are not protected by the Gateway's per-key rate limiter."),
		(tl) => tl("Enable rate limiting for exposed or shared nodes.")
	),
	"security.exposed-without-rate-limits": staticEntry(
		(tl) => tl("Exposed Gateway has an unbounded rate-limit dimension"),
		(tl) =>
			tl(
				"At least one global request or token rate limit is unlimited on a non-loopback bind."
			),
		(tl) => tl("Set both request and token limits for an exposed Gateway.")
	),
	"performance.local-concurrency-unbounded": staticEntry(
		(tl) => tl("Local-engine concurrency is unbounded"),
		(tl) =>
			tl(
				"The local inference admission queue is disabled or has no in-flight ceiling, which can increase memory pressure during bursts."
			),
		(tl) => tl("Enable local concurrency limits and keep a bounded queue.")
	),
	"performance.circuit-breaker-disabled": staticEntry(
		(tl) => tl("Provider circuit breakers are disabled"),
		(tl) =>
			tl(
				"Repeated upstream failures can continue consuming request capacity without a fast-open circuit."
			),
		(tl) =>
			tl("Enable circuit breakers unless the node has an external equivalent.")
	),
	"connectivity.default-provider-missing": {
		action: (tl) =>
			tl("Configure the selected provider or choose one that is available."),
		detail: (tl, detail) => {
			const values = capture(/provider `([^`]+)`/u, detail, ["provider"]);
			return values
				? tl(
						"Routing selects provider `{provider}`, but that provider is not configured on this Gateway.",
						values
					)
				: null;
		},
		summary: (tl) => tl("The default route has no configured provider"),
	},
	"connectivity.no-provider-configured": staticEntry(
		(tl) => tl("No chat provider is configured"),
		(tl) =>
			tl(
				"Gateway can start, but chat requests will fail until a local, hosted, or Core provider is configured."
			),
		(tl) => tl("Open Providers and configure at least one chat provider.")
	),
	"connectivity.inspector-provider-missing": staticEntry(
		(tl) => tl("The traffic inspector has no classifier provider"),
		(tl) =>
			tl(
				"Inspector failures are fail-open because no classify provider is available."
			),
		(tl) =>
			tl("Start or configure a classifier provider, or turn off the inspector.")
	),
	"security.exec-budget-stop-ineffective": staticEntry(
		(tl) => tl("Execution stop budget has no limit"),
		(tl) =>
			tl(
				"The execution budget is configured to stop work, but both execution limits are unlimited."
			),
		(tl) =>
			tl(
				"Set max_count or max_wall_clock_secs, or change the action to notify."
			)
	),
	exec_without_firewall: staticEntry(
		driftSummary,
		(tl) =>
			tl(
				"Tool execution is enabled but the DLP firewall is disabled: tool inputs and outputs flow with no inspection."
			),
		driftAction
	),
	composio_guardrails_advisory: staticEntry(
		driftSummary,
		(tl) =>
			tl(
				"External Composio tools can execute while the firewall policy is warn-and-continue: detections are logged but never blocked or sanitized."
			),
		driftAction
	),
	exec_budget_stop_ineffective: staticEntry(
		driftSummary,
		(tl) =>
			tl(
				"Exec budget action is set to stop but both max_count and max_wall_clock_secs are 0: the hard stop can never trigger."
			),
		driftAction
	),
	locked_guardrails_firewall_off: staticEntry(
		driftSummary,
		(tl) =>
			tl(
				"The distributed policy requires locked guardrails but the local firewall is disabled: the mandated guardrails are not enforced."
			),
		driftAction
	),
	secret_redaction_disabled: staticEntry(
		driftSummary,
		(tl) =>
			tl(
				"Firewall policy is sanitize but secret redaction is disabled: detected secrets are not redacted."
			),
		driftAction
	),
	"core.approvals-disabled": staticEntry(
		(tl) => tl("Human approval prompts are disabled"),
		(tl) =>
			tl(
				"Core will not pause on globally risky tool actions. Per-agent policy layers may still add approvals."
			),
		(tl) =>
			tl(
				"Use Balanced or Guarded posture, or enable Smart approval mode in Core settings."
			)
	),
	"core.command-scan-disabled": staticEntry(
		(tl) => tl("Native command scanning is disabled"),
		(tl) =>
			tl(
				"Claude, Codex, and other ACP native commands can run without the Gateway command-scan gate."
			),
		(tl) =>
			tl(
				"Re-arm command scanning unless this is an intentional break-glass exception."
			)
	),
	"coverage.agent-egress-bypass": staticEntry(
		(tl) => tl("Agent model traffic is not routed through Gateway"),
		(tl) =>
			tl(
				"Claude, Codex, and generic agent egress are all explicitly opted out of Gateway governance. Native agent traffic may bypass Gateway firewall, budget, and audit controls."
			),
		(tl) =>
			tl(
				"Keep the governed default, or remove explicit direct-egress opt-outs for the agents that should be covered."
			)
	),
};

/** Every check id the posture card translates (tests compare it to the Rust). */
export const TRANSLATED_GATEWAY_DOCTOR_CHECK_IDS: readonly string[] =
	Object.keys(ENTRIES);

/**
 * The summary, detail and recommended action of `finding` in the UI language.
 * An unknown check id, or a detail whose dynamic parts no longer parse, keeps
 * the English the Gateway sent for that field.
 */
export function gatewayDoctorFindingCopy(
	finding: DoctorFindingSource,
	tl: LiteralMessage
): DoctorFindingCopy {
	const entry = Object.hasOwn(ENTRIES, finding.checkId)
		? ENTRIES[finding.checkId]
		: undefined;
	if (!entry) {
		return {
			action: finding.recommendedAction,
			detail: finding.detail,
			summary: finding.summary,
		};
	}
	return {
		action: finding.recommendedAction ? entry.action(tl) : undefined,
		detail: entry.detail(tl, finding.detail) ?? finding.detail,
		summary: entry.summary(tl),
	};
}

/** The severity word a finding's icon announces, in the UI language. */
export function doctorSeverityLabel(
	severity: string,
	tl: LiteralMessage
): string {
	switch (severity) {
		case "error":
			return tl("Error");
		case "warning":
			return tl("Warning");
		case "info":
			return tl("Info");
		default:
			return severity;
	}
}
