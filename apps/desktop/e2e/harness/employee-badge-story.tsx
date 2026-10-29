// Standalone browser story for the REAL EmployeeBadge — the agent-as-employee
// card on the desktop Agents page, now built on the same `PassCardShell` as the
// waitlist pass. Rendered in both themes because the shell's metal ring and
// dither backdrop are tuned per scheme.

import { EmployeeBadge } from "@ryu/ui/components/employee-badge.tsx";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

function Column({ dark, label }: { dark: boolean; label: string }) {
	return (
		<div
			className={`${dark ? "dark" : ""} flex-1 bg-background p-8 text-foreground`}
		>
			<p className="mb-6 font-medium text-muted-foreground text-xs uppercase tracking-widest">
				{label}
			</p>
			<div className="w-[20rem]">
				<EmployeeBadge
					employeeId="agt_9f3a2b71"
					hiredAt="2026-03-14T19:30:00.000Z"
					level={7}
					metalTheme={dark ? "dark" : "light"}
					name="Grace Hopper"
					stats={[
						{ label: "Tokens", value: "1.2M" },
						{ label: "Requests", value: "8,410" },
						{ label: "Streak", value: "23d" },
					]}
				/>
			</div>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(
	<div className="flex min-h-screen">
		<Column dark={false} label="Light" />
		<Column dark label="Dark" />
	</div>
);
