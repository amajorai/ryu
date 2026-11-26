import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	isOnboardingLanguageEvent,
	OnboardingLanguageControl,
} from "@/src/components/onboarding/OnboardingLanguageControl.tsx";
import { useRyuOnboardingPersona } from "@/src/components/onboarding/RyuOnboardingPersona.tsx";
import { useMotionAllowed } from "@/src/hooks/useSeasonalEffects.ts";

const WELCOME_MS = 3000;
const SENTENCE_MS = 2400;
/** `--duration-base`: one quiet fade between the two beats. */
const FADE_SECONDS = 0.2;

type Beat = { kind: "welcome" } | { kind: "sentence"; text: string };

const HEADER_CLASS =
	"text-balance text-center font-medium text-2xl tracking-tight";

function RyuWelcomeWordmark({ reducedMotion }: { reducedMotion: boolean }) {
	return (
		<span
			className="ryu-welcome-wordmark text-foreground"
			data-reduced-motion={reducedMotion}
		>
			<span>Ryu</span>
			{reducedMotion ? null : (
				<span aria-hidden="true" className="ryu-welcome-wordmark__sweep">
					Ryu
				</span>
			)}
		</span>
	);
}

function beatKey(beat: Beat) {
	return beat.kind === "welcome" ? "welcome" : beat.text;
}

function beatDuration(beat: Beat) {
	return beat.kind === "welcome" ? WELCOME_MS : SENTENCE_MS;
}

interface WelcomeStepProps {
	onContinue: () => void;
}

/**
 * The first-run welcome: two beats, the agent's greeting and then "Welcome to
 * Ryu", each fading into the next, then straight into setup.
 * Skip (or Enter or Escape) goes straight to setup. With motion off (the app's
 * animations setting or the system's reduced-motion preference) it shows only
 * the welcome line. The language control in the top corner holds the welcome
 * still while its menu is open, and keeps its own Enter and Escape.
 */
export function WelcomeStep({ onContinue }: WelcomeStepProps) {
	const tl = useLiteralMessages();
	const reducedMotion = !useMotionAllowed();
	const { name } = useRyuOnboardingPersona();
	const [index, setIndex] = useState(0);
	const [languageOpen, setLanguageOpen] = useState(false);
	const languageOpenRef = useRef(languageOpen);
	languageOpenRef.current = languageOpen;
	const onContinueRef = useRef(onContinue);
	onContinueRef.current = onContinue;
	const finishedRef = useRef(false);

	const beats = useMemo<Beat[]>(
		() =>
			reducedMotion
				? [{ kind: "welcome" }]
				: [
						{ kind: "sentence", text: tl("Hi, I'm {name}.", { name }) },
						{ kind: "welcome" },
					],
		[name, reducedMotion, tl]
	);
	const beatIndex = Math.min(index, beats.length - 1);
	const beat = beats[beatIndex] ?? beats[0];
	const isLast = beatIndex >= beats.length - 1;
	const duration = beatDuration(beat);

	const finish = useCallback(() => {
		if (finishedRef.current) {
			return;
		}
		finishedRef.current = true;
		onContinueRef.current();
	}, []);

	useEffect(() => {
		// Choosing a language takes longer than a beat: the beat starts over
		// once the menu closes, so the welcome is never missed behind it.
		if (languageOpen) {
			return;
		}
		const timeout = window.setTimeout(() => {
			if (isLast) {
				finish();
			} else {
				setIndex((current) => current + 1);
			}
		}, duration);
		return () => window.clearTimeout(timeout);
	}, [beatIndex, isLast, duration, finish, languageOpen]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Enter" && event.key !== "Escape") {
				return;
			}
			// In the language control these keys open the menu, choose a
			// language or close the menu. They are not a skip.
			if (languageOpenRef.current || isOnboardingLanguageEvent(event.target)) {
				return;
			}
			event.preventDefault();
			finish();
		};
		// Capture: the key that closes the menu is seen here while the menu
		// still counts as open, before the menu handles it.
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [finish]);

	return (
		<div
			className="relative flex size-full items-center justify-center p-8"
			data-tauri-drag-region="true"
		>
			<div
				aria-live="polite"
				className="flex h-24 w-full max-w-xl items-center justify-center"
				data-beat={beat.kind}
				data-testid="onboarding-welcome-beat"
			>
				<AnimatePresence initial={false} mode="wait">
					<motion.div
						animate={{ opacity: 1 }}
						className="flex items-center justify-center"
						exit={{ opacity: 0 }}
						initial={{ opacity: 0 }}
						key={beatKey(beat)}
						transition={{
							duration: reducedMotion ? 0 : FADE_SECONDS,
							ease: [0.19, 1, 0.22, 1],
						}}
					>
						{beat.kind === "welcome" ? (
							<h1 className={HEADER_CLASS}>
								<span className="inline-flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 leading-none">
									<span>Welcome to</span>
									<span
										aria-hidden="true"
										className="inline-flex h-[1.55em] items-center"
									>
										<RyuWelcomeWordmark reducedMotion={reducedMotion} />
									</span>
									<span className="sr-only">Ryu</span>
								</span>
							</h1>
						) : null}
						{beat.kind === "sentence" ? (
							<h1 className={HEADER_CLASS}>{beat.text}</h1>
						) : null}
					</motion.div>
				</AnimatePresence>
			</div>
			<OnboardingLanguageControl onOpenChange={setLanguageOpen} />
			<Button
				aria-label="Skip the introduction"
				className="absolute end-6 bottom-6 h-10 px-4"
				data-testid="onboarding-welcome-skip"
				onClick={finish}
				variant="ghost-muted"
			>
				Skip
			</Button>
		</div>
	);
}
