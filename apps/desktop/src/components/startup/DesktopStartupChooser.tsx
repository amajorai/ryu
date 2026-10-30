import {
	ArrowLeft01Icon,
	CloudIcon,
	ComputerIcon,
	PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useShallow } from "zustand/react/shallow";
import "./DesktopStartupChooser.css";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import {
	DitherAvatar,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar.tsx";
import { OTPCodeDisplay } from "@ryu/ui/components/motion/otp-input.tsx";

import { toast } from "@ryu/ui/components/sileo.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";

import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useRef, useState } from "react";
import {
	BACKEND_URL,
	getActiveUserId,
	listAccounts,
	switchAccount,
} from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";

import { useWallpaper } from "@/src/lib/wallpaper.ts";
import {
	addAccountViaDeviceAuth,
	localizeVerificationUrl,
} from "../../../lib/oauth.ts";
import {
	readStartupSelectionPreferences,
	setStartupDefaultAccountId,
	setStartupDefaultNodeName,
	startupSelectionSteps,
} from "../../lib/startup-selection.ts";
import {
	isLocalNode,
	LOCAL_FALLBACK,
	useNodeStore,
} from "../../store/useNodeStore.ts";
import { WallpaperBackdrop } from "../wallpaper/WallpaperBackdrop.tsx";
import {
	type AccountView,
	accountLabel,
	ContinueButton,
	DefaultSwitch,
	GLASS,
	GLASS_HOVER,
	LoginClock,
	LoginTile,
	moveSelection,
	type StartupStep,
	TEXT_SHADOW,
	WallpaperButton,
} from "./DesktopStartupChooser.parts.tsx";

