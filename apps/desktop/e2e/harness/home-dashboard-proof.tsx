import { createRoot } from "react-dom/client";
import HomePage from "../../src/pages/HomePage.tsx";
import { AssistantProbe } from "./home-dashboard-proof/assistant-probe.tsx";
import { HomeDashboardTitleBar } from "./home-dashboard-proof/titlebar.tsx";
import "../../src/index.css";

function HomeDashboardProof() {
	return (
		<HomeDashboardTitleBar>
			<main className="h-[calc(100vh-52px)] bg-background text-foreground">
				<HomePage />
			</main>
			<AssistantProbe />
		</HomeDashboardTitleBar>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Home dashboard proof root is missing");
}
createRoot(root).render(<HomeDashboardProof />);

document.body.setAttribute("data-home-dashboard-proof-ready", "1");
