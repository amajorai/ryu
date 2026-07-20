import "@fontsource-variable/inter";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Island } from "./components/Island.tsx";
import "./index.css";

const container = document.getElementById("root");
if (!container) {
	throw new Error("Root element #root not found");
}

createRoot(container).render(
	<StrictMode>
		<Island />
	</StrictMode>
);
