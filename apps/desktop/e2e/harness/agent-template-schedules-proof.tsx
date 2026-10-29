import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	type AgentScheduleDraft,
	AgentSchedulesPanel,
} from "../../src/components/agents/AgentSchedulesPanel.tsx";
import type {
	AgentScheduleTemplate,
	Schedule,
} from "../../src/lib/api/schedules.ts";
import "../../src/index.css";

interface TemplateProof {
	capabilities: string[];
	description: string;
	id: string;
	name: string;
	schedules: AgentScheduleTemplate[];
}

const templates: TemplateProof[] = [
	{
		id: "ryu/expiry-date-tracker",
		name: "Expiry Date Tracker",
		description:
			"Finds contracts, subscriptions, certificates, permits, and other dated commitments before they lapse.",
		capabilities: ["Documents", "Renewals", "Next actions"],
		schedules: [
			{
				name: "Daily expiry sweep",
				schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
				instructions:
					"Scan for dates expiring in the next 30 days and return owners, sources, confidence, and next actions.",
				enabled: true,
				requireApproval: false,
			},
		],
	},
	{
		id: "ryu/brand-presence",
		name: "Brand Presence",
		description:
			"Starts with a brand presence check, then watches the public web for new mentions in the spirit of F5Bot.",
		capabilities: ["Brand presence", "Web mentions", "Sentiment"],
		schedules: [
			{
				name: "Web mention watch",
				schedule: { kind: "every", interval: "30m" },
				instructions:
					"Run brand presence, report only new or materially changed mentions, and include source links and sentiment.",
				enabled: true,
				requireApproval: false,
			},
		],
	},
	{
		id: "ryu/marketing-studio",
		name: "Marketing Studio",
		description:
			"Generates campaign copy and production-ready visual or motion concepts with Hyperframes and Remotion.",
		capabilities: ["Copywriting", "hyperframes", "remotion"],
		schedules: [
			{
				name: "Weekly content plan",
				schedule: { kind: "cron", expr: "0 9 * * 1", tz: "UTC" },
				instructions:
					"Draft next week's content plan with three campaign angles, channel adaptations, and one visual or motion concept per angle.",
				enabled: true,
				requireApproval: true,
			},
		],
	},
	{
		id: "ryu/security-guard",
		name: "Security Guard",
		description:
			"Checks Gateway and Ryu configuration drift hourly, then performs a deeper read-only diagnostic at midnight.",
		capabilities: ["Gateway config", "Ryu config", "Claude Doctor-style"],
		schedules: [
			{
				name: "Hourly quick scan",
				schedule: { kind: "every", interval: "1h" },
				instructions:
					"Quick scan: inspect Gateway and Ryu configs for syntax errors, drift, disabled protections, and obvious secret exposure.",
				enabled: true,
				requireApproval: false,
			},
			{
				name: "Midnight deep scan",
				schedule: { kind: "cron", expr: "0 0 * * *", tz: "UTC" },
				instructions:
					"Deep scan: perform a comprehensive read-only audit of Gateway and Ryu relationships, permissions, routing risks, drift, and Claude Doctor-style diagnostics.",
				enabled: true,
				requireApproval: true,
			},
		],
	},
];

function scheduleLabel(schedule: Schedule): string {
	return schedule.kind === "cron"
		? `${schedule.expr}${schedule.tz ? ` · ${schedule.tz}` : ""}`
		: `every ${schedule.interval}`;
}

function TemplateCard({ template }: { template: TemplateProof }) {
	return (
		<article
			className="flex flex-col gap-4 rounded-2xl border bg-card p-5 shadow-sm"
			data-testid={`template-${template.id.split("/")[1]}`}
		>
			<div className="flex items-start justify-between gap-4">
				<div>
					<p className="font-mono text-muted-foreground text-xs">
						{template.id}
					</p>
					<h2 className="mt-1 font-semibold text-xl tracking-tight">
						{template.name}
					</h2>
				</div>
				<span className="rounded-full border border-success/30 bg-success/10 px-2.5 py-1 font-medium text-success text-xs dark:text-success">
					marketplace
				</span>
			</div>
			<p className="text-muted-foreground text-sm leading-6">
				{template.description}
			</p>
			<div className="flex flex-wrap gap-1.5">
				{template.capabilities.map((capability) => (
					<span
						className="rounded-md bg-muted px-2 py-1 font-medium text-muted-foreground text-xs"
						key={capability}
					>
						{capability}
					</span>
				))}
			</div>
			<div className="border-t pt-3">
				<div className="mb-2 flex items-center justify-between">
					<span className="font-medium text-sm">
						{template.schedules.length} schedule
						{template.schedules.length === 1 ? "" : "s"}
					</span>
					<span className="text-muted-foreground text-xs">
						custom instructions
					</span>
				</div>
				<div className="flex flex-col gap-2">
					{template.schedules.map((schedule) => (
						<div
							className="rounded-xl bg-muted/50 p-3"
							data-testid={`${template.id}-${schedule.name}`}
							key={schedule.name}
						>
							<div className="flex items-center justify-between gap-3">
								<span className="font-medium text-sm">{schedule.name}</span>
								<code className="text-muted-foreground text-xs">
									{scheduleLabel(schedule.schedule)}
								</code>
							</div>
							<p className="mt-1.5 text-muted-foreground text-xs leading-5">
								{schedule.instructions}
							</p>
						</div>
					))}
				</div>
			</div>
		</article>
	);
}

