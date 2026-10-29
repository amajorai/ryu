// React's style contract includes the exact CSS custom properties consumed below.
declare module "react" {
	interface CSSProperties {
		"--fixture-value-1"?: string | number;
		"--fixture-value-2"?: string | number;
		"--fixture-value-3"?: string | number;
		"--fixture-value-4"?: string | number;
		"--fixture-value-5"?: string | number;
		"--fixture-value-6"?: string | number;
		"--fixture-value-7"?: string | number;
	}
}

import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import proofStyles from "./control-audit-proof.module.css";

type Scope = "all" | "org" | "gateway";

interface Activity {
	action: string;
	actor: string;
	actorType: "gateway" | "user";
	details: string;
	id: string;
	scope: Exclude<Scope, "all">;
	target: string;
	targetId: string | null;
	when: string;
}

const ACTIVITIES: Activity[] = [
	{
		action: "policy.update",
		actor: "Jia Wei",
		actorType: "user",
		details: "level: org · payload omitted",
		id: "org-policy-1",
		scope: "org",
		target: "policy",
		targetId: "policy-prod",
		when: "Aug 17, 2026 · 10:42 AM",
	},
	{
		action: "config.update",
		actor: "Jia Wei",
		actorType: "user",
		details: "sections: firewall, routing · secrets omitted",
		id: "gateway-config-1",
		scope: "gateway",
		target: "gateway_config",
		targetId: null,
		when: "Aug 17, 2026 · 10:40 AM",
	},
	{
		action: "gateway.provider.update",
		actor: "Jia Wei",
		actorType: "user",
		details: "provider: openai · key value omitted",
		id: "gateway-provider-1",
		scope: "gateway",
		target: "gateway_provider",
		targetId: null,
		when: "Aug 17, 2026 · 10:39 AM",
	},
	{
		action: "gateway.restart",
		actor: "Gateway admin",
		actorType: "gateway",
		details: "gateway process restarted",
		id: "gateway-restart-1",
		scope: "gateway",
		target: "gateway_process",
		targetId: null,
		when: "Aug 17, 2026 · 10:38 AM",
	},
];

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div className={proofStyles.fixture1}>
			<div className={proofStyles.fixture2}>{label}</div>
			<div className={proofStyles.fixture3}>{value}</div>
		</div>
	);
}

function ProofCheck({ children }: { children: string }) {
	return (
		<li className={proofStyles.fixture4}>
			<span aria-hidden="true" className={proofStyles.fixture5}>
				✓
			</span>
			<span>{children}</span>
		</li>
	);
}

function ControlAuditProof() {
	const [scope, setScope] = useState<Scope>("all");
	const visibleActivities = useMemo(
		() =>
			scope === "all"
				? ACTIVITIES
				: ACTIVITIES.filter((activity) => activity.scope === scope),
		[scope]
	);

	return (
		<main className={proofStyles.fixture6} data-testid="control-audit-proof">
			<div className={proofStyles.fixture7}>
				<div className={proofStyles.fixture8}>
					<div aria-hidden="true" className={proofStyles.fixture9}>
						⌁
					</div>
					<div>
						<div className={proofStyles.fixture10}>RYU CONTROL PLANE</div>
						<h1 className={proofStyles.fixture11}>Audit log · who did what</h1>
					</div>
				</div>

				<p className={proofStyles.fixture12}>
					A single organization view joins authenticated org mutations with
					Gateway control changes. The actor, action, scope, and target remain
					visible while policy bodies and credential values stay out of the log.
				</p>

				<div className={proofStyles.fixture13}>
					<Stat label="Org control rows" value="1" />
					<Stat label="Gateway control rows" value="3" />
					<Stat label="Request usage impact" value="0" />
				</div>

				<section
					aria-label="Control activity"
					className={proofStyles.fixture14}
				>
					<div className={proofStyles.fixture15}>
						<div>
							<h2 className={proofStyles.fixture16}>Control activity</h2>
							<div className={proofStyles.fixture17}>
								{visibleActivities.length} rows in this view · audit.view
								required
							</div>
						</div>
						<div
							aria-label="Audit scope"
							className={proofStyles.fixture18}
							role="group"
						>
							{(["all", "org", "gateway"] as const).map((option) => (
								<button
									aria-pressed={scope === option}
									className={proofStyles.dynamicFixture1}
									key={option}
									onClick={() => setScope(option)}
									style={{
										"--fixture-value-1":
											scope === option
												? "var(--control-audit-proof-color-1)"
												: "transparent",
										"--fixture-value-2": `1px solid ${"var(--control-audit-proof-color-2)"}`,
										"--fixture-value-3": "999px",
										"--fixture-value-4": "var(--control-audit-proof-color-3)",
										"--fixture-value-5": "pointer",
										"--fixture-value-6": "12px",
										"--fixture-value-7": "7px 12px",
									}}
								>
									{option === "all" ? "All controls" : option}
								</button>
							))}
						</div>
					</div>

					<div className={proofStyles.fixture19}>
						<table className={proofStyles.fixture20}>
							<thead>
								<tr className={proofStyles.fixture21}>
									{[
										"When",
										"Scope",
										"Actor",
										"Action",
										"Target",
										"Details",
									].map((heading) => (
										<th className={proofStyles.fixture22} key={heading}>
											{heading}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{visibleActivities.map((activity) => (
									<tr key={activity.id}>
										<td className={proofStyles.fixture23}>{activity.when}</td>
										<td className={proofStyles.fixture24}>
											<span className={proofStyles.fixture25}>
												{activity.scope}
											</span>
										</td>
										<td className={proofStyles.fixture26}>
											<div className={proofStyles.fixture27}>
												{activity.actor}
											</div>
											<div className={proofStyles.fixture28}>
												{activity.actorType}
											</div>
										</td>
										<td className={proofStyles.fixture29}>{activity.action}</td>
										<td className={proofStyles.fixture30}>
											<div className={proofStyles.fixture31}>
												{activity.target}
											</div>
											{activity.targetId ? (
												<div className={proofStyles.fixture32}>
													{activity.targetId}
												</div>
											) : null}
										</td>
										<td className={proofStyles.fixture33}>
											{activity.details}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</section>

				<section
					aria-label="Verification evidence"
					className={proofStyles.fixture34}
				>
					<h2 className={proofStyles.fixture35}>Verification evidence</h2>
					<ul className={proofStyles.fixture36}>
						<ProofCheck>
							Org writes store the authenticated user id and route action.
						</ProofCheck>
						<ProofCheck>
							Gateway config, provider, restart, and Doctor writes emit
							control_change rows.
						</ProofCheck>
						<ProofCheck>
							Gateway rows forward Core’s verified actor id; direct local admins
							remain attributable.
						</ProofCheck>
						<ProofCheck>
							Control rows are excluded from request counts, token totals, and
							usage analytics.
						</ProofCheck>
						<ProofCheck>
							Read access is protected by the audit.view permission.
						</ProofCheck>
					</ul>
					<div className={proofStyles.fixture37}>
						Rendered contract proof uses the shipped API response shape with
						representative redacted rows. Live local-stack verification is
						environment-dependent.
					</div>
				</section>
			</div>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<ControlAuditProof />);
