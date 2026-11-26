import { Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { isMac } from "@ryu/hotkeys/chord";
import { useI18n, useLiteralMessages, useOptionalI18n } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { FadeOverflowText } from "@ryu/ui/components/fade-overflow-text.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import {
	AUTO_DETECT_VALUE,
	DEFAULT_PACK_VALUE,
	ENGLISH_LANGUAGE,
	type LanguageName,
	useLanguageChoice,
} from "@/src/hooks/useLanguageChoice.ts";
import { topBarInsets } from "@/src/lib/window-chrome-layout.ts";

/** The screens after the welcome that keep the language control. */
const LANGUAGE_PHASES: readonly string[] = ["updates", "choose"];

/**
 * Whether the onboarding page shows the language control for a phase. The
 * welcome places its own (it waits while the menu is open); the two screens
 * after it keep the control, so a user who skipped the short welcome still
 * reaches it. It goes away once setup starts.
 */
export function onboardingPhaseKeepsLanguage(phase: string): boolean {
	return LANGUAGE_PHASES.includes(phase);
}

/**
 * Whether a key or pointer event started in the language control: its button
 * or its open menu. A screen that owns Enter and Escape (the welcome's skip)
 * leaves those events to the control.
 */
export function isOnboardingLanguageEvent(target: EventTarget | null): boolean {
	return (
		target instanceof Element &&
		target.closest("[data-onboarding-language]") !== null
	);
}

/** A language's own name: marked with its language and never translated. */
function Endonym({
	className,
	language,
}: {
	className?: string;
	language: LanguageName;
}) {
	return (
		<span className={className} data-ryu-i18n="off" lang={language.locale}>
			{language.name}
		</span>
	);
}

interface OnboardingLanguageControlProps {
	/** Told when the menu opens or closes, so a timed screen can wait. */
	onOpenChange?: (open: boolean) => void;
}

/**
 * The language choice on the first onboarding screens: a globe button showing
 * the current language by its own name, opening the languages that apply at
 * once. It writes the same choice as Settings (see `useLanguageChoice`).
 * Packs the node must enable or download stay in Settings, because the node
 * may not exist yet. Without a language provider it renders nothing.
 *
 * It sits in the top corner at the end of the reading direction, inside a
 * positioned parent, and clears the native window controls the way a top bar
 * does (see `topBarInsets`).
 */
export function OnboardingLanguageControl(
	props: OnboardingLanguageControlProps
) {
	return useOptionalI18n() ? <LanguageMenu {...props} /> : null;
}

function LanguageMenu({ onOpenChange }: OnboardingLanguageControlProps) {
	const { t } = useI18n();
	const tl = useLiteralMessages();
	const { nativeWindowChrome } = useAppSurface();
	const { busyId, readyPacks, select, selectedPack, systemLanguage, value } =
		useLanguageChoice();
	const label = tl("Language");
	const current = selectedPack
		? { locale: selectedPack.locale, name: selectedPack.name }
		: ENGLISH_LANGUAGE;

	return (
		// The bar spans the window so the insets can clear the native controls
		// on either side; only the button itself takes pointer input, so the
		// window stays draggable around it.
		<div
			className={cn(
				"pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-end px-6 pt-3",
				topBarInsets({ isMac: isMac(), nativeWindowChrome })
			)}
			data-testid="onboarding-language-bar"
		>
			<div className="pointer-events-auto" data-onboarding-language="">
				<DropdownMenu onOpenChange={(open) => onOpenChange?.(open)}>
					<DropdownMenuTrigger
						render={
							<Button
								className="h-10 max-w-56 gap-2 px-3"
								data-testid="onboarding-language-trigger"
								disabled={busyId !== null}
								// The visible name is the language itself, so the button
								// is named by it; the title says what the button is for.
								title={label}
								type="button"
								variant="ghost-muted"
							/>
						}
					>
						<HugeiconsIcon
							aria-hidden="true"
							className="size-4 shrink-0"
							icon={Globe02Icon}
						/>
						{/* Not ButtonLabel: it translates its text, and an endonym stays as is. */}
						<FadeOverflowText className="min-w-0 max-w-full">
							<Endonym language={current} />
						</FadeOverflowText>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="end"
						className="max-h-80 w-60"
						data-onboarding-language=""
						data-testid="onboarding-language-menu"
						drawerLabel={label}
					>
						<DropdownMenuGroup>
							<DropdownMenuLabel>{label}</DropdownMenuLabel>
							<DropdownMenuRadioGroup
								onValueChange={(next) => {
									void select(next);
								}}
								value={value}
							>
								<DropdownMenuRadioItem closeOnClick value={AUTO_DETECT_VALUE}>
									<span>{t("language.auto_detect")}</span>
									<Endonym
										className="text-muted-foreground"
										language={systemLanguage}
									/>
								</DropdownMenuRadioItem>
								<DropdownMenuSeparator />
								<DropdownMenuRadioItem closeOnClick value={DEFAULT_PACK_VALUE}>
									<Endonym language={ENGLISH_LANGUAGE} />
								</DropdownMenuRadioItem>
								{readyPacks.map((pack) => (
									<DropdownMenuRadioItem
										closeOnClick
										key={pack.id}
										value={pack.id}
									>
										<Endonym language={pack} />
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	);
}