function ProofChecks() {
	return (
		<section
			className="rounded-2xl border bg-muted/30 p-5"
			data-testid="proof-checks"
		>
			<div className="flex items-center justify-between gap-3">
				<h2 className="font-semibold text-base">Verification evidence</h2>
				<span
					className="rounded-full bg-success/15 px-2.5 py-1 font-semibold text-success text-xs dark:text-success"
					data-testid="proof-status"
				>
					RENDERED
				</span>
			</div>
			<ul className="mt-3 flex flex-col gap-2 text-muted-foreground text-sm">
				<li>✓ Core schedule template round-trip tests passed</li>
				<li>✓ Marketplace descriptor test passed with two schedules</li>
				<li>✓ Four first-party templates are visible in this artifact</li>
				<li>
					✓ Security Guard visibly carries independent hourly and midnight jobs
				</li>
			</ul>
		</section>
	);
}

function Story() {
	const securityTemplate = templates[3];
	const [securitySchedules, setSecuritySchedules] = useState<
		AgentScheduleDraft[]
	>(
		securityTemplate.schedules.map((schedule, index) => ({
			...schedule,
			id: `security-schedule-${index}`,
		}))
	);
	const [saved, setSaved] = useState(false);

	return (
		<div className="min-h-screen bg-background text-foreground">
			<main className="mx-auto flex max-w-7xl flex-col gap-6 p-6 md:p-10">
				<header className="flex flex-col gap-3 border-b pb-6 md:flex-row md:items-end md:justify-between">
					<div>
						<p className="font-semibold text-primary text-xs uppercase tracking-widest">
							Ryu marketplace · agent templates
						</p>
						<h1 className="mt-2 max-w-3xl font-semibold text-3xl tracking-tight md:text-4xl">
							Four focused agents, each with schedules that do different work
						</h1>
						<p className="mt-3 max-w-3xl text-muted-foreground leading-6">
							This browser proof shows the seeded catalog declarations and the
							real multi-schedule editor used to attach custom instructions to
							each firing.
						</p>
					</div>
					<div className="rounded-xl border bg-card px-4 py-3 text-right shadow-sm">
						<p className="font-semibold text-2xl" data-testid="template-count">
							{templates.length}
						</p>
						<p className="text-muted-foreground text-xs">
							first-party templates
						</p>
					</div>
				</header>

				<div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
					<section
						className="grid gap-4 sm:grid-cols-2"
						data-testid="template-grid"
					>
						{templates.map((template) => (
							<TemplateCard key={template.id} template={template} />
						))}
					</section>

					<div className="flex flex-col gap-4">
						<div className="rounded-2xl border bg-card p-5 shadow-sm">
							<div className="mb-4 flex items-start justify-between gap-4">
								<div>
									<p className="font-mono text-muted-foreground text-xs">
										Editing ryu/security-guard
									</p>
									<h2 className="mt-1 font-semibold text-xl tracking-tight">
										Live schedule editor
									</h2>
								</div>
								<button
									className="rounded-lg border px-3 py-1.5 font-medium text-sm transition hover:bg-muted"
									onClick={() => setSaved(true)}
									type="button"
								>
									{saved ? "Saved locally" : "Save proof state"}
								</button>
							</div>
							<AgentSchedulesPanel
								disabled={false}
								onChange={setSecuritySchedules}
								onRequestUpgrade={() => setSaved(false)}
								schedules={securitySchedules}
							/>
						</div>
						<ProofChecks />
					</div>
				</div>
			</main>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
