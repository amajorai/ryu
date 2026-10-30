import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	CHANNEL_LABELS,
	type ChannelType,
} from "@ryu/blocks/desktop/channels.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { EmployeeBadge } from "@ryu/ui/components/employee-badge.tsx";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { Logo } from "@ryu/ui/components/logo.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { AGENT_IDENTITY_MODE_OPTIONS } from "@/src/components/agents/AgentIdentityModePicker.tsx";
import { AgentImageField } from "@/src/components/agents/AgentImageField.tsx";
import {
	AgentLaunchWarning,
	agentModelsLimited,
	MANAGED_PI_NOTE,
	RYU_ENGINE_ID,
	showsNoSandboxNote,
} from "@/src/components/agents/AgentLaunchWarning.tsx";
import { AgentSetupComposer } from "@/src/components/agents/AgentSetupComposer.tsx";
import { CreateAgentChannelsSection } from "@/src/components/agents/CreateAgentDialog-channels-section.tsx";
import { CreateAgentIdentityStep } from "@/src/components/agents/CreateAgentDialog-identity-step.tsx";
import { CreateAgentLimitAccountsNote } from "@/src/components/agents/CreateAgentDialog-limit-accounts-note.tsx";
import {
	CreateAgentNameField,
	CreateAgentTitleField,
} from "@/src/components/agents/CreateAgentDialog-name-fields.tsx";
import { fetchGeneratedAgentName } from "@/src/components/agents/create-agent/generate-name.ts";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgentLaunchCheck } from "@/src/hooks/useAgentLaunchCheck.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { NO_AGENT_CAPABILITIES } from "@/src/lib/agent-capabilities.ts";
import { agentEngineOptionId } from "@/src/lib/agent-engine.ts";
import { pickCommonAgentName } from "@/src/lib/agent-name.ts";
import { buildNewAgentChatSeed } from "@/src/lib/agent-onboarding.ts";
import { glyphToPersonaFields } from "@/src/lib/agent-persona.ts";
import type { AgentIdentityMode } from "@/src/lib/api/agents.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { useChannelSetupDialog } from "@/src/store/useChannelSetupDialog.ts";
import { useCreateAgentDialog } from "@/src/store/useCreateAgentDialog.ts";

// "New agent", as a dialog rather than a whole tab.
//
// Creating an agent needed three facts — what it is called, what it should do,
// and what it looks like — but the entry point opened the full editor, a page
// with every advanced control on it. This asks for the three, shows the agent's
// badge taking shape as you type, and hands off to that editor once the agent
// actually exists (so the advanced controls have something to edit).
//
// It opens on one question first — how the agent should work: as you, as
// itself, or both — because that decides whose accounts it may ever touch. The
// answer is saved as the agent's identity mode; which accounts exactly is left
// to the editor's Account access, so a new agent starts unrestricted within its
// mode.
//
// Before the agent is created, Core is asked whether its engine would start in
// that mode (`useAgentLaunchCheck`). When it would not, the details step shows
// Core's reason and offers Ryu's own engine, and Create stays disabled, so a
// new agent never opens its welcome chat only to fail its first turn.
//
// The card on the left is the thing worth looking at; the fields on the right
// are what change it.

