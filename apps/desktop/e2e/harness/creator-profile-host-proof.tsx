import { CreatorProfileEditor } from "@ryu/marketplace/creators/profile-editor";
import { createRoot } from "react-dom/client";
import { WebMarketplaceHost } from "../../../web/src/components/marketplace/host.tsx";
import { DesktopMarketplaceHost } from "../../src/components/marketplace/host.tsx";
import "../../src/index.css";
const surface = new URLSearchParams(location.search).get("surface");
localStorage.setItem("creator-proof-token", "fixture-bearer");
const Host = surface === "web" ? WebMarketplaceHost : DesktopMarketplaceHost;
createRoot(document.getElementById("root")!).render(
	<main className="mx-auto max-w-2xl p-8">
		<Host>
			<CreatorProfileEditor />
		</Host>
	</main>
);
