"use client";

import { useEffect, useRef, useState } from "react";
import { ensureGameDisplayFont } from "../../desktop/interfaces/game-font.ts";
import { ensureLobbyDisplayFont } from "../../desktop/interfaces/lobby-font.ts";
import { loadPixelFont } from "../../desktop/interfaces/world-2d-font.ts";

/*
 * The /interfaces stage backdrop: real screenshots of the desktop's
 * interfaces (served from the web app's /interfaces/hero/), crossfading one
 * after another in the site's theme. Each slide names the display face its
 * interface uses, and the reel sets it as `data-reel-font` on the stage hero
 * so the page can set the title in that face. Only the current and next
 * slides are in the DOM, so a visitor downloads one or two images at a time.
 * With reduced motion it holds on the first slide.
 */

type ReelFont = "pixel" | "game" | "lobby";

const SLIDES: readonly { id: string; font: ReelFont }[] = [
	{ id: "world-2d", font: "pixel" },
	{ id: "farm", font: "game" },
	{ id: "lobby", font: "lobby" },
	{ id: "town", font: "game" },
	{ id: "kitchen", font: "game" },
	{ id: "aquarium", font: "game" },
];

const HOLD_MS = 5200;

function Slide({ id, active }: { id: string; active: boolean }) {
	return (
		<div
			className="absolute inset-0 transition-opacity duration-1000 ease-out motion-reduce:transition-none"
			data-reel-slide={id}
			style={{ opacity: active ? 1 : 0 }}
		>
			{["light", "dark"].map((theme) => (
				// biome-ignore lint/performance/noImgElement: a decorative backdrop layer in a shared package outside next/image.
				<img
					alt=""
					className={`h-full w-full scale-105 object-cover ${theme === "dark" ? "hidden dark:block" : "dark:hidden"}`}
					decoding="async"
					height={850}
					key={theme}
					src={`/interfaces/hero/${id}-${theme}.webp`}
					width={1600}
				/>
			))}
		</div>
	);
}

export default function InterfaceReel() {
	const [index, setIndex] = useState(0);
	const root = useRef<HTMLDivElement>(null);

	useEffect(() => {
		ensureGameDisplayFont();
		ensureLobbyDisplayFont();
		loadPixelFont().catch(() => undefined);
		if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
			return;
		}
		const timer = setInterval(() => {
			if (!document.hidden) {
				setIndex((current) => (current + 1) % SLIDES.length);
			}
		}, HOLD_MS);
		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		const stage = root.current?.closest<HTMLElement>(
			'[data-product-hero-layout="stage"]'
		);
		if (stage) {
			stage.dataset.reelFont = SLIDES[index]?.font;
		}
	}, [index]);

	const next = (index + 1) % SLIDES.length;
	return (
		<div className="absolute inset-0" ref={root}>
			{SLIDES.map((slide, position) =>
				position === index || position === next ? (
					<Slide active={position === index} id={slide.id} key={slide.id} />
				) : null
			)}
			<div className="absolute inset-0 bg-background/60" />
		</div>
	);
}
