/* eslint-disable react/no-unknown-property */
import { useFrame } from "@react-three/fiber";
import { askAriaLabel, type InterfaceAsk } from "@ryuhq/protocol/interfaces";
import { Mail, Package, ScrollText, StickyNote } from "lucide-react";
import { useRef } from "react";
import type { Mesh } from "three";
import { ACT_ART } from "./game3d-acts-palette.ts";
import type { LifeItem } from "./game3d-life.ts";
import { ItemShape } from "./game3d-life.tsx";
import { ToonMesh } from "./game3d-materials.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import { ActPlate, openerLabel, Post } from "./game3d-signs-plate.tsx";

/**
 * A soft glow under an item: steady (`steady`, and always under reduced
 * motion) or gently pulsing.
 */
function Glow({
	reducedMotion,
	steady = false,
	y = 0.05,
}: {
	reducedMotion: boolean;
	steady?: boolean;
	y?: number;
}) {
	const ref = useRef<Mesh>(null);
	useFrame(({ clock }) => {
		if (ref.current && !(reducedMotion || steady)) {
			const pulse = 1 + Math.sin(clock.elapsedTime * 3) * 0.12;
			ref.current.scale.set(pulse, pulse, 1);
		}
	});
	return (
		<mesh position={[0, y, 0]} ref={ref} rotation={[-Math.PI / 2, 0, 0]}>
			<circleGeometry args={[0.32, 24]} />
			<meshBasicMaterial
				color={ACT_ART.glow}
				opacity={0.55}
				toneMapped={false}
				transparent
			/>
		</mesh>
	);
}

/**
 * Unread answers at a station (an idle or working agent with unread
 * replies, or a reply too old to walk): a sealed envelope that glows. Its
 * plate counts them and opens the newest reply's ask card.
 */
export function UnreadMark({
	asks,
	at,
	focusable,
	iconOnly,
	nowMs,
	onOpen,
	ownerName,
	privacy = "full",
	reducedMotion,
}: {
	/** The unread reply asks, newest first. */
	asks: readonly InterfaceAsk[];
	at: Vec3;
	focusable: boolean;
	iconOnly?: boolean;
	nowMs: number;
	onOpen: (askId: string) => void;
	ownerName: string | null;
	privacy?: "full" | "redacted";
	reducedMotion: boolean;
}) {
	const first = asks[0];
	if (!first) {
		return null;
	}
	return (
		<group position={at}>
			<Glow reducedMotion={reducedMotion} steady />
			<ToonMesh
				color={ACT_ART.envelope}
				ink={0.012}
				position={[0, 0.12, 0]}
				rotation={[-0.4, 0, 0]}
				scale={[0.3, 0.2, 0.03]}
			>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={ACT_ART.sealRed}
				position={[0, 0.13, 0.03]}
				rotation={[Math.PI / 2 - 0.4, 0, 0]}
				scale={[0.04, 0.01, 0.04]}
			>
				<cylinderGeometry args={[1, 1, 1, 10]} />
			</ToonMesh>
			<ActPlate
				at={[0, 0.55, 0]}
				focusable={focusable}
				icon={<Mail aria-hidden="true" />}
				iconOnly={iconOnly}
				kind="unread"
				label={openerLabel(asks, ownerName, nowMs, privacy)}
				onActivate={() => onOpen(first.id)}
			>
				{String(asks.length)}
			</ActPlate>
		</group>
	);
}

/**
 * A suggestion at a station (a heal fix, a skill proposal, a question for
 * when you have time): a pinned note, never walked to the you-spot and
 * never counted in "need you". Its plate opens the first suggestion.
 */
export function SuggestionNote({
	asks,
	at,
	focusable,
	iconOnly,
	nowMs,
	onOpen,
	ownerName,
	privacy = "full",
	reducedMotion,
}: {
	asks: readonly InterfaceAsk[];
	at: Vec3;
	focusable: boolean;
	iconOnly?: boolean;
	nowMs: number;
	onOpen: (askId: string) => void;
	ownerName: string | null;
	privacy?: "full" | "redacted";
	reducedMotion: boolean;
}) {
	const first = asks[0];
	if (!first) {
		return null;
	}
	const question = first.kind === "question";
	return (
		<group position={at}>
			<Glow reducedMotion={reducedMotion} y={0.02} />
			<Post color={ACT_ART.post} height={0.4} />
			<ToonMesh
				color={ACT_ART.note}
				ink={0.012}
				position={[0, 0.45, 0.04]}
				rotation={[-0.1, 0, -0.08]}
				scale={[0.22, 0.22, 0.015]}
			>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={ACT_ART.notePin}
				position={[0, 0.54, 0.06]}
				scale={0.025}
			>
				<sphereGeometry args={[1, 8, 6]} />
			</ToonMesh>
			<ActPlate
				at={[0, 0.85, 0]}
				focusable={focusable}
				icon={
					question ? (
						<ScrollText aria-hidden="true" />
					) : (
						<StickyNote aria-hidden="true" />
					)
				}
				iconOnly={iconOnly}
				kind="suggestion"
				label={openerLabel(asks, ownerName, nowMs, privacy)}
				onActivate={() => onOpen(first.id)}
			>
				{String(asks.length)}
			</ActPlate>
		</group>
	);
}

/**
 * A delivered answer on the you-spot tray: the game's produce, glowing
 * until it is read, with its file count. Its plate opens the reply.
 */
export function TrayItem({
	ask,
	at,
	count,
	focusable,
	iconOnly,
	item,
	nowMs,
	onOpen,
	ownerName,
	privacy = "full",
	reducedMotion,
	showCount = true,
	tag = null,
}: {
	ask: InterfaceAsk;
	at: Vec3;
	/** Files changed, when known: the count sticker. */
	count?: number | null;
	focusable: boolean;
	iconOnly?: boolean;
	item: LifeItem;
	nowMs: number;
	onOpen: (askId: string) => void;
	ownerName: string | null;
	privacy?: "full" | "redacted";
	reducedMotion: boolean;
	/** False when the overlay budget drops the count sticker. */
	showCount?: boolean;
	/**
	 * A short tag on the item's plate (the answer's headline, `trayHeadline`);
	 * hidden on icon-only stages. Default none.
	 */
	tag?: string | null;
}) {
	return (
		<group position={at}>
			<Glow reducedMotion={reducedMotion} />
			<ToonMesh
				color={ACT_ART.tray}
				ink={0.012}
				position={[0, 0.02, 0]}
				scale={[0.5, 0.04, 0.36]}
			>
				<boxGeometry />
			</ToonMesh>
			<group position={[0, 0.16, 0]}>
				<ItemShape item={item} />
			</group>
			<ActPlate
				at={[0, 0.65, 0]}
				focusable={focusable}
				icon={<Package aria-hidden="true" />}
				iconOnly={iconOnly}
				kind="tray"
				label={askAriaLabel(ask, ownerName, nowMs, privacy)}
				onActivate={() => onOpen(ask.id)}
				youSpot="tray"
			>
				{showCount && count ? (
					<span data-budgeted-overlay="count">{String(count)}</span>
				) : null}
				{tag && !iconOnly ? <span data-tray-tag="">{tag}</span> : null}
			</ActPlate>
		</group>
	);
}
