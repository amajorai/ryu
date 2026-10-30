// Public types for the shared composer slot (`useComposerSlot.tsx`).

import type {
	ComposerMenuGroup,
	ComposerMenuItem,
} from "@ryu/blocks/desktop/agent-elements/input/composer-menu.tsx";
import type { ChatVoiceMode } from "@ryu/blocks/desktop/agent-elements/types.ts";
import type { RvpCallEnded } from "@ryuhq/protocol/voice";
import type { ReactNode } from "react";
import type { ComposerSettingsSection } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import type {
	GhostControls,
	PluginComposerControlRow,
} from "@/components/agent-elements/input/goal-plus-button.tsx";
import type {
	AttachedImage,
	InputBarProps,
} from "@/components/agent-elements/input-bar.tsx";
import type {
	MentionItem,
	ModelOption,
} from "@/components/agent-elements/types.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { Team } from "@/src/lib/api/teams.ts";
import type { SimpleApprovalDefaults } from "@/src/lib/chat-routing.ts";
import type { BrowserSurface } from "@/src/lib/extension-host.ts";

/** An AI-SDK file part, ready for `sendMessage({ text, files })`. */
export interface ComposerSendFile {
	filename: string;
	mediaType: string;
	type: "file";
	url: string;
}

export interface ComposerSlot {
	/**
	 * Attach a Ryu Clip: stage its key-moment frames as image chips (they are
	 * images, so they ride the existing image path with zero blocks changes) and
	 * queue the clip's markdown context summary to be prepended to the next
	 * outgoing turn. The surface's send handler calls {@link takeClipText} to
	 * fold that text in. Stable identity, safe to call from an effect/handler.
	 */
	attachClip: (text: string, frames: ComposerSendFile[]) => void;
	/** Pass to `<AgentChat attachments={...}>` so the composer "+" stages images. */
	attachments: {
		/**
		 * Stage dropped files. `AgentChat` handles its own drop zone, so only a
		 * surface that renders the `inputBar` directly (the launchpad) needs this.
		 */
		addFiles: (files: File[]) => void;
		/** Drop the staged images (after a surface has carried them elsewhere). */
		clear: () => void;
		images: AttachedImage[];
		onAttach: () => void;
		onPaste: (e: React.ClipboardEvent) => void;
		onRemoveImage: (id: string) => void;
	};
	/** Directory rows shared by the `+` menu and inline mention tokens. */
	composerMenuGroups: ComposerMenuGroup[];
	/** Stable `InputBar` slot for `AgentChat`'s `slots.InputBar`. */
	inputBar: (props: InputBarProps) => ReactNode;
	mentionItems: MentionItem[];
	onComposerMenuSelect: (item: ComposerMenuItem) => void;
	/**
	 * The universal picker body (Ryu (providers nested) · External Agents) — pass
	 * to `EmptyStateHeader`'s `renderBody` so its logo opens the identical grouped
	 * dropdown as the composer's settings trigger.
	 */
	renderBody: (close: () => void) => ReactNode;
	/**
	 * The composed Agent · Model · Thinking sections — the SAME ones inside the
	 * composer's settings menu.
	 *
	 * This is the FULL list, including contributed app pickers. It is what the
	 * composer's keyboard shortcuts act on, and
	 * what any surface rendering these as rows must use. A surface building its own
	 * settings TRIGGER wants {@link triggerSections} instead.
	 */
	sections: ComposerSettingsSection[];
	/**
	 * Pull the queued clip context text (from {@link attachClip}) and clear it.
	 * Call in the surface's send handler and prepend it to the outgoing text so
	 * the agent reads it as one leading `type:"text"` part. Returns `""` when no
	 * clip is queued, so the non-clip path is byte-identical.
	 */
	takeClipText: () => string;
	/**
	 * Pull the staged images as AI-SDK file parts and clear them. Call inside the
	 * surface's send handler:
	 * `const files = takeImages(); sendMessage(files ? { text, files } : { text });`
	 */
	takeImages: () => ComposerSendFile[] | undefined;
	/**
	 * {@link sections} narrowed to what a settings trigger should spell out — the
	 * contributed pickers are dropped, so an empty-state logo summarises exactly
	 * what the composer's own trigger does instead of listing one extra segment per
	 * installed app.
	 */
	triggerSections: ComposerSettingsSection[];
	/** Render the shared composer inside the active voice-mode call surface. */
	voiceMode: ChatVoiceMode;
}

