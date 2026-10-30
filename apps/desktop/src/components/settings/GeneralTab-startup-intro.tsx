import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { open } from "@tauri-apps/plugin-dialog";
import { z } from "zod";
import { listAccounts } from "@/lib/auth-client.ts";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import { useProjectlessTaskFolder } from "@/src/hooks/useProjectlessTaskFolder.ts";
import {
	type StartupBehavior,
	setStartupBehavior,
	useStartupBehavior,
} from "@/src/hooks/useStartupBehavior.ts";
import { useStartupRealm } from "@/src/hooks/useStartupRealm.ts";
import { useStartupSelection } from "@/src/hooks/useStartupSelection.ts";
import {
	isStartupRealm,
	STARTUP_REALM_OPTIONS,
	type StartupRealm,
	useProductModeStore,
} from "@/src/lib/product-mode.ts";
import type { StartupSelectionMode } from "@/src/lib/startup-selection.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import {
	NO_STARTUP_DEFAULT,
	STARTUP_OPTIONS,
	STARTUP_SELECTION_OPTIONS,
} from "./GeneralTab-options.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";
import { TrainingDataNotice } from "./TrainingDataNotice.tsx";

/** The General index's always-visible "On startup" section. */
export function GeneralTabStartupIntro() {
	const tl = useLiteralMessages();
	const { isDesktop } = useAppSurface();
	const startupBehavior = useStartupBehavior();
	const {
		realm: startupRealm,
		pendingRealm: pendingStartupRealm,
		error: startupRealmError,
		retry: retryStartupRealm,
		setRealm: setStartupRealmPreference,
	} = useStartupRealm();
	// OS is rolled out by flag. While it is off, offer it only if it is the
	// saved choice, so the select never shows a value it cannot list.
	const osAccess = useProductModeStore((state) => state.osAccess);
	const startupRealmOptions = STARTUP_REALM_OPTIONS.filter(
		(option) =>
			option.value !== "os" ||
			osAccess ||
			(pendingStartupRealm ?? startupRealm) === "os"
	);
	const {
		preferences: startupSelection,
		setDefaultAccountId,
		setDefaultNodeName,
		setMode: setStartupSelectionMode,
	} = useStartupSelection();
	const startupAccounts = listAccounts();
	const startupNodes = useNodeStore((state) => state.nodes);
	const setDefaultNode = useNodeStore((state) => state.setDefault);
	const startupDefaultAccountValue = startupAccounts.some(
		(account) => account.userId === startupSelection.defaultAccountId
	)
		? (startupSelection.defaultAccountId ?? NO_STARTUP_DEFAULT)
		: NO_STARTUP_DEFAULT;
	const startupDefaultNodeValue = startupNodes.some(
		(node) => node.name === startupSelection.defaultNodeName
	)
		? (startupSelection.defaultNodeName ?? NO_STARTUP_DEFAULT)
		: NO_STARTUP_DEFAULT;
	const [
		projectlessTaskFolder,
		setProjectlessTaskFolder,
		hasCustomProjectlessTaskFolder,
	] = useProjectlessTaskFolder();

	const handleChangeProjectlessTaskFolder = async () => {
		try {
			const selected = await open({
				directory: true,
				multiple: false,
				title: "Choose projectless task folder",
			});
			const path = z.string().safeParse(selected);
			if (path.success) {
				setProjectlessTaskFolder(path.data);
			}
		} catch (error) {
			toast.error("Couldn't choose the projectless task folder", {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	};

	const handleDefaultNodeChange = (name: string) => {
		const nextName = name === NO_STARTUP_DEFAULT ? null : name;
		if (!nextName) {
			setDefaultNodeName(null);
			return;
		}
		void setDefaultNode(nextName)
			.then(() => {
				setDefaultNodeName(nextName);
			})
			.catch(() => {
				toast.error("Couldn't update the default node", {
					description: "Your change wasn't saved. Please try again.",
				});
			});
	};

	return (
		<div>
			<SettingsSection title="On startup">
				<SettingsGroup>
					{isDesktop ? (
						<SettingsItem
							actions={
								<div className="flex min-w-0 max-w-[min(32rem,60vw)] items-center gap-2">
									{/* Mono only for a real path; the unset state is plain text. */}
									<span
										className={
											projectlessTaskFolder
												? "min-w-0 truncate font-mono text-muted-foreground text-xs"
												: "min-w-0 truncate text-muted-foreground text-sm"
										}
										title={projectlessTaskFolder ?? "Not set"}
									>
										{projectlessTaskFolder ?? "Not set"}
									</span>
									<Button
										aria-label="Change projectless task folder"
										onClick={handleChangeProjectlessTaskFolder}
										size="sm"
										variant="outline"
									>
										Change
									</Button>
									{hasCustomProjectlessTaskFolder ? (
										<Button
											aria-label="Reset projectless task folder"
											onClick={() => setProjectlessTaskFolder(null)}
											size="sm"
											variant="ghost"
										>
											Reset
										</Button>
									) : null}
								</div>
							}
							description="Where new chats without a project work. Defaults to Documents/Ryu/Projects."
							settingsId="general.on-startup.projectless-task-folder"
							title="Projectless task folder"
						/>
					) : null}
					<SettingsItem
						actions={
							<Select<StartupBehavior>
								items={STARTUP_OPTIONS}
								onValueChange={(v) => setStartupBehavior(v)}
								value={startupBehavior}
							>
								<SelectTrigger
									className="w-auto max-w-64 shrink-0"
									id="startup-behavior-select"
									size="sm"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{STARTUP_OPTIONS.map((opt) => (
										<SelectItem key={opt.value} value={opt.value}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						title="Open with"
					/>
					{isDesktop ? (
						<SettingsItem
							actions={
								<div className="flex items-center gap-2">
									{startupRealmError ? (
										<Button
											onClick={retryStartupRealm}
											size="sm"
											variant="outline"
										>
											Retry saving startup realm
										</Button>
									) : null}
									<Select
										items={startupRealmOptions}
										onValueChange={(value) => {
											if (isStartupRealm(value)) {
												setStartupRealmPreference(value);
											}
										}}
										value={pendingStartupRealm ?? startupRealm}
									>
										<SelectTrigger
											className="w-auto max-w-64 shrink-0"
											id="startup-realm-select"
											size="sm"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{startupRealmOptions.map((option) => (
												<SelectItem
													key={option.value}
													value={option.value satisfies StartupRealm}
												>
													{option.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							}
							description={
								startupRealmError ? (
									<span className="text-status-destructive" role="alert">
										{tl("{error} Your choice isn't saved yet.", {
											error: startupRealmError,
										})}
									</span>
								) : undefined
							}
							settingsId="general.on-startup.realm"
							title="Realm on startup"
						/>
					) : null}
					<SettingsItem
						actions={
							<Select<StartupSelectionMode>
								items={STARTUP_SELECTION_OPTIONS}
								onValueChange={(value) => setStartupSelectionMode(value)}
								value={startupSelection.mode}
							>
								<SelectTrigger
									className="w-auto max-w-64 shrink-0"
									id="startup-selection-mode-select"
									size="sm"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{STARTUP_SELECTION_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Ask at each launch, use the defaults below, or skip the picker."
						title="Account and node selection"
					/>
					<SettingsItem
						actions={
							<Select
								disabled={startupAccounts.length === 0}
								items={[
									{ label: "Ask at startup", value: NO_STARTUP_DEFAULT },
									...startupAccounts.map((account) => ({
										label: account.isAnonymous
											? "Guest"
											: account.name || account.email || "Account",
										value: account.userId,
									})),
								]}
								onValueChange={(value) =>
									setDefaultAccountId(
										value === NO_STARTUP_DEFAULT ? null : value
									)
								}
								value={startupDefaultAccountValue}
							>
								<SelectTrigger
									className="w-auto max-w-64 shrink-0"
									id="startup-default-account-select"
									size="sm"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={NO_STARTUP_DEFAULT}>
										Ask at startup
									</SelectItem>
									{startupAccounts.map((account) => (
										<SelectItem key={account.userId} value={account.userId}>
											{account.isAnonymous
												? "Guest"
												: account.name || account.email || "Account"}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						title="Default account"
					/>
					<SettingsItem
						actions={
							<Select
								disabled={startupNodes.length === 0}
								items={[
									{ label: "Ask at startup", value: NO_STARTUP_DEFAULT },
									...startupNodes.map((node) => ({
										label: node.name,
										value: node.name,
									})),
								]}
								onValueChange={handleDefaultNodeChange}
								value={startupDefaultNodeValue}
							>
								<SelectTrigger
									className="w-auto max-w-64 shrink-0"
									id="startup-default-node-select"
									size="sm"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={NO_STARTUP_DEFAULT}>
										Ask at startup
									</SelectItem>
									{startupNodes.map((node) => (
										<SelectItem key={node.name} value={node.name}>
											{node.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						title="Default node"
					/>
				</SettingsGroup>
			</SettingsSection>
			<TrainingDataNotice />
		</div>
	);
}
