import { I18nProvider } from "@ryu/i18n/react";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { OpenSourceLicensesSettings } from "../../../src/components/settings/OpenSourceLicensesSettings.tsx";
import "../../../src/index.css";
const element = document.getElementById("root");
if (!element) {
	throw new Error("Missing legal-reader proof root");
}
const proofRoot = createRoot(element);
Reflect.set(window, "__licenseReaderUnmount", () => proofRoot.unmount());
proofRoot.render(
	<I18nProvider>
		<ThemeProvider attribute="class" defaultTheme="dark">
			<main className="p-8">
				<OpenSourceLicensesSettings />
			</main>
		</ThemeProvider>
	</I18nProvider>
);
