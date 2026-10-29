// Standalone browser story for the settings grouped-navigation primitives
// (`packages/blocks/src/desktop/settings-nav.tsx`): the tinted icon tiles, the
// index list of chevron rows, and the push-to-a-sub-page transition.
//
// Why a real browser rather than a render test: every claim here is a LAYOUT or
// AFFORDANCE claim. That the whole row is one click target depends on an
// absolutely-positioned overlay resolving against the row (it needs `relative`
// on the row, which is exactly the kind of thing a snapshot test passes on and a
// user notices immediately). That the tile reads as a landmark rather than
// decoration depends on the real Tailwind colour utilities being applied. And
// that a sub-page can be entered and left without the pane jumping is a question
// about two rendered states, not about markup.
//
// Two cases from one page, selected by query string:
//   (default)      the index — intro, tiled nav rows, outro
//   ?open=motion   the same pane with a sub-page pushed (back button + title)
//
import {
	BubbleChatIcon,
	ComputerIcon,
	Delete02Icon,
	Folder01Icon,
	SparklesIcon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@ryu/blocks/desktop/settings-items.tsx";
import {
	SettingsIconTile,
	SettingsSubpages,
} from "@ryu/blocks/desktop/settings-nav.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

/** A page body shaped like the real ones: a section, a card of rows, a caption. */
function DemoPage({ rows }: { rows: string[] }) {
	return (
		<SettingsSection
			caption="Every row here is a real SettingsItem, so the hairlines, paddings and footer captions are the shipped ones."
			title="Options"
		>
			<SettingsGroup>
				{rows.map((row) => (
					<SettingsItem actions={<Switch />} key={row} title={row} />
				))}
			</SettingsGroup>
		</SettingsSection>
	);
}

function Story() {
	const params = new URLSearchParams(window.location.search);
	// Controlled so the query string can pin the story to the pushed state; the
	// real panes leave this uncontrolled.
	const [open, setOpen] = useState<string | null>(params.get("open"));

	return (
		<div className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-8 bg-background px-6 py-10 text-foreground">
			<header className="flex flex-col gap-1">
				<h1 className="font-semibold text-lg">Appearance</h1>
				<p className="text-muted-foreground text-sm">
					A pane that drills in instead of scrolling.
				</p>
			</header>

			<SettingsSubpages
				backLabel="Appearance"
				intro={
					<SettingsSection
						caption="The headline setting stays on the index — a pane whose main control is one click away has organised itself at the user's expense."
						title="Theme"
					>
						<SettingsCard className="flex gap-3">
							{["Light", "Dark", "System"].map((mode) => (
								<div
									className="flex h-16 flex-1 items-end justify-center rounded-md border bg-muted/40 p-2 text-xs"
									key={mode}
								>
									{mode}
								</div>
							))}
						</SettingsCard>
					</SettingsSection>
				}
				label="Customize"
				onOpenChange={setOpen}
				openId={open}
				outro={
					<p className="px-3.5 text-muted-foreground text-xs leading-relaxed">
						Trailing content that is not a setting sits below the list, the way
						a "learn more" block does on the real Privacy pane.
					</p>
				}
				pages={[
					{
						id: "layout",
						title: "Layout & text",
						hint: "Density, widths, and the fonts the interface is set in.",
						icon: TextFontIcon,
						tint: "indigo",
						content: (
							<DemoPage rows={["Compact density", "Wide chat column"]} />
						),
					},
					{
						id: "motion",
						title: "Motion & effects",
						hint: "How much the interface animates, and the seasonal extras.",
						icon: SparklesIcon,
						tint: "pink",
						content: (
							<DemoPage
								rows={[
									"Enable animations",
									"Animate streaming chat text",
									"Seasonal effects",
								]}
							/>
						),
					},
					{
						id: "interface",
						title: "Interface",
						hint: "The sidebar, the cursor, shadows, and how lists are grouped.",
						icon: ComputerIcon,
						tint: "blue",
						content: <DemoPage rows={["Pointer cursor", "Inset sidebar"]} />,
					},
					{
						id: "chat",
						title: "Chat",
						hint: "How much detail a conversation shows while it runs.",
						icon: BubbleChatIcon,
						tint: "teal",
						content: <DemoPage rows={["Group tool uses", "Inference stats"]} />,
					},
					{
						id: "files",
						title: "File tree",
						hint: "Density, icons, and behaviour of the file browser.",
						icon: Folder01Icon,
						tint: "yellow",
						content: <DemoPage rows={["Colored icons", "Sticky folders"]} />,
					},
					{
						id: "reset",
						title: "Reset",
						hint: "Put every appearance setting back to its default.",
						icon: Delete02Icon,
						tint: "red",
						content: <DemoPage rows={["Reset appearance"]} />,
					},
				]}
			/>

			{/* The same tiles at sidebar size, which is where most of them render. */}
			<section className="flex flex-col gap-2">
				<h2 className="px-3.5 font-medium text-foreground/70 text-xs">
					Sidebar rows
				</h2>
				<div className="flex flex-col gap-0.5">
					{(
						[
							{ icon: TextFontIcon, label: "Appearance", tint: "purple" },
							{ icon: ComputerIcon, label: "This device", tint: "gray" },
							{
								icon: SparklesIcon,
								label: "Default agent & model",
								tint: "blue",
							},
							{ icon: Delete02Icon, label: "Danger zone", tint: "red" },
						] satisfies {
							icon: typeof TextFontIcon;
							label: string;
							tint: React.ComponentProps<typeof SettingsIconTile>["tint"];
						}[]
					).map((row) => (
						<div
							className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60"
							key={row.label}
						>
							<SettingsIconTile icon={row.icon} size="sm" tint={row.tint} />
							{row.label}
						</div>
					))}
				</div>
			</section>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
