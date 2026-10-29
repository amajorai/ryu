import sceneStyles from "./startup-glass.module.css";
import "./DesktopStartupChooser.css";
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
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	ArrowLeft,
	ArrowRight,
	Cloud,
	Computer,
	ImageIcon,
	Plus,
	Shuffle,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
	BACKEND_URL,
	getActiveUserId,
	listAccounts,
	switchAccount,
} from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import { useTimezoneRevision } from "@/src/hooks/useTimezone.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
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
	WallpaperPicker,
	WallpaperPreview,
} from "../wallpaper/WallpaperPicker.tsx";

type AccountView = ReturnType<typeof listAccounts>[number];

type StartupStep = "account" | "node";

/**
 * Liquid-glass surface in the macOS 27 style: a frosted, saturated backdrop,
 * a bright specular rim on top, a faint inner shadow below, and a soft drop
 * shadow. CSS only, so it renders the same in WebView2 and WKWebView.
 */
const GLASS = cn("border border-white/25 bg-white/[0.12]", sceneStyles.glass);

const GLASS_HOVER =
	"transition-[background-color,scale] hover:bg-white/[0.2] active:scale-[0.97] motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80";

const TEXT_SHADOW = sceneStyles.textShadow;

function accountLabel(account: AccountView): string {
	if (account.isAnonymous) {
		return "Guest";
	}
	return account.name || account.email || "Account";
}

/** The date and big glass clock at the top, like the macOS login window. */
function LoginClock() {
	const [hour24] = usePersistedToggle("ryu:os-home:24-hour", false);
	const [now, setNow] = useState(() => Date.now());
	useTimezoneRevision();
	useEffect(() => {
		let timeout: ReturnType<typeof setTimeout>;
		const tick = () => {
			const current = Date.now();
			setNow(current);
			timeout = setTimeout(tick, 60_000 - (current % 60_000));
		};
		tick();
		return () => clearTimeout(timeout);
	}, []);
	const time = formatDateTime(now, {
		hour: "numeric",
		minute: "2-digit",
		hourCycle: hour24 ? "h23" : "h12",
	}).replace(/\s?[AP]M$/i, "");
	return (
		<div
			className="pointer-events-none flex flex-col items-center"
			data-testid="startup-clock"
		>
			<p
				className={cn(
					"font-semibold text-white/90 text-xl tracking-tight",
					TEXT_SHADOW
				)}
			>
				{formatDateTime(now, {
					weekday: "short",
					month: "short",
					day: "numeric",
				})}
			</p>
			<time
				className="relative font-semibold tabular-nums leading-none"
				data-startup-title=""
				dateTime={new Date(now).toISOString()}
			>
				{/* Liquid-glass numerals: a tinted fill with a bright top edge and a
				    soft refraction shadow underneath. */}
				<span
					aria-hidden="true"
					className="absolute inset-0 translate-y-[3px] text-black/35 blur-sm"
					data-startup-title-glow=""
				>
					{time}
				</span>
				<span
					className="relative bg-clip-text text-transparent [-webkit-text-stroke:1px_rgba(255,255,255,0.5)]"
					data-startup-title-gradient=""
				>
					{time}
				</span>
			</time>
		</div>
	);
}

/** One selectable login-window entry: a round glass tile with a name below. */
function LoginTile({
	disabled = false,
	children,
	label,
	onClick,
	onDoubleClick,
	selected,
}: {
	disabled?: boolean;
	children: ReactNode;
	label: string;
	onClick: () => void;
	onDoubleClick?: () => void;
	selected: boolean;
}) {
	return (
		<button
			aria-checked={selected}
			className={cn(
				"group flex w-32 flex-col items-center gap-2.5 rounded-2xl p-2 outline-none transition-[opacity,scale] duration-300 focus-visible:ring-2 focus-visible:ring-white/80 motion-reduce:transition-none",
				selected
					? "scale-100 opacity-100"
					: "scale-[0.92] opacity-70 hover:opacity-95"
			)}
			disabled={disabled}
			onClick={onClick}
			onDoubleClick={onDoubleClick}
			role="radio"
			type="button"
		>
			<span
				className={cn(
					"flex size-20 items-center justify-center overflow-hidden rounded-full p-1",
					GLASS,
					selected && "bg-white/25 ring-2 ring-white/70"
				)}
			>
				{children}
			</span>
			<span
				className={cn(
					"max-w-full truncate font-semibold text-sm text-white",
					TEXT_SHADOW
				)}
				title={label}
			>
				{label}
			</span>
		</button>
	);
}

