import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card.tsx";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs.tsx";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const params = new URLSearchParams(location.search);
const mode = params.get("mode");
const sections = [
	"Profile",
	"Account",
	"Notifications",
	"Connections",
	"Sessions",
	"Support Access",
];
const groups = [
	"Personal details",
	"Preferences",
	"Language",
	"Appearance",
	"Privacy",
	"Connected services",
	"Recent activity",
	"Account history",
];

document.documentElement.classList.toggle("dark", params.has("dark"));

function StickyTabsStory() {
	return (
		<main
			className="h-screen overflow-y-auto bg-background text-foreground"
			data-testid="scroll-area"
		>
			{params.has("offset") ? (
				<div className="sticky top-0 z-30 flex h-12 items-center bg-muted px-6 font-medium">
					Ryu
				</div>
			) : null}
			<div className="mx-auto max-w-4xl px-6 pb-8">
				<header className="py-8">
					<h1 className="font-semibold text-2xl">Account Settings</h1>
					<p className="mt-2 text-muted-foreground">
						Update your profile and manage your account.
					</p>
				</header>
				<Tabs
					defaultValue="Profile"
					orientation={mode === "vertical" ? "vertical" : "horizontal"}
				>
					<TabsList
						aria-label="Settings sections"
						className="w-full justify-start"
						manageLayout={mode !== "scroll"}
						persistLayout={false}
						sticky={mode !== "plain"}
						stickyOffset={params.has("offset") ? 48 : 0}
						variant="pills"
					>
						{sections.map((section) => (
							<TabsTrigger key={section} value={section}>
								{section}
							</TabsTrigger>
						))}
					</TabsList>
					{sections.map((section) => (
						<TabsContent key={section} layout="sticky-showcase" value={section}>
							{groups.map((group) => (
								<Card className="min-h-44" key={group}>
									<CardHeader>
										<CardTitle>
											{section} · {group}
										</CardTitle>
									</CardHeader>
									<CardContent status="muted">
										Your {group.toLowerCase()} and account information.
									</CardContent>
								</Card>
							))}
						</TabsContent>
					))}
				</Tabs>
				<footer className="min-h-screen pt-8 text-muted-foreground">
					Ryu account settings
				</footer>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<StickyTabsStory />);
}
