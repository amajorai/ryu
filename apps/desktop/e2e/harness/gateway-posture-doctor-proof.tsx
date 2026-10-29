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
		"--fixture-value-8"?: string | number;
		"--fixture-value-9"?: string | number;
		"--fixture-value-10"?: string | number;
		"--fixture-value-11"?: string | number;
		"--fixture-value-12"?: string | number;
		"--fixture-value-13"?: string | number;
		"--fixture-value-14"?: string | number;
		"--fixture-value-15"?: string | number;
		"--fixture-value-16"?: string | number;
		"--fixture-value-17"?: string | number;
		"--fixture-value-18"?: string | number;
		"--fixture-value-19"?: string | number;
		"--fixture-value-20"?: string | number;
		"--fixture-value-21"?: string | number;
		"--fixture-value-22"?: string | number;
	}
}

import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	approvalModeForPosture,
	firewallForPosture,
	GATEWAY_POSTURE_OPTIONS,
	type GatewayPosture,
	resolveGatewayPosture,
} from "@/src/lib/api/gateway-posture.ts";
import proofStyles from "./gateway-posture-doctor-proof.module.css";

const BASELINE = {
	enabled: true,
	scan_inbound: true,
	scan_outbound: true,
	log_detections: true,
	redact_pii: true,
	redact_secrets: true,
	wrap_untrusted_tool_results: true,
	policy: "block" as const,
	custom_patterns: [],
};

const DOCTOR_CHECKS = [
	["configuration", "Config load and pipeline stages"],
	["security", "Bind, auth, firewall, redaction, wrapping"],
	["performance", "Rate limits, concurrency, circuit breakers"],
	["connectivity", "Provider and classifier availability"],
	["coverage", "Core approvals and agent egress routing"],
] as const;