function DefaultSwitch({
	disabled = false,
	id,
	checked,
	onCheckedChange,
}: {
	disabled?: boolean;
	id: string;
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	return (
		<div className="flex items-center justify-center gap-2">
			<label
				className={cn("font-medium text-white/85 text-xs", TEXT_SHADOW)}
				htmlFor={id}
			>
				Use as default
			</label>
			<Switch
				aria-label="Use as default"
				checked={checked}
				disabled={disabled}
				id={id}
				onCheckedChange={onCheckedChange}
				size="sm"
			/>
		</div>
	);
}

/** The glass pill that stands in for the macOS password field. */
function ContinueButton({
	busy,
	disabled,
	label,
	onClick,
}: {
	busy: boolean;
	disabled: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			className={cn(
				"flex h-10 min-w-56 items-center justify-between gap-3 rounded-full pr-1 pl-5 font-medium text-sm text-white disabled:opacity-50",
				GLASS,
				GLASS_HOVER
			)}
			disabled={disabled}
			onClick={onClick}
			type="button"
		>
			{label}
			<span className="flex size-8 items-center justify-center rounded-full bg-white/25">
				{busy ? (
					<Spinner className="size-4" />
				) : (
					<ArrowRight aria-hidden="true" className="size-4" />
				)}
			</span>
		</button>
	);
}

function moveSelection<T>(
	items: readonly T[],
	current: T | undefined,
	delta: number
): T | undefined {
	if (items.length === 0) {
		return current;
	}
	const index = current === undefined ? -1 : items.indexOf(current);
	const next = (index + delta + items.length) % items.length;
	return items[next];
}

function WallpaperButton() {
	const { shuffle } = useWallpaper();
	return (
		<div className="flex items-center gap-2" data-tauri-drag-region={false}>
			<button
				aria-label="Shuffle wallpaper"
				className={cn(
					"flex size-9 items-center justify-center rounded-full text-white",
					GLASS,
					GLASS_HOVER
				)}
				onClick={shuffle}
				title="Shuffle wallpaper"
				type="button"
			>
				<Shuffle className="size-4" />
			</button>
			<Popover>
				<PopoverTrigger
					aria-label="Choose wallpaper"
					variant="startup-wallpaper"
				>
					<ImageIcon className="size-4" />
					Wallpaper
				</PopoverTrigger>
				<PopoverContent
					align="end"
					className="max-h-[min(40rem,75vh)] w-[min(40rem,calc(100vw-2rem))] overflow-y-auto"
				>
					<WallpaperPreview />
					<WallpaperPicker />
				</PopoverContent>
			</Popover>
		</div>
	);
}

export function DesktopStartupChooser() {
	const { nodes, defaultNode, setDefault } = useNodeStore();
	const { wallpaper } = useWallpaper();
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
										<Plus className="size-7" />
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
										<Computer className="size-8" />
									) : (
										<Cloud className="size-8" />
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
									<ArrowLeft className="size-4" />
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
					<p className={cn("type-compact text-white/55", TEXT_SHADOW)}>
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
					<p className={cn("type-compact text-white/55", TEXT_SHADOW)}>
						Photo: {wallpaper.attribution}
					</p>
				) : null}
			</div>
		</div>
	);
}