/**
 * The agent/model selection a composer drives. `BuilderRuntime` satisfies it, and
 * so does any surface that owns those agent/model bindings itself (the launchpad keeps
 * its pick in localStorage, not in a builder runtime) — the slot never needed the
 * rest of a runtime, and demanding one is what pushed the launchpad into
 * hand-rolling its own bar.
 */
export interface ComposerRuntime {
	agentId: string | null;
	effectiveModel: string | null;
	modelOptions: ModelOption[];
	setAgentId: (id: string) => void;
	setModel: (id: string) => void;
	setSimpleApprovalDefaults?: (defaults: SimpleApprovalDefaults | null) => void;
}

export interface ComposerSlotOptions {
	/** Single-row compact layout (used once the thread has history). */
	compact?: boolean;
	/**
	 * Compact the agent-picker trigger only (`[logo] agent [usage]`), keeping the
	 * roomy stacked textarea. Used by the narrow Ask Ryu floating/docked panel.
	 */
	compactTrigger?: boolean;
	/** Bind voice-mode turns to this conversation so history persists. */
	conversationId?: string;
	/**
	 * Temporary-chat toggle for the "+" dropdown. Only a new-chat surface
	 * can offer it — an existing thread can't retroactively become unsaved — so it's
	 * opt-in per surface, not derived here.
	 */
	ghost?: GhostControls;
	/** Whether this surface currently has an agent turn in flight. */
	isWorking?: boolean;
	/**
	 * Use the floating assistant's quiet composer: one compact row, no visible
	 * agent/model summary, and no secondary generation/voice-mode buttons. The
	 * full settings menu remains available from the floating header.
	 */
	minimal?: boolean;
	onCallEnded?: (summary: RvpCallEnded) => void;
	/**
	 * Offer "Create new agent" in the agent picker. The surface routes it (a tab, a
	 * dialog), so it's a callback rather than a slot-owned navigation.
	 */
	onCreateAgent?: () => void;
	/**
	 * Text-to-image generation. When provided, the composer's toolbar gains an
	 * image button (the SAME one ChatPage wires) that takes the composer text as
	 * the prompt, generates via Core's `/api/images/generate`, and clears the
	 * draft — the host surfaces the result inline. Omit to hide the button (e.g.
	 * builder panes, where free-form image-gen doesn't belong). Mirrors `voice`:
	 * the draft text is owned by the InputBar, so the host receives only the prompt.
	 */
	onGenerateImage?: (prompt: string) => void | Promise<void>;
	/** Handle a group pick. Omit to hide the picker's Groups section entirely. */
	onSelectTeam?: (teamId: string) => void;
	/** Composer placeholder override (builders use "Describe what to build…"). */
	placeholder?: string;
	/** Plugin-registered toggle rows for this composer. */
	pluginControls?: PluginComposerControlRow[];
	/** Browser model-selection namespace for this shared composer surface. */
	surface?: BrowserSurface;
	/** Node target for voice STT + realtime voice mode. */
	target: ApiTarget;
	/** The picked team, when the surface can target one instead of an agent. */
	teamId?: string | null;
	/** Live groups for the picker's Groups section. */
	teams?: Team[];
	/**
	 * Offer the realtime voice-mode button (default true). Surfaces whose turns
	 * must go through their own request contract (app-defined assistant
	 * surfaces) turn it off; push-to-talk dictation into the composer stays.
	 */
	voiceMode?: boolean;
}
