import { Spinner } from "@ryu/ui/components/spinner";
import { cn } from "@ryu/ui/lib/utils";
import {
	type ComponentType,
	type CSSProperties,
	createElement,
	Suspense,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	type AgentBadgeImages,
	type AgentBadgeInput,
	generateAgentBadge,
} from "@/src/lib/agent-badge.ts";

// Fill the wrapper's height (set on the container) instead of the default 100vh.
const FILL_HEIGHT = { "--lanyard-height": "100%" } as CSSProperties;

type LanyardComponent = ComponentType<Record<string, unknown>>;

function renderLanyard(
	root: Root,
	Lanyard: LanyardComponent,
	images: AgentBadgeImages
) {
	root.render(
		createElement(
			Suspense,
			{ fallback: null },
			createElement(Lanyard, {
				backImage: images.back,
				frontImage: images.front,
				// A low fov flattens perspective so the hanging card reads as a card,
				// not a foreshortened trapezoid. The camera sits back far enough that
				// the whole badge + lanyard fit the frame without being cropped/zoomed
				// in on a narrow rail. x-offset re-centres the natural rest lean.
				fov: 14,
				gravity: [0, -40, 0],
				lanyardWidth: 1.4,
				position: [1, -1, 16],
				style: FILL_HEIGHT,
			})
		)
	);
}

export interface AgentLanyardCardProps extends AgentBadgeInput {
	className?: string;
}

/**
 * Shows an agent as an "employee badge" hanging from a draggable lanyard, with a
 * badge face generated from the agent's own fields (so each agent gets a
 * distinct card).
 *
 * The 3D scene is mounted into an ISOLATED React root that is created exactly
 * once. @react-three/rapier's physics world is a process-global wasm singleton:
 * under React StrictMode's dev mount→unmount→remount, tearing the scene down
 * frees that world and leaves the canvas blank. So we (a) render outside the app
 * tree (no StrictMode wrapper) and (b) cancel the teardown if React remounts in
 * the same tick — the root, and rapier's world, survive. Real unmount still
 * tears down (the deferred teardown fires when no remount cancels it). Also
 * keeps three.js + the rapier wasm out of the main bundle (dynamic import).
 */
export function AgentLanyardCard({
	className,
	name,
	role,
	engine,
	version,
	node,
	builtIn,
	description,
}: AgentLanyardCardProps) {
	// Debounce the inputs so typing in the edit form doesn't regenerate the badge
	// (and reload the card texture, which re-suspends the scene) on every
	// keystroke. Seeded with the initial props so the first paint is immediate.
	const [badgeInput, setBadgeInput] = useState<AgentBadgeInput>({
		builtIn,
		description,
		engine,
		name,
		node,
		role,
		version,
	});
	useEffect(() => {
		const id = setTimeout(
			() =>
				setBadgeInput({
					builtIn,
					description,
					engine,
					name,
					node,
					role,
					version,
				}),
			350
		);
		return () => clearTimeout(id);
	}, [name, role, engine, version, node, builtIn, description]);

	const images: AgentBadgeImages | null = useMemo(
		() => generateAgentBadge(badgeInput),
		[badgeInput]
	);

	const hostRef = useRef<HTMLDivElement>(null);
	const rootRef = useRef<Root | null>(null);
	const mountElRef = useRef<HTMLDivElement | null>(null);
	const lanyardRef = useRef<LanyardComponent | null>(null);
	const teardownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Latest images for the async import callback / re-render effect to read.
	const imagesRef = useRef(images);
	imagesRef.current = images;
	const [ready, setReady] = useState(false);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) {
			return;
		}
		// A StrictMode remount lands here right after the cleanup below scheduled
		// a teardown — cancel it so the existing root (and rapier's world) lives.
		if (teardownRef.current) {
			clearTimeout(teardownRef.current);
			teardownRef.current = null;
		}

		if (rootRef.current) {
			// Reused after a cancelled teardown — repaint with the latest badge.
			const imgs = imagesRef.current;
			if (lanyardRef.current && imgs) {
				renderLanyard(rootRef.current, lanyardRef.current, imgs);
			}
		} else {
			const mountEl = document.createElement("div");
			mountEl.style.width = "100%";
			mountEl.style.height = "100%";
			host.appendChild(mountEl);
			mountElRef.current = mountEl;
			const root = createRoot(mountEl);
			rootRef.current = root;
			import("@ryu/ui/components/lanyard/Lanyard")
				.then((mod) => {
					if (rootRef.current !== root) {
						return; // torn down before the chunk arrived
					}
					lanyardRef.current = mod.default as unknown as LanyardComponent;
					const imgs = imagesRef.current;
					if (imgs) {
						renderLanyard(root, lanyardRef.current, imgs);
						setReady(true);
					}
				})
				.catch(() => {
					/* chunk load failed — leave the fallback spinner in place */
				});
		}

		return () => {
			// Defer: a StrictMode remount (or fast re-render) cancels this before it
			// runs, so the scene only tears down on a real unmount.
			teardownRef.current = setTimeout(() => {
				rootRef.current?.unmount();
				mountElRef.current?.remove();
				rootRef.current = null;
				mountElRef.current = null;
				lanyardRef.current = null;
				teardownRef.current = null;
			}, 0);
		};
	}, []);

	// Repaint the live scene when the badge changes (no canvas/physics remount).
	useEffect(() => {
		if (rootRef.current && lanyardRef.current && images) {
			renderLanyard(rootRef.current, lanyardRef.current, images);
		}
	}, [images]);

	return (
		<div className={cn("relative h-full w-full", className)}>
			{ready ? null : (
				<div className="absolute inset-0 flex items-center justify-center">
					<Spinner />
				</div>
			)}
			<div className="absolute inset-0" ref={hostRef} />
		</div>
	);
}