// Self-contained, like `AgentAutoRoutingEditor`: it reads its own open state
// from the store and does its own routing, so the single mount site takes no
// props and no entry point has to thread callbacks through.
export function CreateAgentDialog() {
	const { open, setOpen } = useCreateAgentDialog();
	const openTab = useTabSelector((state) => state.openTab);
	const { resolvedTheme } = useTheme();
	const { agents, create } = useAgents();
	const { openChannelSetup } = useChannelSetupDialog();
	const activeNode = useActiveNode();
	const tl = useLiteralMessages();

	const [step, setStep] = useState<"identity" | "details">("identity");
	const [identityMode, setIdentityMode] =
		useState<AgentIdentityMode>("managed");
	const [name, setName] = useState(() => pickCommonAgentName());
	const [title, setTitle] = useState("");
	const [instructions, setInstructions] = useState("");
	const [engine, setEngine] = useState("");
	const [model, setModel] = useState("");
	const [modelEngine, setModelEngine] = useState<string | null>(null);
	const [avatar, setAvatar] = useState<GlyphValue>(null);
	const [submitting, setSubmitting] = useState(false);
	const [generatingName, setGeneratingName] = useState(false);
	const [autoSetupTelegram, setAutoSetupTelegram] = useState(true);
	const [autoSetupDiscord, setAutoSetupDiscord] = useState(false);
	const [autoSetupWhatsApp, setAutoSetupWhatsApp] = useState(false);
	// A new agent starts with no account limit. The one exception is a computer
	// without the account-access sandbox, where an unlimited "Both" agent cannot
	// start: the warning then offers to create it limited (an empty allowlist),
	// and the accounts are chosen in the agent's settings.
	const [limitAccounts, setLimitAccounts] = useState(false);
	const accountAccess = limitAccounts ? [] : null;

	const launch = useAgentLaunchCheck({
		accountAccess,
		engine: engine || null,
		identityMode,
	});
	const modelsLimited = agentModelsLimited(identityMode, accountAccess);

	const trimmedName = name.trim();
	const canSubmit =
		trimmedName.length > 0 && !submitting && !launch.refused && !launch.pending;

	useEffect(() => {
		if (engine || agents.length === 0) {
			return;
		}
		const defaultAgent =
			agents.find((agent) => agent.id === "ryu") ??
			agents.find((agent) => agent.recommended) ??
			agents.find((agent) => agent.builtIn);
		const defaultEngine = defaultAgent
			? agentEngineOptionId(defaultAgent)
			: null;
		if (defaultEngine) {
			setEngine(defaultEngine);
		}
	}, [agents, engine]);

	// Back to the identity question, on "Acts as you". Dismissing the dialog
	// does only this, so the next "New agent" asks again but keeps the name,
	// title, instructions and the rest of the draft.
	const restartIdentity = () => {
		setStep("identity");
		setIdentityMode("managed");
		setLimitAccounts(false);
	};

	const reset = () => {
		restartIdentity();
		setName(pickCommonAgentName());
		setTitle("");
		setInstructions("");
		setEngine("");
		setModel("");
		setModelEngine(null);
		setAvatar(null);
		setAutoSetupTelegram(true);
		setAutoSetupDiscord(false);
		setAutoSetupWhatsApp(false);
	};

	const rerollName = () => {
		setName((current) => pickCommonAgentName(current));
	};

	const generateName = async () => {
		if (generatingName || submitting || !instructions.trim()) {
			return;
		}
		setGeneratingName(true);
		try {
			setName(
				await fetchGeneratedAgentName(toTarget(activeNode), {
					instructions,
					title,
				})
			);
		} catch {
			setName((current) => pickCommonAgentName(current));
			toast.message("Couldn’t generate a name, so I picked another one");
		} finally {
			setGeneratingName(false);
		}
	};

	const submit = async (advanced: boolean) => {
		if (!canSubmit) {
			return;
		}
		setSubmitting(true);
		try {
			const agent = await create({
				description: null,
				engine: engine || null,
				name: trimmedName,
				title: title.trim(),
				// Account access is left unset (unrestricted within the mode) until
				// the user narrows it in the editor, unless the launch warning's
				// "Limit to selected accounts" was chosen.
				...(limitAccounts ? { accountAccess: [] } : {}),
				identityMode,
				model: model.trim() || null,
				chatModel: {
					engine: modelEngine,
					modelId: model.trim() || null,
				},
				// The avatar rides on the persona bundle, the same slot the full editor
				// writes. `glyphToPersonaFields` is what enforces the five sources'
				// mutual exclusivity — an uploaded image is only ONE of them, so
				// reading the glyph as a string would silently drop an icon, emoji,
				// dicebear or dither pick.
				persona: {
					display_name: null,
					tone: null,
					...glyphToPersonaFields(avatar),
				},
				systemPrompt: instructions.trim() || null,
				tools: [NO_AGENT_CAPABILITIES],
			});
			const selectedChannelTypes = [
				autoSetupTelegram ? "telegram" : null,
				autoSetupDiscord ? "discord" : null,
				autoSetupWhatsApp ? "whatsapp" : null,
			].filter((value): value is ChannelType => value !== null);
			toast.success(`${trimmedName} created`);
			reset();
			setOpen(false);
			if (advanced) {
				openTab(`/agents/${agent.id}/edit`, { title: trimmedName });
			}
			// The first chat is a real, fresh tab. ChatPage consumes this one-shot
			// seed, selects the created agent, and sends the welcome request once the
			// chat transport is ready so the agent can introduce itself. It is opened
			// last so the chat is focused even when Advanced setup also opened the
			// editor.
			openTab("/chat", buildNewAgentChatSeed(agent.id, trimmedName));
			const firstChannelType = selectedChannelTypes[0];
			if (firstChannelType) {
				openChannelSetup({
					agentId: agent.id,
					agentName: trimmedName,
					channelType: firstChannelType,
				});
				const remainingCount = selectedChannelTypes.length - 1;
				toast.message(
					remainingCount > 0
						? tl(
								"{channel} setup is ready. Add the other {remainingCount, plural, one {# selected channel} other {# selected channels}} from Channels.",
								{ channel: CHANNEL_LABELS[firstChannelType], remainingCount }
							)
						: tl("{channel} setup is ready for {trimmedName}.", {
								channel: CHANNEL_LABELS[firstChannelType],
								trimmedName,
							})
				);
			}
			if (advanced) {
				toast.message("Your agent is introducing itself in the chat tab");
			}
		} catch (error) {
			// One argument: this `toast` takes a string OR a full options object,
			// not sonner's (message, options) pair.
			toast.error({
				title: "Couldn't create that agent",
				description:
					error instanceof Error ? error.message : "Try again in a moment.",
			});
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Dialog
			onOpenChange={(next) => {
				// Dismissing (Escape, overlay, close button) starts the next
				// "New agent" on the identity question again, keeping the draft.
				if (!(next || submitting)) {
					restartIdentity();
				}
				setOpen(next);
			}}
			open={open}
		>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
				{step === "identity" ? (
					<CreateAgentIdentityStep
						identityMode={identityMode}
						onContinue={() => setStep("details")}
						onIdentityModeChange={(next) => {
							setIdentityMode(next);
							setLimitAccounts(false);
						}}
						showNoSandboxNote={showsNoSandboxNote(launch.check, modelsLimited)}
					/>
				) : (
					<>
						<DialogHeader>
							<div className="flex items-center gap-1">
								<Button
									aria-label="Back"
									className="-ml-2"
									disabled={submitting}
									onClick={() => setStep("identity")}
									size="icon-sm"
									title="Back"
									type="button"
									variant="ghost-muted"
								>
									<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
								</Button>
								<DialogTitle>New agent</DialogTitle>
							</div>
							<DialogDescription>
								Name it and say what it does. Configure the rest later.
							</DialogDescription>
						</DialogHeader>

						<div className="grid items-center gap-8 md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
							{/* The badge the agent will carry, built from what has been typed
							    so far — the same card the Agents page shows once it exists. */}
							<div className="mx-auto w-full max-w-[17rem] md:mx-0">
								<EmployeeBadge
									employeeId="new"
									level={0}
									metalTheme={resolvedTheme === "light" ? "light" : "dark"}
									name={trimmedName || "New agent"}
									role={
										title.trim() ||
										(instructions.trim()
											? "Ready to configure"
											: "Unconfigured")
									}
								/>
							</div>

							<div className="flex w-full flex-col gap-4">
								<CreateAgentTitleField
									onTitleChange={setTitle}
									submitting={submitting}
									title={title}
								/>

								<div className="flex flex-col gap-2">
									<span className="font-medium text-sm">Avatar</span>
									<AgentImageField
										disabled={submitting}
										fallback={<Logo size="24px" variant="outline" />}
										onChange={setAvatar}
										value={avatar}
									/>
								</div>

								<div className="flex items-center gap-2 text-sm">
									<span className="font-medium">Identity</span>
									<span className="text-muted-foreground">
										{AGENT_IDENTITY_MODE_OPTIONS[identityMode].title}
									</span>
									<Button
										disabled={submitting}
										onClick={() => setStep("identity")}
										size="sm"
										type="button"
										variant="link"
									>
										Change
									</Button>
								</div>

								<CreateAgentNameField
									generatingName={generatingName}
									instructions={instructions}
									name={name}
									onGenerateName={() => void generateName()}
									onNameChange={setName}
									onReroll={rerollName}
									submitting={submitting}
								/>
								<div className="flex flex-col gap-2">
									<span className="font-medium text-sm">
										Instructions &amp; model
									</span>
									<AgentSetupComposer
										agents={agents}
										disabled={submitting}
										engine={engine}
										engineNote={
											launch.check?.runsOnManagedPi ? MANAGED_PI_NOTE : null
										}
										identityMode={identityMode}
										instructions={instructions}
										model={model}
										modelEngine={modelEngine}
										onEngineChange={setEngine}
										onInstructionsChange={setInstructions}
										onModelChange={setModel}
										onModelEngineChange={setModelEngine}
										placeholder="What should this agent do, and how should it behave?"
									/>
									<AgentLaunchWarning
										check={launch.check}
										disabled={submitting}
										engine={engine || null}
										modelsLimited={modelsLimited}
										onLimitAccounts={() => setLimitAccounts(true)}
										onUseRyu={() => {
											setEngine(RYU_ENGINE_ID);
											setModel("");
											setModelEngine(null);
										}}
									/>
									{limitAccounts ? (
										<CreateAgentLimitAccountsNote
											onRemoveLimit={() => setLimitAccounts(false)}
											submitting={submitting}
										/>
									) : null}
								</div>

								<CreateAgentChannelsSection
									autoSetupDiscord={autoSetupDiscord}
									autoSetupTelegram={autoSetupTelegram}
									autoSetupWhatsApp={autoSetupWhatsApp}
									setAutoSetupDiscord={setAutoSetupDiscord}
									setAutoSetupTelegram={setAutoSetupTelegram}
									setAutoSetupWhatsApp={setAutoSetupWhatsApp}
									submitting={submitting}
								/>

								<div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
									<Button
										disabled={!canSubmit}
										onClick={() => submit(true)}
										type="button"
										variant="ghost"
									>
										Advanced setup
									</Button>
									<Button
										className="sm:ml-auto"
										disabled={!canSubmit}
										loading={submitting}
										onClick={() => submit(false)}
										type="button"
										variant="mono"
									>
										Create agent
									</Button>
								</div>
							</div>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
