"use client";

import { type BrowserRuntimeStatus, hasWebGpu } from "@ryu/browser-local-ai";
import { Button } from "@ryu/ui/components/button";
import { Checkbox } from "@ryu/ui/components/checkbox";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { Separator } from "@ryu/ui/components/separator";
import { cn } from "@ryu/ui/lib/utils";
import { Check, Settings2, Unplug } from "lucide-react";
import type { SyntheticEvent } from "react";
import { useEffect, useId, useState } from "react";
import { ASSISTANT_POPUP_LAYER } from "./skin.ts";

export type AssistantMode = "browser" | "node" | "guest";

export const DEFAULT_NODE_URL = "http://127.0.0.1:7980";

const MODE_OPTIONS: readonly {
	description: string;
	id: AssistantMode;
	label: string;
}[] = [
	{
		description: "Runs in this tab · nothing sent to Ryu",
		id: "browser",
		label: "Browser",
	},
	{
		description: "No API key · screened by Ryu's gateway",
		id: "guest",
		label: "Ryu guest",
	},
	{
		description: "Your Ryu Core · turns are not saved",
		id: "node",
		label: "Local node",
	},
];

/** Origins Core allows by default (apps/core/src/server/mod.rs CORS list). */
const CORE_DEFAULT_ORIGINS = new Set([
	"http://localhost:3001",
	"http://127.0.0.1:3001",
	"http://localhost:4000",
	"http://127.0.0.1:4000",
	"https://ryuhq.com",
	"https://www.ryuhq.com",
	"https://docs.ryuhq.com",
]);

/** Only a site outside Core's default list has to be added to Core's allowlist. */
function needsCoreAllowlist(): boolean {
	if (typeof window === "undefined") {
		return false;
	}
	return !CORE_DEFAULT_ORIGINS.has(window.location.origin);
}

function statusLabel(status: BrowserRuntimeStatus | undefined): string {
	if (!status || status.status === "not-prepared") {
		return "Not downloaded";
	}
	if (status.status === "preparing") {
		return status.progress == null
			? "Preparing"
			: `Downloading ${Math.round(status.progress)}%`;
	}
	if (status.status === "ready") {
		return "Ready in this browser";
	}
	return "Could not prepare";
}
/** A checked row in the settings popover, styled like a Desktop menu item. */
function SettingsChoice({
	checked,
	description,
	disabled,
	label,
	onSelect,
}: {
	checked: boolean;
	description?: string;
	disabled?: boolean;
	label: string;
	onSelect: () => void;
}) {
	return (
		<button
			aria-checked={checked}
			className={cn(
				"flex w-full items-center gap-2.5 rounded-2xl px-2 py-1 text-left font-medium text-sm outline-none transition-colors",
				"hover:bg-foreground/10 focus-visible:bg-foreground/10 disabled:pointer-events-none disabled:opacity-50",
				checked && "bg-foreground/10"
			)}
			disabled={disabled}
			onClick={onSelect}
			role="radio"
			type="button"
		>
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate" title={label}>
					{label}
				</span>
				{description ? (
					<span className="truncate font-normal text-muted-foreground text-xs">
						{description}
					</span>
				) : null}
			</span>
			{checked ? (
				<Check className="size-4 shrink-0 text-muted-foreground" />
			) : null}
		</button>
	);
}

export interface RuntimeSettingsProps {
	busy: boolean;
	/** False when the host site has no guest chat lane configured. */
	guestAvailable: boolean;
	mode: AssistantMode;
	nodeConnected: boolean;
	onDisconnect: () => void;
	onModeChange: (mode: AssistantMode) => void;
}

