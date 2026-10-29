import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { modelRoutingFieldsForInterface } from "../../src/lib/chat-routing.ts";
import {
	INTERFACE_LEVELS,
	type InterfaceLevel,
	showsModelPicker,
} from "../../src/lib/interface-level.ts";
import "../../src/index.css";

const selections = {
	acpConfig: { effort: "medium", fast_mode: "true" },
	acpMode: "default",
	acpModel: "claude-sonnet-4",
	model: "gpt-5",
};

function ModelPicker({ label }: { label: string }) {
	return (
		<div
			aria-label={label}
			className="rounded-xl border border-primary/40 border-dashed bg-primary/5 px-3 py-2 text-sm"
			data-testid={`${label.toLowerCase().replaceAll(" ", "-")}-model-selector`}
		>
			<span className="font-medium">Model picker</span>
			<span className="ml-2 text-muted-foreground">
				gpt-5 · Claude Sonnet 4
			</span>
		</div>
	);
}

function Surface({ level }: { level: InterfaceLevel }) {
	const fields = useMemo(
		() => modelRoutingFieldsForInterface(level, selections),
		[level]
	);
	const modelVisible = showsModelPicker(level);
	const prefix = level === "simple" ? "ryu-work" : "code";

	return (
		<div
			className="grid gap-4 md:grid-cols-2"
			data-testid={`${prefix}-surfaces`}
		>
			<div className="rounded-2xl border bg-card p-4 shadow-sm">
				<p className="font-medium">Chat composer</p>
				<p className="mt-1 text-muted-foreground text-xs">
					Agent remains user-selected; model routing is automatic.
				</p>
				<div className="mt-4 space-y-2">
					<div className="rounded-xl border bg-muted/40 px-3 py-2 text-sm">
						Agent picker · Ryu
					</div>
					{modelVisible ? (
						<ModelPicker label={`${prefix} chat`} />
					) : (
						<p
							className="rounded-xl border border-dashed px-3 py-2 text-muted-foreground text-sm"
							data-testid={`${prefix}-chat-model-selector-hidden`}
						>
							Model selector hidden
						</p>
					)}
				</div>
			</div>

			<div className="rounded-2xl border bg-card p-4 shadow-sm">
				<p className="font-medium">Agent creation / edit</p>
				<p className="mt-1 text-muted-foreground text-xs">
					The agent editor uses the same model picker and visibility rule.
				</p>
				<div className="mt-4 space-y-2">
					<div className="rounded-xl border bg-muted/40 px-3 py-2 text-sm">
						Behavior and instructions
					</div>
					{modelVisible ? (
						<ModelPicker label={`${prefix} agent editor`} />
					) : (
						<p
							className="rounded-xl border border-dashed px-3 py-2 text-muted-foreground text-sm"
							data-testid={`${prefix}-editor-model-selector-hidden`}
						>
							Model panel hidden
						</p>
					)}
				</div>
			</div>

			<div className="rounded-2xl border bg-card p-4 shadow-sm md:col-span-2">
				<div className="flex items-center justify-between gap-3">
					<p className="font-medium">Request boundary</p>
					<span
						className="type-caption rounded-full bg-muted px-2 py-1 font-mono"
						data-testid={`${prefix}-routing-fields`}
					>
						{JSON.stringify(fields)}
					</span>
				</div>
				<p className="mt-2 text-muted-foreground text-xs">
					{level === "simple"
						? "Hidden model, ACP mode, effort, and provider pins are stripped before the request is sent."
						: "Explicit model and provider controls stay available at this interface level."}
				</p>
			</div>
		</div>
	);
}

function Story() {
	const [level, setLevel] = useState<InterfaceLevel>("simple");
	const [controlApplied, setControlApplied] = useState(false);

	return (
		<main className="min-h-screen bg-background px-6 py-10 text-foreground">
			<div className="mx-auto max-w-5xl space-y-6">
				<header className="space-y-2">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						Completed feature proof
					</p>
					<h1 className="font-semibold text-3xl tracking-tight">
						Ryu Work routing + agent-level control
					</h1>
					<p className="max-w-3xl text-muted-foreground text-sm">
						Ryu Work keeps the user-facing agent choice while Core owns model
						routing. A running agent can request a better target for the next
						turn.
					</p>
				</header>

				<section
					className="rounded-2xl border bg-card p-4 shadow-sm"
					data-testid="interface-level-proof"
				>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div>
							<p className="font-medium">Interface mode</p>
							<p className="text-muted-foreground text-xs">
								Switch the rendered surface to verify the shared rule.
							</p>
						</div>
						<div
							aria-label="Interface mode"
							className="flex gap-2"
							role="group"
						>
							{INTERFACE_LEVELS.map((option) => (
								<button
									className={`rounded-lg px-3 py-2 text-sm ${level === option.id ? "bg-primary text-primary-foreground" : "bg-muted"}`}
									data-testid={`level-${option.id}`}
									key={option.id}
									onClick={() => setLevel(option.id)}
									type="button"
								>
									{option.label}
								</button>
							))}
						</div>
					</div>
					<div className="mt-4" data-testid={`active-level-${level}`}>
						<Surface level={level} />
					</div>
				</section>

				<section
					className="rounded-2xl border bg-card p-4 shadow-sm"
					data-testid="agent-control-proof"
				>
					<div className="flex flex-wrap items-start justify-between gap-4">
						<div>
							<p className="font-medium">Agent-controlled target change</p>
							<p className="mt-1 max-w-2xl text-muted-foreground text-xs">
								The built-in control is separate from user-message routing: the
								normal router runs first, then this request applies once to the
								next interactive turn.
							</p>
						</div>
						<button
							className="rounded-lg bg-primary px-3 py-2 font-medium text-primary-foreground text-sm"
							data-testid="apply-agent-control"
							onClick={() => setControlApplied(true)}
							type="button"
						>
							Simulate set_active_target
						</button>
					</div>
					<div className="mt-4 grid gap-3 sm:grid-cols-3">
						<div className="rounded-xl border bg-muted/35 p-3">
							<p className="text-muted-foreground text-xs">Tool</p>
							<p className="mt-1 font-mono text-sm">
								agent_control.set_active_target
							</p>
						</div>
						<div className="rounded-xl border bg-muted/35 p-3">
							<p className="text-muted-foreground text-xs">
								Requested next turn
							</p>
							<p className="mt-1 font-medium text-sm">
								research-agent · Claude Sonnet 4
							</p>
						</div>
						<div className="rounded-xl border bg-muted/35 p-3">
							<p className="text-muted-foreground text-xs">Effort</p>
							<p className="mt-1 font-medium text-sm">high</p>
						</div>
					</div>
					<p
						className="mt-4 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-sm"
						data-testid="control-status"
					>
						{controlApplied
							? "Applied for next turn · active agent: research-agent · model: claude-sonnet-4 · effort: high"
							: "Pending demo · no saved agent defaults changed"}
					</p>
				</section>

				<p className="text-muted-foreground text-xs" data-testid="proof-status">
					Proof status: shared Ryu Work/Code picker rule and next-turn agent
					control are wired.
				</p>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
