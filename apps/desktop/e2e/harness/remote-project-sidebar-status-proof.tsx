import { Folder03Icon } from "@hugeicons/core-free-icons";
import { type ComponentProps, useState } from "react";
import { createRoot } from "react-dom/client";
import { SubSection } from "../../src/components/layout/AppSidebar.tsx";
import { RemoteProjectStatus } from "../../src/components/layout/remote-project-status.tsx";
import "../../src/index.css";
import { IDLE_REORDER_SHIFT } from "@ryu/ui/hooks/use-reorder-shift.tsx";

type RemoteState = "checking" | "offline" | "online";

const PROJECTS = [
	{ label: "codex-testing", remote: true },
	{ label: "hello", remote: true },
	{ label: "work", remote: true },
	{ label: "local-notes", remote: false },
] as const;

const DND = {
	draggingKey: null,
	dragOverKey: null,
	onDragEnd: () => undefined,
	onDragOver: () => undefined,
	onDragStart: () => undefined,
	onDrop: () => undefined,
	shift: IDLE_REORDER_SHIFT,
	order: [],
} satisfies ComponentProps<typeof SubSection>["dnd"];

function onlineValue(state: RemoteState): boolean | null {
	if (state === "checking") {
		return null;
	}
	return state === "online";
}

function Story() {
	const [state, setState] = useState<RemoteState>("online");
	return (
		<main
			className="dark min-h-screen bg-background px-5 py-8 text-foreground"
			data-harness-ready="1"
			data-testid="remote-project-sidebar-status-proof"
		>
			<div className="mx-auto w-full max-w-sm">
				<p className="px-2 text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
					Sidebar preview
				</p>
				<div className="mt-3 rounded-2xl border border-border bg-sidebar p-2 shadow-lg">
					<div className="px-2 py-2 font-medium text-muted-foreground text-xs">
						Projects
					</div>
					<div className="space-y-0.5" data-testid="project-rows">
						{PROJECTS.map((project) => (
							<SubSection
								collapsed
								dnd={DND}
								icon={Folder03Icon}
								key={project.label}
								label={project.label}
								onToggleCollapsed={() => undefined}
								sectionKey={project.label}
								size="md"
								testId={`project-row-${project.label}`}
								trailing={
									project.remote ? (
										<RemoteProjectStatus
											nodeName="vm"
											online={onlineValue(state)}
										/>
									) : undefined
								}
							>
								{null}
							</SubSection>
						))}
					</div>
				</div>

				<div className="mt-5 rounded-xl border border-border bg-card p-3">
					<div className="flex items-center justify-between gap-3">
						<div>
							<p className="font-medium text-sm">Remote node status</p>
							<p className="mt-1 text-muted-foreground text-xs">
								The active node drives every remote project row.
							</p>
						</div>
						<span
							className="rounded-full bg-muted px-2 py-1 text-muted-foreground text-xs"
							data-testid="current-state"
						>
							{state}
						</span>
					</div>
					<div className="mt-3 flex gap-2">
						{(["online", "checking", "offline"] as const).map((option) => (
							<button
								className="rounded-lg border border-border px-2.5 py-1.5 text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								data-active={state === option ? "true" : undefined}
								key={option}
								onClick={() => setState(option)}
								type="button"
							>
								{option[0].toUpperCase() + option.slice(1)}
							</button>
						))}
					</div>
				</div>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
