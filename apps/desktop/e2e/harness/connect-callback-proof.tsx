import { Button } from "@ryu/ui/components/button.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectCallbackDialog } from "../../src/components/deeplink/ConnectCallbackDialog.tsx";
import "../../src/index.css";

function Story() {
	const [open, setOpen] = useState(true);
	const [calls, setCalls] = useState(0);
	return (
		<main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background text-foreground">
			<h1>Connect callback confirmation</h1>
			<p>Isolated UI proof — no provider account is contacted.</p>
			<p data-testid="completion-count">Completion attempts: {calls}</p>
			<Button onClick={() => setOpen(true)}>Open callback</Button>
			{open ? (
				<ConnectCallbackDialog
					nodes={[
						{ name: "Personal", url: "http://localhost:7980" },
						{ name: "Unavailable", url: "https://unavailable.example.test" },
					]}
					onClose={() => setOpen(false)}
					onComplete={async (node) => {
						setCalls((value) => value + 1);
						await new Promise((resolve) => setTimeout(resolve, 300));
						if (node.name === "Unavailable") {
							throw new Error("fixture unavailable");
						}
					}}
				/>
			) : null}
		</main>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing proof root");
}
createRoot(root).render(<Story />);
