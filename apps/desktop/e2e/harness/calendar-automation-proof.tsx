import { createRoot } from "react-dom/client";
import { AgentCalendarView } from "@/src/components/agents/AgentCalendarView.tsx";
import "./calendar-automation-proof.css";

function CalendarAutomationProof() {
	const agentId =
		new URLSearchParams(window.location.search).get("agent") ?? "agent-daily";
	const agentName =
		agentId === "agent-release" ? "Release Watch" : "Daily Brief";

	return (
		<div className="dark min-h-screen bg-background text-foreground">
			<header className="flex h-12 items-center border-b px-5">
				<span className="font-medium text-sm">Calendar</span>
				<span className="mx-2 text-muted-foreground">/</span>
				<span className="text-muted-foreground text-sm">
					{agentName} schedule
				</span>
			</header>
			<main className="mx-auto h-[calc(100vh-3rem)] w-full max-w-7xl p-5">
				<AgentCalendarView agentId={agentId} />
			</main>
		</div>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Root element not found");
}

createRoot(root).render(<CalendarAutomationProof />);
