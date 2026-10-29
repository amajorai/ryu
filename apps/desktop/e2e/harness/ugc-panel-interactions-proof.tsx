import { createRoot } from "react-dom/client";
import { UgcPanel } from "@/src/components/panels/UgcPanel.tsx";
import { useProductModeStore } from "@/src/lib/product-mode.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import "../../src/index.css";

// Gateway opens only in Console; grant the access App's ProductModeAccessSync
// would grant a local node.
useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });

function GatewayIntentProof() {
	const open = useGatewayDialog((state) => state.open);
	const section = useGatewayDialog((state) => state.section);
	return (
		<output
			data-open={String(open)}
			data-section={section}
			data-testid="gateway-intent"
		/>
	);
}

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);

const root = document.getElementById("root");
if (!root) {
	throw new Error("UGC proof root is missing");
}

createRoot(root).render(
	<div className="h-screen min-h-0 bg-background text-foreground">
		<UgcPanel />
		<GatewayIntentProof />
	</div>
);
