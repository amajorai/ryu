// Browser story for keyboard use of the REAL EmployeeBadge: one badge that
// opens something (as a Stats "Your team" roster badge opens the agent's
// profile) between two ordinary buttons, and one badge that opens nothing (as
// the badge on an agent's own profile). The roster sits in a scrolling pane
// taller than the viewport, as the Settings content pane is (the app's body
// itself never scrolls), so a Space press that scrolled it would show in the
// pane's `scrollTop`.

import { EmployeeBadge } from "@ryu/ui/components/employee-badge.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

// `EmployeeBadge`'s `role` prop is the agent's job title, not an ARIA role.
const GRACE_JOB_TITLE = "Compiler engineer";

const STATS = [
	{ label: "Tokens", value: "1.2M" },
	{ label: "Requests", value: "8,410" },
	{ label: "Streak", value: "23d" },
];

function Story() {
	const [opened, setOpened] = useState(0);
	return (
		<main
			className="h-screen overflow-y-auto bg-background text-foreground"
			data-testid="pane"
		>
			<div className="min-h-[300vh] p-8">
				<button className="rounded-lg border px-3 py-2 text-sm" type="button">
					Before the roster
				</button>
				<output className="ml-4 text-sm" data-testid="opened">
					{opened}
				</output>
				<div className="mt-6 flex gap-6">
					<div className="w-[20rem]">
						<EmployeeBadge
							employeeId="agt_9f3a2b71"
							level={7}
							metalTheme="light"
							name="Grace Hopper"
							onClick={() => setOpened((count) => count + 1)}
							ringed={false}
							role={GRACE_JOB_TITLE}
							stats={STATS}
							still
						/>
					</div>
					<div className="w-[20rem]">
						<EmployeeBadge
							employeeId="agt_4c1d0e22"
							level={3}
							metalTheme="light"
							name="Ada Lovelace"
							ringed={false}
							stats={STATS}
							still
						/>
					</div>
				</div>
				<button
					className="mt-6 rounded-lg border px-3 py-2 text-sm"
					type="button"
				>
					After the roster
				</button>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