function GatewayPostureDoctorProof() {
	const [index, setIndex] = useState(1);
	const [applied, setApplied] = useState<GatewayPosture>("balanced");
	const [doctorState, setDoctorState] = useState<"at-risk" | "healthy">(
		"at-risk"
	);
	const [doctorPreview, setDoctorPreview] = useState(false);
	const [doctorRuns, setDoctorRuns] = useState(0);
	const selected = GATEWAY_POSTURE_OPTIONS[index] ?? GATEWAY_POSTURE_OPTIONS[1];
	const preview = useMemo(() => {
		const firewall = firewallForPosture(BASELINE, selected.level);
		return {
			approval: approvalModeForPosture(selected.level),
			firewall,
			resolved: resolveGatewayPosture({
				approvalMode: approvalModeForPosture(selected.level),
				execApprovalEnabled: true,
				firewall,
			}),
		};
	}, [selected.level]);
	const isApplied = selected.level === applied;
	const doctorHealthy = doctorState === "healthy";

	return (
		<main className={proofStyles.fixture1}>
			<div className={proofStyles.fixture2}>
				<header className={proofStyles.fixture3}>
					<div>
						<div className={proofStyles.fixture4}>RYU · LIVE REACT PROOF</div>
						<h1 className={proofStyles.fixture5}>Gateway posture + Doctor</h1>
						<p className={proofStyles.fixture6}>
							One detented slider coordinates Gateway guardrails with Core
							approvals; Doctor makes configuration, security, performance, and
							coverage gaps visible.
						</p>
					</div>
					<div className={proofStyles.fixture7} data-testid="proof-status">
						VERIFIED
					</div>
				</header>

				<section
					aria-label="Safety posture preview"
					className={proofStyles.fixture8}
				>
					<div className={proofStyles.fixture9}>
						<div>
							<div className={proofStyles.fixture10}>SAFETY POSTURE</div>
							<h2
								className={proofStyles.fixture11}
								data-testid="selected-posture"
							>
								{selected.label}
							</h2>
							<p className={proofStyles.fixture12}>{selected.description}</p>
						</div>
						<div
							className={proofStyles.dynamicFixture1}
							data-testid="applied-posture"
							style={{
								"--fixture-value-1": isApplied
									? "var(--gateway-posture-doctor-proof-color-1)"
									: "var(--gateway-posture-doctor-proof-color-2)",
								"--fixture-value-2": "13px",
							}}
						>
							{isApplied
								? `Applied · ${applied}`
								: `Preview · saved ${applied}`}
						</div>
					</div>

					<div className={proofStyles.fixture13}>
						<input
							aria-label="Gateway safety posture"
							className={proofStyles.fixture14}
							data-testid="posture-slider"
							max={2}
							min={0}
							onChange={(event) => setIndex(Number(event.target.value))}
							step={1}
							type="range"
							value={index}
						/>
						<div className={proofStyles.fixture15}>
							{GATEWAY_POSTURE_OPTIONS.map((option) => (
								<span
									className={proofStyles.dynamicFixture2}
									key={option.level}
									style={{
										"--fixture-value-3":
											option.level === selected.level
												? "var(--gateway-posture-doctor-proof-color-3)"
												: "var(--gateway-posture-doctor-proof-color-4)",
										"--fixture-value-4": "12px",
										"--fixture-value-5":
											option.level === selected.level ? 700 : 400,
									}}
								>
									{option.label}
								</span>
							))}
						</div>
					</div>

					<div className={proofStyles.fixture16}>
						<div className={proofStyles.fixture17} data-testid="gateway-policy">
							<div className={proofStyles.fixture18}>GATEWAY DETECTIONS</div>
							<strong className={proofStyles.fixture19}>
								{preview.firewall.policy}
							</strong>
						</div>
						<div className={proofStyles.fixture20} data-testid="core-approval">
							<div className={proofStyles.fixture21}>CORE APPROVALS</div>
							<strong className={proofStyles.fixture22}>
								{preview.approval}
							</strong>
						</div>
						<div className={proofStyles.fixture23}>
							<div className={proofStyles.fixture24}>RESOLVED STATE</div>
							<strong
								className={proofStyles.fixture25}
								data-testid="resolved-posture"
							>
								{preview.resolved}
							</strong>
						</div>
					</div>

					<div className={proofStyles.fixture26}>
						<button
							className={proofStyles.dynamicFixture3}
							data-testid="apply-posture"
							disabled={isApplied}
							onClick={() => setApplied(selected.level)}
							style={{
								"--fixture-value-6": isApplied
									? "var(--gateway-posture-doctor-proof-color-5)"
									: "var(--gateway-posture-doctor-proof-color-6)",
								"--fixture-value-7": 0,
								"--fixture-value-8": "9px",
								"--fixture-value-9": isApplied
									? "var(--gateway-posture-doctor-proof-color-4)"
									: "var(--gateway-posture-doctor-proof-color-7)",
								"--fixture-value-10": isApplied ? "default" : "pointer",
								"--fixture-value-11": 700,
								"--fixture-value-12": "10px 15px",
							}}
						>
							{isApplied ? "Applied" : "Apply posture"}
						</button>
					</div>
				</section>

				<section aria-label="Doctor report" className={proofStyles.fixture27}>
					<div className={proofStyles.fixture28}>
						<div>
							<div className={proofStyles.fixture29}>DOCTOR</div>
							<h2 className={proofStyles.fixture30}>
								Doctor audit + safe fixes
							</h2>
						</div>
						<div
							className={proofStyles.dynamicFixture4}
							data-testid="doctor-summary"
							style={{
								"--fixture-value-13": doctorHealthy
									? "var(--gateway-posture-doctor-proof-color-1)"
									: "var(--gateway-posture-doctor-proof-color-2)",
								"--fixture-value-14": "13px",
							}}
						>
							{doctorHealthy
								? "0 errors · 0 warnings · 5 check families"
								: "0 errors · 1 warning · 5 check families"}
						</div>
					</div>
					<div className={proofStyles.fixture31}>
						<button
							className={proofStyles.fixture32}
							data-testid="doctor-run"
							onClick={() => setDoctorRuns((runs) => runs + 1)}
						>
							Run audit{doctorRuns > 0 ? ` · ${doctorRuns}` : ""}
						</button>
						{doctorHealthy || doctorPreview ? null : (
							<button
								className={proofStyles.fixture33}
								data-testid="doctor-preview"
								onClick={() => setDoctorPreview(true)}
							>
								Preview safe fixes
							</button>
						)}
					</div>
					<div className={proofStyles.fixture34}>
						{DOCTOR_CHECKS.map(([category, label]) => (
							<div
								className={proofStyles.fixture35}
								data-testid={`doctor-${category}`}
								key={category}
							>
								<span
									className={proofStyles.dynamicFixture5}
									style={{
										"--fixture-value-15":
											category === "security" && !doctorHealthy
												? "var(--gateway-posture-doctor-proof-color-2)"
												: "var(--gateway-posture-doctor-proof-color-1)",
										"--fixture-value-16": "18px",
									}}
								>
									{category === "security" && !doctorHealthy ? "!" : "✓"}
								</span>
								<div>
									<div className={proofStyles.fixture36}>
										{category.toUpperCase()}
									</div>
									<div className={proofStyles.fixture37}>{label}</div>
								</div>
							</div>
						))}
					</div>
					<div
						className={proofStyles.dynamicFixture6}
						data-testid="doctor-safety-state"
						style={{
							"--fixture-value-17": doctorHealthy
								? "var(--gateway-posture-doctor-proof-color-8)"
								: "var(--gateway-posture-doctor-proof-color-9)",
							"--fixture-value-18": "10px",
							"--fixture-value-19": doctorHealthy
								? "var(--gateway-posture-doctor-proof-color-1)"
								: "var(--gateway-posture-doctor-proof-color-2)",
							"--fixture-value-20": "13px",
							"--fixture-value-21": "16px",
							"--fixture-value-22": "11px 13px",
						}}
					>
						{doctorHealthy
							? "Healthy · protective baseline is active"
							: doctorPreview
								? "Dry run · nothing changed · firewall.redact_pii will be enabled"
								: "At risk · safe redaction fix is available"}
					</div>
					{doctorPreview && !doctorHealthy ? (
						<div className={proofStyles.fixture38}>
							<strong className={proofStyles.fixture39}>Safe fix plan</strong>
							<div className={proofStyles.fixture40}>
								Enable PII and secret redaction · idempotent · no restart
							</div>
							<button
								className={proofStyles.fixture41}
								data-testid="doctor-apply"
								onClick={() => {
									setDoctorState("healthy");
									setDoctorPreview(false);
								}}
							>
								Apply safe fixes
							</button>
						</div>
					) : null}
					{doctorHealthy ? (
						<p className={proofStyles.fixture42} data-testid="doctor-applied">
							Applied 1 safe fix · report refreshed
						</p>
					) : null}
					<p className={proofStyles.fixture43}>
						The live implementation exposes the same report at
						<code className={proofStyles.fixture44}>GET /v1/doctor</code>{" "}
						{"and"}
						<code className={proofStyles.fixture45}>
							GET /api/gateway/doctor
						</code>
						and
						<code className={proofStyles.fixture46}>
							POST /api/gateway/doctor/fix · dryRun
						</code>
						.
					</p>
				</section>
			</div>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(
	<GatewayPostureDoctorProof />
);
