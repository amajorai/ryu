import ProfileSettings from "@ryu/blocks/web/profile-settings.tsx";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<main className="h-screen overflow-y-auto bg-background text-foreground">
			<ProfileSettings />
		</main>
	);
}