/** Runtime choices, laid out like Desktop's Agent · Model menu. */
export function RuntimeSettingsMenu({
	busy,
	guestAvailable,
	mode,
	nodeConnected,
	onDisconnect,
	onModeChange,
}: RuntimeSettingsProps) {
	return (
		<>
			<div aria-label="Assistant runtime" role="radiogroup">
				<p className="px-2 py-1.5 text-muted-foreground text-xs">Runtime</p>
				{MODE_OPTIONS.map((option) => {
					const unavailable = option.id === "guest" && !guestAvailable;
					return (
						<SettingsChoice
							checked={mode === option.id}
							description={
								unavailable ? "Not available on this site" : option.description
							}
							disabled={busy || (unavailable && mode !== option.id)}
							key={option.id}
							label={option.label}
							onSelect={() => onModeChange(option.id)}
						/>
					);
				})}
			</div>
			{mode === "node" && nodeConnected ? (
				<>
					<Separator className="mx-2 my-1 w-auto bg-border/50" />
					<button
						className="flex w-full items-center gap-1.5 rounded-2xl px-2 py-1 text-left font-medium text-sm outline-none transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 disabled:pointer-events-none disabled:opacity-50"
						disabled={busy}
						onClick={onDisconnect}
						type="button"
					>
						<Unplug className="size-4 shrink-0" />
						Disconnect this tab
					</button>
				</>
			) : null}
		</>
	);
}

/**
 * The header's settings control, in the same slot and with the same Settings2
 * trigger as Desktop's floating Ask Ryu (where it opens the Agent · Model menu).
 * Here it picks the runtime. A popover rather than a dropdown menu so it can
 * portal above the public launcher's layer.
 */
