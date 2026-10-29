import { Button } from "@ryu/ui/components/button.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { GatewayWebAccounts } from "../../src/components/gateway/GatewayWebAccounts.tsx";
import "../../src/index.css";

function Proof() {
	const [node, setNode] = useState("first");
	const [role, setRole] = useState<"admin" | "viewer" | "none">("admin");
	return (
		<main className="min-h-screen bg-background px-5 py-8 text-foreground">
			<div className="mx-auto flex max-w-4xl flex-col gap-5">
				<header className="flex flex-wrap items-center justify-between gap-3">
					<h1 className="font-semibold text-2xl">Gateway settings</h1>
					<div className="flex gap-2">
						<Button
							onClick={() => setNode(node === "first" ? "second" : "first")}
							size="sm"
							variant="outline"
						>
							Switch node
						</Button>
						<Button
							onClick={() => setRole("viewer")}
							size="sm"
							variant="outline"
						>
							Viewer role
						</Button>
						<Button onClick={() => setRole("none")} size="sm" variant="outline">
							No view permission
						</Button>
					</div>
				</header>
				<div data-testid="web-accounts-product">
					<GatewayWebAccounts
						canConfigure={role === "admin"}
						canView={role !== "none"}
						target={{ url: `${window.location.origin}/${node}`, token: null }}
						webServiceSchema={1}
					/>
				</div>
			</div>
		</main>
	);
}
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Proof />);
}
