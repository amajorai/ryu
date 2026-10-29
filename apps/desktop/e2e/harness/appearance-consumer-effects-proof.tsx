// Real persisted settings and real rendering consumers. Only content, model
// selection, and query transport are fixture inputs; no preference is mirrored.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import { DesktopShell } from "@ryu/blocks/desktop/shell";
import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { initDialogOverlayBlur } from "@ryu/ui/hooks/use-dialog-overlay-blur";
import { initPopupOverlayBlur } from "@ryu/ui/hooks/use-popup-overlay-blur";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { UIMessage } from "ai";
import { AgentChat } from "../../components/agent-elements/agent-chat.tsx";
import {
	InputBar,
	type InputBarProps,
} from "../../components/agent-elements/input-bar.tsx";
import { ModelPicker } from "../../components/agent-elements/input/model-picker.tsx";
import { ChatDisplayPrefs } from "../../src/components/chat/ChatDisplayPrefsProvider.tsx";
import { AnimatedTitle } from "../../src/components/layout/animated-title.tsx";
import { SidebarConversationPreview } from "../../src/components/layout/sidebar-conversation-preview.tsx";
import { AppearanceTab } from "../../src/components/settings/AppearanceTab.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { initChromeShadows } from "../../src/hooks/useChromeShadows.ts";
import { initInvertedBackgrounds } from "../../src/hooks/useInvertedBackgrounds.ts";
import { initPointerCursor } from "../../src/hooks/usePointerCursor.ts";
import { initTheme } from "../../src/hooks/useThemePreset.ts";
import "../../src/index.css";

// Match App/main boot, including restore before the first render.
initTheme();
initPointerCursor();
initChromeShadows();
initInvertedBackgrounds();
initDialogOverlayBlur();
initPopupOverlayBlur();

function ExpandableInputBar(props: InputBarProps) {
	return (
		<InputBar
			{...props}
			expandComposer
			turnProgress={{
				files: [],
				insertions: 0,
				deletions: 0,
				todos: {
					current: 1,
					total: 1,
					items: [
						{ label: "Testing appearance motion", status: "in_progress" },
					],
				},
			}}
		/>
	);
}

function Consumers() {
	const [model, setModel] = useState("gemma-id");
	const [reply, setReply] = useState("First streamed words");
	const [streaming, setStreaming] = useState(true);
	const [title, setTitle] = useState("First conversation");
	return (
		<section data-testid="consumers">
			<Card data-testid="consumer-card">
				<CardHeader>
					<CardTitle data-testid="consumer-heading">Readable heading</CardTitle>
					<CardDescription data-testid="consumer-muted">
						Muted explanatory text
					</CardDescription>
				</CardHeader>
				<CardContent data-testid="consumer-content">
					<p data-testid="consumer-text">Readable interface text</p>
					<pre data-testid="consumer-code">const result = 42;</pre>
					<Button data-testid="consumer-button">Enabled action</Button>
					<Button disabled data-testid="consumer-disabled-button">
						Disabled action
					</Button>
				</CardContent>
			</Card>
			<ModelPicker
				models={[
					{ id: "gemma-id", name: "gemma-4-12B-it-Q4_K_M" },
					{ id: "opus-id", name: "Opus" },
				]}
				value={model}
				onChange={setModel}
			/>
			<output data-testid="selected-model">{model}</output>
			<Popover>
				<PopoverTrigger render={<Button />}>Open consumer popup</PopoverTrigger>
				<PopoverContent data-testid="consumer-popup">
					Popup content
				</PopoverContent>
			</Popover>
			<Dialog>
				<DialogTrigger render={<Button />}>Open consumer dialog</DialogTrigger>
				<DialogContent>
					<DialogTitle>Consumer dialog</DialogTitle>
					<DialogDescription>Real shared dialog overlay.</DialogDescription>
				</DialogContent>
			</Dialog>
			<ChatDisplayPrefs>
				<SidebarConversationPreview
					states={["Reviewing files", "Running tests"]}
					testId="consumer-preview"
				/>
				<AnimatedTitle text={title} />
				<Button
					onClick={() =>
						setTitle((t) =>
							t === "First conversation"
								? "Updated conversation"
								: "First conversation",
						)
					}
				>
					Change consumer title
				</Button>
				<div
					data-testid="consumer-chat"
					className="flex h-[460px] min-h-0 flex-col"
				>
					<AgentChat
						slots={{ InputBar: ExpandableInputBar }}
						classNames={{ inputBar: "consumer-composer" }}
						messages={
							[
								{
									id: "appearance-assistant",
									role: "assistant",
									parts: [{ type: "text", text: reply }],
								},
							] as UIMessage[]
						}
						status={streaming ? "streaming" : "ready"}
						onSend={() => {}}
						currentUser={{ id: "appearance-user", name: "You" }}
					/>
				</div>
				<Button
					onClick={() => setReply((text) => `${text} new streamed words`)}
				>
					Append real chat text
				</Button>
				<Button onClick={() => setStreaming(false)}>
					Finish real chat stream
				</Button>
			</ChatDisplayPrefs>
			<div data-testid="consumer-shell" style={{ height: 340 }}>
				<DesktopShell
					showChats={false}
					sidebarContent={<p>Consumer sidebar</p>}
				>
					Consumer desktop content
				</DesktopShell>
			</div>
		</section>
	);
}
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
createRoot(document.getElementById("root")!).render(
	<MemoryRouter>
		<QueryClientProvider client={queryClient}>
			<AppSurfaceProvider surface="desktop">
				<ThemeProvider
					attribute="class"
					defaultTheme="dark"
					enableSystem={false}
				>
					<main className="h-dvh overflow-y-auto bg-background text-foreground p-8">
						<Consumers />
						<section data-testid="settings">
							<AppearanceTab />
						</section>
					</main>
				</ThemeProvider>
			</AppSurfaceProvider>
		</QueryClientProvider>
	</MemoryRouter>,
);
