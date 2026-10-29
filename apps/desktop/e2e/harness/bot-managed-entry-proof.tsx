import { I18nProvider } from "@ryu/i18n/react";
import { createRoot } from "react-dom/client";
import { BotManagedEntry } from "../../src/components/bot/BotManagedEntry.tsx";
import "../../src/index.css";
const element = document.getElementById("root");
if (!element) {
	throw new Error("Missing Bot entry proof root");
}
createRoot(element).render(
	<I18nProvider packs={[]}>
		<main className="h-svh bg-background text-foreground">
			<BotManagedEntry />
		</main>
	</I18nProvider>
);