export function DesktopStartupChooser() {
	const { nodes, defaultNode, setDefault } = useNodeStore(
		useShallow((s) => ({
			nodes: s.nodes,
			defaultNode: s.defaultNode,
			setDefault: s.setDefault,
		}))
	);
	const { wallpaper } = useWallpaper();
	const tl = useLiteralMessages();
	const preferences = readStartupSelectionPreferences();
	const initialAccounts = listAccounts();
	const steps = startupSelectionSteps({
		accounts: initialAccounts,
		defaultAccountId: preferences.defaultAccountId,
		defaultNodeName: preferences.defaultNodeName,
		mode: preferences.mode,
		nodes,
	});
	const accountStepEnabled = steps.account;
	const nodeStepEnabled = steps.node;
	const [step, setStep] = useState<StartupStep>(
		accountStepEnabled ? "account" : "node"
	);
	const [accounts, setAccounts] = useState<AccountView[]>(initialAccounts);
	const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
		() => getActiveUserId() ?? initialAccounts[0]?.userId ?? null
	);
	const [selectedNodeName, setSelectedNodeName] = useState(() =>
		preferences.defaultNodeName &&
		nodes.some((node) => node.name === preferences.defaultNodeName)
			? preferences.defaultNodeName
			: defaultNode
	);
	const [rememberAccount, setRememberAccount] = useState(
		() => preferences.mode === "defaults" || !preferences.defaultAccountId
	);
	const [rememberNode, setRememberNode] = useState(
		() => preferences.mode === "defaults" || !preferences.defaultNodeName
	);
	const [busy, setBusy] = useState(false);
	const [adding, setAdding] = useState(false);
	const cancelAddAccount = useRef<(() => void) | null>(null);

	const selectedNode =
		nodes.find((node) => node.name === selectedNodeName) ??
		nodes[0] ??
		LOCAL_FALLBACK;
	const hasAccountStep = accountStepEnabled;

	useEffect(() => {
		return () => cancelAddAccount.current?.();
	}, []);

	const refreshAccounts = () => {
		const nextAccounts = listAccounts();
		setAccounts(nextAccounts);
		setSelectedAccountId(getActiveUserId() ?? nextAccounts[0]?.userId ?? null);
	};

	const handleAddAccount = () => {
		if (adding) {
			return;
		}
		setAdding(true);
		cancelAddAccount.current = addAccountViaDeviceAuth(BACKEND_URL, {
			onCode: (info) => {
				openExternal(
					localizeVerificationUrl(info.verificationUriComplete)
				).catch(() => undefined);
				toast.show({
					title: "Finish signing in",
					description: (
						<div className="grid gap-2">
							<p>Approve in your browser to add the account.</p>
							{info.userCode ? (
								<OTPCodeDisplay
									aria-label="Device sign-in code"
									code={info.userCode}
									size="compact"
								/>
							) : null}
						</div>
					),
				});
			},
			onAdded: (userId) => {
				setAdding(false);
				cancelAddAccount.current = null;
				refreshAccounts();
				setSelectedAccountId(userId);
				toast.success("Account added");
			},
			onError: (error) => {
				setAdding(false);
				cancelAddAccount.current = null;
				toast.error({
					title: "Couldn't add account",
					description: error.message,
				});
			},
		});
	};

	const handleContinue = () => {
		if (step === "account" && nodeStepEnabled) {
			setStep("node");
			return;
		}
		void finish();
	};

	const finish = async () => {
		if (busy) {
			return;
		}
		setBusy(true);
		try {
			if (selectedAccountId && selectedAccountId !== getActiveUserId()) {
				await switchAccount(selectedAccountId);
			}
			await setDefault(selectedNode.name);
			if (accountStepEnabled) {
				setStartupDefaultAccountId(rememberAccount ? selectedAccountId : null);
			}
			if (nodeStepEnabled) {
				setStartupDefaultNodeName(rememberNode ? selectedNode.name : null);
			}
			window.location.reload();
		} catch (error) {
			setBusy(false);
			toast.error({
				title: "Couldn't save startup choices",
				description:
					error instanceof Error ? error.message : "Please try again.",
			});
		}
	};

	const continueDisabled =
		step === "account"
			? !selectedAccountId || busy || adding
			: busy || !selectedNode.name;

	// Login-window keys: arrows move between tiles, Return continues, Escape
	// steps back from the node picker. Bound on the window because nothing has
	// focus on launch, exactly like the macOS login screen.
	const handleKeyDown = (event: KeyboardEvent) => {
		const target = event.target instanceof HTMLElement ? event.target : null;
		if (
			event.defaultPrevented ||
			target?.closest("input, textarea, [role='dialog']")
		) {
			return;
		}
		const delta =
			event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
		if (delta !== 0) {
			event.preventDefault();
			if (step === "account") {
				const next = moveSelection(
					accounts.map((account) => account.userId),
					selectedAccountId ?? undefined,
					delta
				);
				setSelectedAccountId(next ?? null);
			} else {
				const next = moveSelection(
					nodes.map((node) => node.name),
					selectedNodeName,
					delta
				);
				if (next) {
					setSelectedNodeName(next);
				}
			}
			return;
		}
		if (event.key === "Enter" && target?.tagName !== "BUTTON") {
			event.preventDefault();
			if (!continueDisabled) {
				handleContinue();
			}
			return;
		}
		if (event.key === "Escape" && step === "node" && hasAccountStep) {
			event.preventDefault();
			setStep("account");
		}
	};

	const keyHandler = useRef(handleKeyDown);
	keyHandler.current = handleKeyDown;
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => keyHandler.current(event);
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	return (
		<div
			className="relative flex h-full w-full select-none flex-col overflow-hidden bg-wallpaper-base text-white"
			data-tauri-drag-region="true"
			data-testid="desktop-startup-chooser"
		>
			<WallpaperBackdrop wallpaper={wallpaper} />
			{/* Scrims keep white text legible on any wallpaper, even a bright upload. */}
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-black/35 to-transparent"
			/>
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/55 via-black/20 to-transparent"
			/>

			<div
				className="relative z-10 flex shrink-0 justify-end px-5 pt-4"
				data-tauri-drag-region="true"
			>
				<WallpaperButton />
			</div>

			<div
				className="relative z-10 flex shrink-0 justify-center pt-8"
				data-startup-top-padding=""
			>
				<LoginClock />
			</div>

			<div
				className="relative z-10 mt-auto flex flex-col items-center gap-5 px-6 pb-14"
				data-startup-bottom-padding=""
			>
				{step === "account" ? (
					<div
						className="flex flex-col items-center gap-5"
						data-testid="startup-account-step"
					>
						<div
							aria-label="Choose an account"
							className="flex max-w-[min(56rem,100%)] flex-wrap items-start justify-center gap-2"
							role="radiogroup"
						>
							{accounts.map((account) => (
								<LoginTile
									disabled={busy || adding}
									key={account.userId}
									label={accountLabel(account)}
									onClick={() => setSelectedAccountId(account.userId)}
									onDoubleClick={() => {
										setSelectedAccountId(account.userId);
										handleContinue();
									}}
									selected={account.userId === selectedAccountId}
								>
									<Avatar className="size-full" size="lg">
										<AvatarImage
											alt={accountLabel(account)}
											src={account.image ?? undefined}
										/>
										<AvatarFallback
											appearance="artwork"
											className="overflow-hidden"
										>
											<DitherAvatar
												className="size-full"
												name={ditherAvatarSeed({
													id: account.userId,
													email: account.email,
													name: account.name,
												})}
											/>
										</AvatarFallback>
									</Avatar>
								</LoginTile>
							))}
							<button
								className="group flex w-32 scale-[0.92] flex-col items-center gap-2.5 rounded-2xl p-2 opacity-70 outline-none transition-opacity hover:opacity-95 focus-visible:ring-2 focus-visible:ring-white/80 disabled:opacity-40"
								disabled={busy || adding}
								onClick={handleAddAccount}
								type="button"
							>
								<span
									className={cn(
										"flex size-20 items-center justify-center rounded-full",
										GLASS
									)}
								>
									{adding ? (
										<Spinner className="size-6" />
									) : (
										<HugeiconsIcon icon={PlusSignIcon} size={20} />
									)}
								</span>
								<span
									className={cn(
										"font-semibold text-sm text-white",
										TEXT_SHADOW
									)}
								>
									Add account
								</span>
							</button>
						</div>

						<ContinueButton
							busy={false}
							disabled={continueDisabled}
							label="Continue"
							onClick={handleContinue}
						/>

						<DefaultSwitch
							checked={rememberAccount}
							disabled={busy || adding}
							id="startup-default-account"
							onCheckedChange={setRememberAccount}
						/>
					</div>
				) : (
					<div
						className="flex flex-col items-center gap-5"
						data-testid="startup-node-step"
					>
						<p
							className={cn("font-semibold text-sm text-white/85", TEXT_SHADOW)}
						>
							Choose a node
						</p>
						<div
							aria-label="Choose a node"
							className="flex max-w-[min(56rem,100%)] flex-wrap items-start justify-center gap-2"
							role="radiogroup"
						>
							{nodes.map((node) => (
								<LoginTile
									disabled={busy}
									key={node.name}
									label={node.name}
									onClick={() => setSelectedNodeName(node.name)}
									onDoubleClick={() => {
										setSelectedNodeName(node.name);
										handleContinue();
									}}
									selected={node.name === selectedNodeName}
								>
									{isLocalNode(node) ? (
										<HugeiconsIcon icon={ComputerIcon} size={20} />
									) : (
										<HugeiconsIcon icon={CloudIcon} size={20} />
									)}
								</LoginTile>
							))}
						</div>

						<div className="flex items-center gap-2">
							{hasAccountStep ? (
								<button
									aria-label="Back"
									className={cn(
										"flex size-10 items-center justify-center rounded-full text-white disabled:opacity-50",
										GLASS,
										GLASS_HOVER
									)}
									disabled={busy}
									onClick={() => setStep("account")}
									title="Back"
									type="button"
								>
									<HugeiconsIcon icon={ArrowLeft01Icon} size={16} />
								</button>
							) : null}
							<ContinueButton
								busy={busy}
								disabled={continueDisabled}
								label="Open Ryu"
								onClick={handleContinue}
							/>
						</div>

						<DefaultSwitch
							checked={rememberNode}
							disabled={busy}
							id="startup-default-node"
							onCheckedChange={setRememberNode}
						/>
					</div>
				)}
				{wallpaper.attribution && wallpaper.attributionUrl ? (
					<p className={cn("text-white/55 text-xs", TEXT_SHADOW)}>
						Source:{" "}
						<a
							className="underline underline-offset-2 hover:text-white"
							href={wallpaper.attributionUrl}
							rel="noopener noreferrer"
							target="_blank"
						>
							{wallpaper.attribution}
						</a>
					</p>
				) : wallpaper.attribution ? (
					<p className={cn("text-white/55 text-xs", TEXT_SHADOW)}>
						{tl("Photo: {attribution}", {
							attribution: wallpaper.attribution,
						})}
					</p>
				) : null}
			</div>
		</div>
	);
}
