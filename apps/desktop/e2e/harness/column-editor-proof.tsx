import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { createRoot } from "react-dom/client";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import SpaceDatabaseEditorPage from "@/src/pages/SpaceDatabaseEditorPage.tsx";
import "./column-editor-proof.css";

document.documentElement.classList.add("dark");

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing proof root");
}
createRoot(root).render(
	<div className="dark h-screen bg-background text-foreground">
		<MemoryRouter>
			<Routes>
				<Route
					element={
						<Link to="/spaces/space-proof/db/database-proof">
							Open project database
						</Link>
					}
					path="/"
				/>
				<Route
					element={
						<SpaceDatabaseEditorPage
							databaseId="database-proof"
							spaceId="space-proof"
						/>
					}
					path="/spaces/space-proof/db/database-proof"
				/>
			</Routes>
		</MemoryRouter>
		<Toaster />
	</div>
);