export function RuntimeSettings({
	onDisconnect,
	onModeChange,
	...props
}: RuntimeSettingsProps) {
	const [open, setOpen] = useState(false);
	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				render={
					<Button
						aria-label="Assistant settings"
						className="size-7"
						size="icon"
						title="Assistant settings"
						variant="ghost"
					>
						<Settings2 className="size-3.5" />
					</Button>
				}
			/>
			<PopoverContent
				align="end"
				className="w-64"
				data-lenis-prevent=""
				data-ryu-assistant-widget="true"
				onMouseDown={(event) => event.stopPropagation()}
				positionerClassName={ASSISTANT_POPUP_LAYER}
				spacing="dense-menu"
			>
				<RuntimeSettingsMenu
					{...props}
					onDisconnect={() => {
						onDisconnect();
						setOpen(false);
					}}
					onModeChange={(mode) => {
						onModeChange(mode);
						setOpen(false);
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}

function SetupHeading({ status, title }: { status: string; title: string }) {
	return (
		<div className="flex items-center justify-between gap-3">
			<p className="font-medium text-foreground text-sm">{title}</p>
			<span className="shrink-0 text-muted-foreground text-xs">{status}</span>
		</div>
	);
}

function SetupCheckbox({
	checked,
	disabled,
	label,
	onChange,
}: {
	checked: boolean;
	disabled: boolean;
	label: string;
	onChange: (value: boolean) => void;
}) {
	const id = useId();
	return (
		<div className="flex items-start gap-2">
			{/* mt-1 centres the 16px box on the label's first (leading-relaxed)
			    line; the foreground-tinted border keeps it visible in dark mode, and
			    the checked fill is mono like the site's filled buttons. */}
			<Checkbox
				checked={checked}
				className="mt-1 border-foreground/30 data-checked:border-foreground data-checked:bg-foreground data-checked:text-background dark:data-checked:bg-foreground"
				disabled={disabled}
				id={id}
				onCheckedChange={(next) => onChange(next === true)}
			/>
			<Label
				className="font-normal text-muted-foreground text-sm leading-relaxed"
				htmlFor={id}
			>
				{label}
			</Label>
		</div>
	);
}

export interface RuntimeSetupProps {
	allowRemote: boolean;
	browserStatus: BrowserRuntimeStatus | undefined;
	busy: boolean;
	mode: AssistantMode;
	nodeToken: string;
	nodeUrl: string;
	onAllowRemoteChange: (value: boolean) => void;
	onBrowserPrepare: () => void;
	onConnect: (event: SyntheticEvent<HTMLFormElement>) => void;
	onNodeTokenChange: (value: string) => void;
	onNodeUrlChange: (value: string) => void;
	onRememberNodeChange: (value: boolean) => void;
	rememberNode: boolean;
}

/**
 * Runtime setup, shown in the composer's own card (the slot Desktop uses for its
 * permission prompt) until the selected runtime can answer. Nothing is stacked
 * under the composer, so the surface keeps Desktop's two islands: transcript and
 * composer.
 */
export function RuntimeSetupPrompt({
	allowRemote,
	browserStatus,
	busy,
	mode,
	nodeToken,
	nodeUrl,
	onAllowRemoteChange,
	onBrowserPrepare,
	onConnect,
	onNodeTokenChange,
	onNodeUrlChange,
	onRememberNodeChange,
	rememberNode,
}: RuntimeSetupProps) {
	const addressId = useId();
	const tokenId = useId();
	// Read after mount so server and first client render agree.
	const [showAllowlistNote, setShowAllowlistNote] = useState(false);
	useEffect(() => {
		setShowAllowlistNote(needsCoreAllowlist());
	}, []);

	if (mode === "browser") {
		return (
			<div
				className="flex flex-col gap-2 p-3 text-left"
				data-testid="assistant-runtime-setup"
			>
				<SetupHeading
					status={statusLabel(browserStatus)}
					title="Download the browser model"
				/>
				<p className="text-muted-foreground text-sm leading-relaxed">
					SmolLM2 135M runs in this tab (
					{hasWebGpu() ? "WebGPU → WASM" : "WASM runtime"}). The model is cached
					by this browser and no prompt is sent to Ryu servers.
				</p>
				<div className="flex justify-end">
					<Button
						disabled={busy}
						onClick={onBrowserPrepare}
						size="sm"
						variant="mono"
					>
						{busy ? "Preparing…" : "Download local model"}
					</Button>
				</div>
			</div>
		);
	}

	return (
		<form
			className="flex flex-col gap-2 p-3 text-left"
			data-testid="assistant-runtime-setup"
			onSubmit={onConnect}
		>
			<SetupHeading status="Not connected" title="Core address" />
			<p className="text-muted-foreground text-sm leading-relaxed">
				Messages go straight from this tab to your Core and are not saved to its
				chat history.
			</p>
			<div className="flex flex-col gap-1">
				<Label
					className="font-normal text-muted-foreground text-sm"
					htmlFor={addressId}
				>
					Address
				</Label>
				<Input
					aria-label="Ryu Core address"
					disabled={busy}
					id={addressId}
					onChange={(event) => onNodeUrlChange(event.target.value)}
					placeholder={DEFAULT_NODE_URL}
					size="compact"
					spellCheck={false}
					type="url"
					value={nodeUrl}
				/>
			</div>
			<div className="flex flex-col gap-1">
				<Label
					className="font-normal text-muted-foreground text-sm"
					htmlFor={tokenId}
				>
					Access token
				</Label>
				<Input
					aria-label="Ryu Core access token"
					autoComplete="off"
					disabled={busy}
					id={tokenId}
					onChange={(event) => onNodeTokenChange(event.target.value)}
					placeholder="Paste your access token"
					size="compact"
					type="password"
					value={nodeToken}
				/>
				<p className="text-muted-foreground text-sm">
					Ryu Desktop shows it in its connection settings. Standalone Core saves
					it in its data folder.
				</p>
			</div>
			<SetupCheckbox
				checked={allowRemote}
				disabled={busy}
				label="This Core is on another computer I trust."
				onChange={onAllowRemoteChange}
			/>
			<SetupCheckbox
				checked={rememberNode}
				disabled={busy}
				label="Keep me connected in this tab."
				onChange={onRememberNodeChange}
			/>
			<div className="flex items-center justify-between gap-3">
				<p className="text-muted-foreground text-sm">
					{showAllowlistNote ? "Your Core needs to allow this website." : null}
				</p>
				<Button
					className="shrink-0"
					disabled={busy}
					size="sm"
					type="submit"
					variant="mono"
				>
					{busy ? "Testing…" : "Test & connect"}
				</Button>
			</div>
		</form>
	);
}
