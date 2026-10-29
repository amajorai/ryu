import "@fontsource-variable/inter";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { installHorizontalWheelScrolling } from "@ryu/ui/lib/horizontal-wheel-scroll.ts";
import { MotionConfig } from "motion/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Island } from "./components/Island.tsx";
import { IslandI18nProvider } from "./components/IslandI18nProvider.tsx";
import "./index.css";

const container = document.getElementById("root");
if (!container) {
	throw new Error("Root element #root not found");
}

installHorizontalWheelScrolling(document);

createRoot(container).render(
	<StrictMode>
		<MotionConfig reducedMotion="user">
			<IslandI18nProvider>
				<Island />
			</IslandI18nProvider>
		</MotionConfig>
	</StrictMode>
);
