import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import "@fontsource-variable/inter";
import { AppPermissionsEditor } from "@/src/components/store/AppPermissionsEditor.tsx";
import "../../src/index.css";

function Proof() {
	const [approved, setApproved] = useState(["usage:read"]);
	const refreshGrants = async () => {
		const response = await fetch("/proof/grants");
		const result = z
			.object({ grants: z.array(z.string()) })
			.safeParse(await response.json());
		if (result.success) {
			setApproved(result.data.grants);
		}
	};
	return (
		<ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
			<main className="mx-auto flex min-h-svh w-full max-w-2xl flex-col justify-center gap-6 px-6 py-12">
				<header>
					<p className="text-muted-foreground text-sm">Installed apps</p>
					<h1 className="font-semibold text-2xl">Video Studio</h1>
					<p className="text-muted-foreground text-sm">
						Optional access stays off until you approve it.
					</p>
				</header>
				<AppPermissionsEditor
					app={{
						id: "@ryu/video-studio",
						name: "Video Studio",
						enabled: true,
						permissionGrants: ["usage:read"],
						optionalPermissionGrants: ["usage:audit"],
						approvedGrants: approved,
					}}
					onGrantsChanged={refreshGrants}
					target={{ url: "http://127.0.0.1:5299", token: "proof-control" }}
				/>
				<p className="text-muted-foreground text-sm">
					Editing remains available. Generation budgets use estimates while
					audit receipts are unavailable.
				</p>
			</main>
		</ThemeProvider>
	);
}
createRoot(document.getElementById("root")!).render(<Proof />);
