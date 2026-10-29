import { createRoot } from "react-dom/client";
import { CrmPanel } from "@/src/components/panels/crm/CrmPanel.tsx";
import "./crm-record-table-proof.css";

const root = document.getElementById("root");
if (!root) {
	throw new Error("Root element not found");
}

createRoot(root).render(
	<div className="dark min-h-screen bg-background text-foreground">
		<header className="flex h-12 items-center border-b px-5">
			<span className="font-medium text-sm">Harbor</span>
			<span className="mx-2 text-muted-foreground">/</span>
			<span className="text-muted-foreground text-sm">CRM dock panel</span>
		</header>
		<main className="mx-auto h-[calc(100vh-3rem)] w-full max-w-7xl">
			<CrmPanel />
		</main>
	</div>
);
