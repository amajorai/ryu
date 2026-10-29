import { Button } from "@ryu/ui/components/button.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LoginApprovalEvents } from "../../src/hooks/useLoginApprovalEvents.tsx";
import { setFixtureUser } from "./approval-session-fixture.ts";
import "../../src/index.css";
function Story() {
	const [mounted, setMounted] = useState(true);
	return (
		<main className="min-h-screen bg-background p-8 text-foreground">
			<div className="flex gap-2">
				<Button onClick={() => setFixtureUser("second-fixture")}>
					Switch fixture account
				</Button>
				<Button onClick={() => setMounted(!mounted)}>
					{mounted ? "Unmount listener" : "Mount listener"}
				</Button>
			</div>
			{mounted ? <LoginApprovalEvents /> : null}
		</main>
	);
}
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
