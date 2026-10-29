import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
	Link,
	MemoryRouter,
	Route,
	Routes,
	useNavigate,
	useParams,
} from "react-router-dom";
import SpaceDatabaseEditorPage from "@/src/pages/SpaceDatabaseEditorPage.tsx";
import SpaceDatabaseRowPage from "@/src/pages/SpaceDatabaseRowPage.tsx";
import "./database-row-proof.css";

document.documentElement.classList.add("dark");
function RowRoute() {
	const { rowId } = useParams();
	return (
		<SpaceDatabaseRowPage
			databaseId="database-proof"
			rowId={rowId ?? ""}
			spaceId="space-proof"
		/>
	);
}
function RouteHost() {
	const navigate = useNavigate();
	useEffect(() => {
		const handler = (event: Event) =>
			navigate(
				/* SAFETY: database-row-proof.bridge.ts openTab publishes this private row-proof-open-tab CustomEvent with its actual string path argument; RouteHost consumes that controlled navigation event. */ (
					event as CustomEvent<string>
				).detail
			);
		window.addEventListener("row-proof-open-tab", handler);
		return () => window.removeEventListener("row-proof-open-tab", handler);
	}, [navigate]);
	return (
		<Routes>
			<Route
				element={
					<div>
						<Link to="/spaces/space-proof/db/database-proof">
							Open project database
						</Link>
						<Link to="/spaces/space-proof/db/database-proof/row/missing-row">
							Open missing row
						</Link>
					</div>
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
			<Route
				element={<RowRoute />}
				path="/spaces/space-proof/db/database-proof/row/:rowId"
			/>
		</Routes>
	);
}
const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing proof root");
}
createRoot(root).render(
	<div className="dark h-screen bg-background text-foreground">
		<MemoryRouter>
			<RouteHost />
		</MemoryRouter>
		<Toaster />
	</div>
);
