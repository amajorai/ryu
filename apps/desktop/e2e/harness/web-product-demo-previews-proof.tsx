import { createRoot } from "react-dom/client";
import {
	DeploymentPreview,
	ToolAccessPreview,
} from "../../../../packages/blocks/src/web/product-demo-previews.tsx";
import "../../src/index.css";

const compact =
	new URLSearchParams(window.location.search).get("compact") === "1";
const root = document.getElementById("root");
if (!root) {
	throw new Error("The Web preview proof root is missing.");
}

createRoot(root).render(
	<main className="mx-auto grid max-w-5xl gap-8 p-8 md:grid-cols-2">
		<ToolAccessPreview compact={compact} />
		<DeploymentPreview compact={compact} />
	</main>
);
