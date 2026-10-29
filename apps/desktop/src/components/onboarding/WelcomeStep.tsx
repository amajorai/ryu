import { useLiteralMessages } from "@ryu/i18n/react";
import { AppleHelloEffect } from "@ryu/ui/components/apple-hello-effect.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRyuOnboardingPersona } from "@/src/components/onboarding/RyuOnboardingPersona.tsx";
import { useMotionAllowed } from "@/src/hooks/useSeasonalEffects.ts";

const WELCOME_MS = 3500;
const HELLO_LANGUAGE_MS = 2400;
const SENTENCE_MS = 3200;
const FADE_SECONDS = 0.8;

const HELLO_LANGUAGES = [
	{ language: "English", text: "hello" },
	{ language: "Hindi", text: "नमस्ते" },
	{ language: "Spanish", text: "hola" },
	{ language: "Vietnamese", text: "xin chào" },
] as const;

type Beat =
	| { kind: "welcome" }
	| { kind: "hello"; language: string; text: string }
	| { kind: "sentence"; text: string };

const HEADER_CLASS = "text-center font-medium text-2xl sm:text-3xl";

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
	if (beat.kind === "welcome") {
		return "welcome";
	}
	return beat.kind === "hello" ? `hello-${beat.language}` : beat.text;
}

function beatDuration(beat: Beat) {
	if (beat.kind === "welcome") {
		return WELCOME_MS;
	}
	return beat.kind === "hello" ? HELLO_LANGUAGE_MS : SENTENCE_MS;
}

interface WelcomeStepProps {
	onContinue: () => void;
}

/**
 * The first-run welcome: one line at a time, each fading into the next, ending
 * on "Welcome to Ryu" and one pass of the hello loop, then straight into setup.
 * Skip (or Enter or Escape) goes straight to setup. With motion off (the app's
 * animations setting or the system's reduced-motion preference) it shows only
 * the welcome line.
 */
export function WelcomeStep({ onContinue }: WelcomeStepProps) {
	const tl = useLiteralMessages();
	const reducedMotion = !useMotionAllowed();
	const { name } = useRyuOnboardingPersona();
	const [index, setIndex] = useState(0);
	const onContinueRef = useRef(onContinue);
	onContinueRef.current = onContinue;
	const finishedRef = useRef(false);

	const beats = useMemo<Beat[]>(
		() =>
			reducedMotion
				? [{ kind: "welcome" }]
				: [
						{ kind: "sentence", text: "Let's personalize your experience." },
						{ kind: "sentence", text: tl("Hi, I'm {name}.", { name }) },
						{ kind: "sentence", text: "I help you get real work done." },
						{ kind: "welcome" },
						...HELLO_LANGUAGES.map(
							(hello): Beat => ({ kind: "hello", ...hello })
						),
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
		const timeout = window.setTimeout(() => {
			if (isLast) {
				finish();
			} else {
				setIndex((current) => current + 1);
			}
		}, duration);
		return () => window.clearTimeout(timeout);
	}, [beatIndex, isLast, duration, finish]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Enter" || event.key === "Escape") {
				event.preventDefault();
				finish();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
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
				data-language={beat.kind === "hello" ? beat.language : undefined}
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
							ease: "easeInOut",
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
						{beat.kind === "hello" ? (
							<div className="text-5xl text-foreground sm:text-6xl">
								<AppleHelloEffect
									className="flex h-24 items-center justify-center"
									durationScale={reducedMotion ? 0 : 0.7}
									text={beat.language === "English" ? undefined : beat.text}
								/>
							</div>
						) : null}
						{beat.kind === "sentence" ? (
							<h1 className={HEADER_CLASS}>{beat.text}</h1>
						) : null}
					</motion.div>
				</AnimatePresence>
			</div>
			<Button
				aria-label="Skip the introduction"
				className="absolute right-6 bottom-6"
				data-testid="onboarding-welcome-skip"
				onClick={finish}
				variant="ghost"
			>
				Skip
			</Button>
		</div>
	);
}
