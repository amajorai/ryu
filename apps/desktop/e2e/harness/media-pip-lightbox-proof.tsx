import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MediaPipDock } from "../../src/components/media/MediaPip.tsx";
import {
	clearMediaSource,
	type MediaSourceKind,
	publishMediaSource,
} from "../../src/lib/media-pip.ts";
import "../../src/index.css";
import styles from "./media-pip-lightbox-proof.module.css";

function frame(label: string, start: string, end: string): string {
	return URL.createObjectURL(
		new Blob(
			[
				`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="${start}"/><stop offset="1" stop-color="${end}"/></linearGradient></defs><rect width="960" height="540" fill="url(#g)"/><circle cx="780" cy="120" r="180" fill="#ffffff" fill-opacity=".12"/><rect x="64" y="72" width="210" height="10" rx="5" fill="#ffffff" fill-opacity=".5"/><rect x="64" y="108" width="420" height="24" rx="12" fill="#ffffff" fill-opacity=".9"/><rect x="64" y="164" width="310" height="12" rx="6" fill="#ffffff" fill-opacity=".42"/><text x="64" y="430" fill="#ffffff" font-family="Inter, sans-serif" font-size="42" font-weight="700">${label}</text><text x="64" y="474" fill="#ffffff" fill-opacity=".7" font-family="Inter, sans-serif" font-size="20">Sample media frame</text></svg>`,
			],
			{ type: "image/svg+xml" }
		)
	);
}

const SOURCES = {
	browser: {
		end: "#2563eb",
		kind: "browser",
		start: "#0f172a",
		title: "Agent Browser active tab",
	},
	desktop: {
		end: "#0f766e",
		kind: "desktop",
		start: "#164e63",
		title: "Remote node desktop",
	},
	recording: {
		end: "#c2410c",
		kind: "recording",
		start: "#7c2d12",
		title: "Evidence recording",
	},
} satisfies Record<
	"browser" | "desktop" | "recording",
	{
		end: string;
		kind: MediaSourceKind;
		start: string;
		title: string;
	}
>;

async function sampleRecording(): Promise<string> {
	const canvas = document.createElement("canvas");
	canvas.width = 960;
	canvas.height = 540;
	const context = canvas.getContext("2d");
	if (!context) {
		throw new Error("Canvas recording is unavailable");
	}
	const stream = canvas.captureStream(12);
	const recorder = new MediaRecorder(stream);
	const chunks: BlobPart[] = [];
	let frame = 0;
	const timer = setInterval(() => {
		context.fillStyle = "#0099ff";
		context.fillRect(0, 0, 960, 540);
		context.fillStyle = "#ffffff";
		context.font = "36px sans-serif";
		context.fillText("Sample recording", 64, 260);
		context.fillRect(64, 310, 24 + frame++ * 20, 6);
	}, 40);
	try {
		await new Promise<void>((resolve, reject) => {
			recorder.ondataavailable = (event) => chunks.push(event.data);
			recorder.onstop = () => resolve();
			recorder.onerror = () => reject(new Error("Sample recording failed"));
			recorder.start();
			setTimeout(() => {
				if (recorder.state !== "inactive") {
					recorder.stop();
				}
			}, 600);
		});
		return URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType }));
	} finally {
		clearInterval(timer);
		for (const track of stream.getTracks()) {
			track.stop();
		}
	}
}

function Proof() {
	const [active, setActive] = useState<keyof typeof SOURCES>("browser");
	const source = SOURCES[active];

	useEffect(() => {
		let cancelled = false;
		let videoUrl: string | undefined;
		const imageUrl = frame(source.title, source.start, source.end);
		const publish = (recordingUrl?: string) => {
			const draft: Parameters<typeof publishMediaSource>[0] = {
				id: `proof:${active}`,
				imageUrl,
				kind: source.kind,
				title: source.title,
			};
			if (recordingUrl) {
				draft.videoUrl = recordingUrl;
			}
			publishMediaSource(draft);
		};
		if (source.kind === "recording") {
			void sampleRecording().then((url) => {
				videoUrl = url;
				if (cancelled) {
					URL.revokeObjectURL(url);
				} else {
					publish(url);
				}
			});
		} else {
			publish();
		}
		return () => {
			cancelled = true;
			if (videoUrl) {
				URL.revokeObjectURL(videoUrl);
			}
			clearMediaSource(`proof:${active}`);
			URL.revokeObjectURL(imageUrl);
		};
	}, [active, source]);

	return (
		<main
			className={`${styles.page} min-h-screen px-6 py-10 text-white sm:px-10`}
		>
			<div className="mx-auto max-w-5xl space-y-8">
				<header className="max-w-2xl space-y-3">
					<p className={`${styles.eyebrow} font-semibold text-xs uppercase`}>
						Media UI verification · sample frames
					</p>
					<h1 className="font-semibold text-4xl tracking-tight">
						One picture-in-picture surface for every active tab
					</h1>
					<p className={`${styles.secondary} text-sm leading-6`}>
						Browser frames, remote-node VNC frames, and evidence recordings
						share the same dock. Selecting the thumbnail opens the existing
						morphing lightbox.
					</p>
				</header>

				<section className="rounded-3xl border border-white/10 bg-white/[0.04] p-6 shadow-2xl">
					<div className="flex flex-wrap items-center justify-between gap-4">
						<div>
							<p className="font-medium text-lg">Active source</p>
							<p
								className={`${styles.muted} mt-1 text-sm`}
								data-testid="proof-active-source"
							>
								{source.title}
							</p>
						</div>
						<div
							aria-label="Choose media source"
							className="flex flex-wrap gap-2"
							role="group"
						>
							{Object.values(SOURCES).map(({ kind: key }) => (
								<button
									className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${active === key ? styles.selectedSource : `${styles.secondary} border-white/10 bg-white/[0.04] hover:bg-white/[0.08]`}`}
									data-testid={`source-${key}`}
									key={key}
									onClick={() => setActive(key)}
									type="button"
								>
									{key}
								</button>
							))}
						</div>
					</div>
					<div className="mt-6 grid min-h-[280px] place-items-center rounded-2xl border border-white/10 bg-black/20 p-8 text-center">
						<div className="max-w-md space-y-2">
							<p className="font-medium text-xl">Use the floating dock</p>
							<p className={`${styles.muted} text-sm leading-6`}>
								The native OS PiP action appears in the bottom-right corner when
								a live source is active. Click its frame to test the
								small-to-large lightbox transition.
							</p>
						</div>
					</div>
				</section>
			</div>
			<MediaPipDock />
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Proof />);
}
