/* eslint-disable react/no-unknown-property */
import { useFrame } from "@react-three/fiber";
import { cn } from "@ryu/ui/lib/utils";
import { Check, Ellipsis, Heart, Music, X } from "lucide-react";
import { type RefObject, useLayoutEffect, useRef } from "react";
import type { Group, InstancedMesh } from "three";
import { GAME_PLATE } from "./game-hud.tsx";
import { ACT_ART } from "./game3d-acts-palette.ts";
import {
	LIFE_EFFECT_SECONDS,
	LIFE_ONE_SHOT_SECONDS,
	type LifeBubble,
	type LifeBubbleSide,
	type LifeEffect,
	type LifeFrame,
	type LifeItem,
	type LifeTimeline,
} from "./game3d-life.ts";
import { CurvedBasicMaterial, ToonMesh } from "./game3d-materials.tsx";
import { mathKit } from "./game3d-math.ts";
import { LIFE_ART } from "./game3d-palette.ts";
import type { RigPose } from "./game3d-villager.tsx";

/**
 * The behaviour layer's rendering (the choreography itself is pure, in
 * game3d-life.ts): `poseLife` turns a sampled `LifeFrame` into a rig pose
 * (walk cycle, carry pose, wave, cheer, stumble, sip, stretch, chat),
 * `CarriedItem` draws what a villager holds, `LifeEffects` the sparkle,
 * smoke and dust bursts, and `LifeBubbleTag` the little speech bubble on a
 * villager's name plate. `Villagers` wires them up for any villager whose
 * spec has a `life` script.
 */

/** Where a villager's body is this frame, written by `Villagers`. */
export interface LifeBody {
	scale: number;
	x: number;
	y: number;
	yaw: number;
	z: number;
}

/** One scripted villager's live state, kept across frames. */
export interface LifeRuntime {
	body: LifeBody;
	frame: LifeFrame;
	key: string;
	/** What the plate and hands show now (React state follows it). */
	shown: { bubble: LifeBubble | null; item: LifeItem | null };
	startedAt: number;
	timeline: LifeTimeline;
}

const IDLE_BOB = 2.6;
/** Walk cycle radians per world unit walked. */
const STRIDE = 8.2;
/** Both arms forward, holding something against the chest. */
const CARRY_ARMS = -1.2;
/** Where a carried item sits, in the rig's local space. */
const CARRY_Y = 0.38;
const CARRY_Z = 0.27;

function ease(value: number): number {
	const t = Math.min(1, Math.max(0, value));
	return t * t * (3 - 2 * t);
}

/** How far forward a kneeling villager leans. */
const KNEEL_LEAN = 0.3;

/** Down on one knee: squashed low, a hand on the knee, the other at rest. */
function kneel(out: RigPose) {
	out.scale.set(1.06, 0.74, 1.06);
	out.position.y -= 0.12;
	out.armLeft = -0.7;
	out.armRight = -0.2;
}

/** Arms and body for an action held still (reduced motion). */
function stillPose(frame: LifeFrame, out: RigPose, carrying: boolean) {
	let lean = 0;
	switch (frame.action) {
		case "wave":
			out.armRight = -2.5;
			break;
		case "cheer":
		case "stretch":
			out.armLeft = -2.8;
			out.armRight = -2.8;
			break;
		case "sip":
			out.armRight = -1.9;
			break;
		case "slump":
		case "stumble":
			lean = 0.22;
			out.scale.set(1.04, 0.9, 1.04);
			break;
		case "kneel":
			kneel(out);
			lean = KNEEL_LEAN;
			break;
		case "work":
			out.armRight = -0.35;
			break;
		default:
			break;
	}
	if (carrying) {
		out.armLeft = CARRY_ARMS;
		out.armRight = frame.action === "wave" ? -2.5 : CARRY_ARMS;
	}
	out.rotation.set(lean, frame.yaw, 0);
}

/**
 * Writes the rig pose for a sampled frame. `phase` staggers villagers so a
 * crowd never bobs in step; `still` (reduced motion) holds each action's
 * key pose with no motion at all.
 */
export function poseLife(
	frame: LifeFrame,
	out: RigPose,
	time: number,
	phase: number,
	still: boolean
): void {
	const carrying = frame.item !== null;
	out.holding = carrying;
	out.position.set(frame.position[0], frame.position[1], frame.position[2]);
	if (still) {
		stillPose(frame, out, carrying);
		return;
	}
	if (frame.walking) {
		const step = frame.stride * STRIDE;
		out.position.y += Math.abs(Math.sin(step)) * (carrying ? 0.03 : 0.05);
		if (carrying) {
			out.armLeft = CARRY_ARMS + Math.sin(step) * 0.05;
			out.armRight = CARRY_ARMS - Math.sin(step) * 0.05;
		} else {
			out.armLeft = Math.sin(step) * 0.5;
			out.armRight = -out.armLeft;
		}
		out.rotation.set(0.06, frame.yaw, Math.sin(step) * 0.035);
		return;
	}
	const age = frame.actionAge;
	const into = ease(age / 0.35);
	let speed = IDLE_BOB;
	let lift = 0.045;
	let sway = Math.sin(time * 1.3 + phase) * 0.04;
	let lean = 0;
	let yaw = frame.yaw;
	let hop = 0;
	switch (frame.action) {
		case "work":
			speed = IDLE_BOB * 1.6;
			out.armRight = -0.35 + Math.sin(time * 6 + phase) * 0.55;
			out.armLeft = Math.sin(time * 3 + phase) * 0.12;
			break;
		case "wave": {
			const bounce = Math.max(0, Math.sin(time * 5 + phase));
			lift = 0.12 * bounce * bounce;
			out.armRight = (-2.5 + Math.sin(time * 10 + phase) * 0.35) * into;
			break;
		}
		case "cheer": {
			// One jump with both arms flung up, then arms stay raised a beat.
			const t = Math.min(1, age / LIFE_ONE_SHOT_SECONDS);
			hop = Math.sin(Math.PI * t) * 0.42;
			out.armLeft = -2.8 * ease(age / 0.2);
			out.armRight = out.armLeft;
			lift = 0.02;
			break;
		}
		case "stumble": {
			// A trip forward and a wobble, ending slumped.
			const t = Math.min(1, age / LIFE_ONE_SHOT_SECONDS);
			lean = 0.22 + Math.sin(Math.PI * t) * 0.35;
			sway = Math.sin(t * Math.PI * 3) * 0.12 * (1 - t);
			out.armLeft = -1.4 * Math.sin(Math.PI * t);
			out.armRight = -1.1 * Math.sin(Math.PI * t);
			out.position.y -= Math.sin(Math.PI * t) * 0.05;
			lift = 0.01;
			out.scale.set(1.04, 0.9 + 0.1 * (1 - t), 1.04);
			break;
		}
		case "slump":
			speed = 0.9;
			lift = 0.01;
			sway = 0;
			lean = 0.22;
			out.scale.set(1.04, 0.9, 1.04);
			break;
		case "kneel": {
			// Sinks onto a knee over the first beat, then breathes, low and still.
			const down = ease(age / 0.5);
			kneel(out);
			out.scale.set(1 + 0.06 * down, 1 - 0.26 * down, 1 + 0.06 * down);
			out.position.y += 0.12 * (1 - down);
			lean = KNEEL_LEAN * down;
			speed = 0.8;
			lift = 0.008;
			sway = 0;
			break;
		}
		case "look":
			speed = IDLE_BOB * 0.6;
			yaw += Math.sin(age * 1.6) * 0.7 * into;
			break;
		case "sip":
			// A cup to the mouth, head tipped back a touch.
			out.armRight = (-1.9 + Math.sin(age * 2.2) * 0.12) * into;
			lean = -0.07 * into;
			speed = IDLE_BOB * 0.7;
			break;
		case "stretch": {
			const reach = ease(age / 0.8) * (1 - ease((age - 1.6) / 0.5));
			out.armLeft = -2.9 * reach;
			out.armRight = -2.9 * reach;
			lean = -0.1 * reach;
			out.scale.set(1 - reach * 0.03, 1 + reach * 0.06, 1 - reach * 0.03);
			lift = 0.01;
			break;
		}
		case "chat":
			// Small gestures and nods while talking.
			out.armRight = -0.55 + Math.sin(time * 3.1 + phase) * 0.3;
			out.armLeft = -0.15 + Math.sin(time * 2.3 + phase) * 0.12;
			lean = Math.max(0, Math.sin(time * 4.2 + phase)) * 0.06;
			speed = IDLE_BOB * 0.8;
			break;
		default:
			break;
	}
	if (carrying) {
		out.armLeft = CARRY_ARMS;
		if (frame.action !== "wave") {
			out.armRight = CARRY_ARMS;
		}
	}
	const wave = Math.sin(time * speed + phase);
	out.position.y += Math.max(0, wave) * lift + hop;
	out.rotation.set(lean, yaw, sway);
	const stretch = 1 + wave * 0.035;
	const squash = 1 / Math.sqrt(stretch);
	out.scale.set(
		out.scale.x * squash,
		out.scale.y * stretch,
		out.scale.z * squash
	);
}

const ITEM_INK = 0.014;

/** One carried item's meshes, centred on its base (also a tray or notice prop). */
export function ItemShape({ item }: { item: LifeItem }) {
	switch (item.shape) {
		case "basket": {
			const color = item.color ?? LIFE_ART.basket;
			const accent = item.accent ?? LIFE_ART.basketAccent;
			return (
				<group>
					<ToonMesh color={color} ink={ITEM_INK}>
						<cylinderGeometry args={[0.17, 0.12, 0.15, 14]} />
					</ToonMesh>
					{[-0.07, 0.03, 0.08].map((x, index) => (
						<ToonMesh
							color={accent}
							key={x}
							position={[x, 0.09, (index - 1) * 0.05]}
						>
							<sphereGeometry args={[0.06, 10, 8]} />
						</ToonMesh>
					))}
				</group>
			);
		}
		case "plate":
		case "bowl": {
			const plate = item.shape === "plate";
			const color = item.color ?? (plate ? LIFE_ART.plate : LIFE_ART.bowl);
			const accent =
				item.accent ?? (plate ? LIFE_ART.plateAccent : LIFE_ART.bowlAccent);
			return (
				<group>
					<ToonMesh color={color} ink={ITEM_INK}>
						{plate ? (
							<cylinderGeometry args={[0.2, 0.16, 0.035, 18]} />
						) : (
							<cylinderGeometry args={[0.15, 0.09, 0.12, 16]} />
						)}
					</ToonMesh>
					<ToonMesh
						color={accent}
						position={[0, plate ? 0.05 : 0.07, 0]}
						scale={[1, 0.55, 1]}
					>
						<sphereGeometry args={[plate ? 0.1 : 0.11, 12, 8]} />
					</ToonMesh>
				</group>
			);
		}
		case "laptop":
			return (
				<group>
					<ToonMesh color={item.color ?? LIFE_ART.laptop} ink={ITEM_INK}>
						<boxGeometry args={[0.32, 0.03, 0.22]} />
					</ToonMesh>
					<ToonMesh
						color={item.accent ?? LIFE_ART.laptopAccent}
						ink={ITEM_INK}
						position={[0, 0.1, -0.11]}
						rotation={[-0.35, 0, 0]}
					>
						<boxGeometry args={[0.32, 0.21, 0.02]} />
					</ToonMesh>
				</group>
			);
		case "letter":
			return (
				<group rotation={[-1.1, 0, 0]}>
					<ToonMesh color={item.color ?? LIFE_ART.letter} ink={ITEM_INK}>
						<boxGeometry args={[0.26, 0.17, 0.02]} />
					</ToonMesh>
					<ToonMesh
						color={item.accent ?? LIFE_ART.letterAccent}
						position={[0, 0, 0.015]}
						rotation={[Math.PI / 2, 0, 0]}
					>
						<cylinderGeometry args={[0.03, 0.03, 0.01, 10]} />
					</ToonMesh>
				</group>
			);
		case "scroll":
			return (
				<group rotation={[0, 0, Math.PI / 2]}>
					<ToonMesh color={item.color ?? LIFE_ART.letter} ink={ITEM_INK}>
						<cylinderGeometry args={[0.05, 0.05, 0.28, 12]} />
					</ToonMesh>
					{[-0.15, 0.15].map((y) => (
						<ToonMesh
							color={item.accent ?? LIFE_ART.bagAccent}
							key={y}
							position={[0, y, 0]}
						>
							<cylinderGeometry args={[0.025, 0.025, 0.04, 8]} />
						</ToonMesh>
					))}
				</group>
			);
		case "tablet":
			return (
				<group rotation={[-0.9, 0, 0]}>
					<ToonMesh color={item.color ?? LIFE_ART.laptopAccent} ink={ITEM_INK}>
						<boxGeometry args={[0.26, 0.2, 0.02]} />
					</ToonMesh>
					<ToonMesh
						color={item.accent ?? ACT_ART.tabletScreen}
						position={[0, 0, 0.012]}
					>
						<boxGeometry args={[0.22, 0.16, 0.004]} />
					</ToonMesh>
				</group>
			);
		case "bag":
			return (
				<group>
					<ToonMesh color={item.color ?? LIFE_ART.bag} ink={ITEM_INK}>
						<boxGeometry args={[0.24, 0.26, 0.15]} />
					</ToonMesh>
					<ToonMesh
						color={item.accent ?? LIFE_ART.bagAccent}
						position={[0, 0.15, 0]}
						rotation={[0, 0, Math.PI / 2]}
					>
						<torusGeometry args={[0.06, 0.012, 6, 12, Math.PI]} />
					</ToonMesh>
				</group>
			);
		default:
			return (
				<group>
					<ToonMesh color={item.color ?? LIFE_ART.box} ink={ITEM_INK}>
						<boxGeometry args={[0.3, 0.22, 0.24]} />
					</ToonMesh>
					<ToonMesh
						color={item.accent ?? LIFE_ART.boxAccent}
						position={[0, 0.112, 0]}
					>
						<boxGeometry args={[0.07, 0.006, 0.245]} />
					</ToonMesh>
				</group>
			);
	}
}

/** The item a villager carries, held in front of its chest as it moves. */
export function CarriedItem({
	body,
	item,
}: {
	body: LifeBody;
	item: LifeItem;
}) {
	const root = useRef<Group>(null);
	useFrame(() => {
		const group = root.current;
		if (!group) {
			return;
		}
		group.position.set(body.x, body.y, body.z);
		group.rotation.set(0, body.yaw, 0);
		group.scale.setScalar(body.scale);
	});
	return (
		<group ref={root}>
			<group position={[0, CARRY_Y, CARRY_Z]}>
				<ItemShape item={item} />
			</group>
		</group>
	);
}

const EFFECT_BITS = 6;

const EFFECT_COLOR: Record<LifeEffect, string> = {
	puff: LIFE_ART.puff,
	smoke: LIFE_ART.smoke,
	sparkle: LIFE_ART.sparkle,
};

/** Where bit `bit` of an effect is, `age` seconds in, and how big. */
function effectBit(
	effect: LifeEffect,
	bit: number,
	age: number,
	out: { s: number; x: number; y: number; z: number }
) {
	const t = age / LIFE_EFFECT_SECONDS;
	const angle = (bit / EFFECT_BITS) * Math.PI * 2 + bit * 0.4;
	switch (effect) {
		case "sparkle": {
			const radius = 0.3 + t * 0.55;
			out.x = Math.cos(angle) * radius;
			out.z = Math.sin(angle) * radius;
			out.y = 1.05 + t * 0.7 + Math.sin(bit * 1.7) * 0.15;
			out.s = 0.07 * (1 - t) * (0.7 + (bit % 2) * 0.5);
			break;
		}
		case "smoke": {
			out.x = Math.sin(bit * 2.1 + t * 2) * 0.18;
			out.z = Math.cos(bit * 1.3) * 0.12;
			out.y = 1.15 + ((bit / EFFECT_BITS + t) % 1) * 0.9;
			out.s = 0.07 + t * 0.12;
			break;
		}
		default: {
			const radius = 0.2 + t * 0.6;
			out.x = Math.cos(angle) * radius;
			out.z = Math.sin(angle) * radius;
			out.y = 0.06 + t * 0.12;
			out.s = 0.08 * (1 - t);
			break;
		}
	}
}

/**
 * Every scripted villager's effect bursts as one instanced mesh: sparkles
 * flying off a celebration, smoke rising over a failure, dust at a stumble.
 */
export function LifeEffects({
	count,
	runtimes,
}: {
	count: number;
	runtimes: RefObject<(LifeRuntime | null)[]>;
}) {
	const ref = useRef<InstancedMesh>(null);
	const bit = useRef({ s: 0, x: 0, y: 0, z: 0 });
	const slots = Math.max(1, count * EFFECT_BITS);
	useLayoutEffect(() => {
		const mesh = ref.current;
		if (!mesh) {
			return;
		}
		const { color, matrix } = mathKit(mesh);
		matrix.makeScale(0, 0, 0);
		for (let slot = 0; slot < slots; slot++) {
			mesh.setMatrixAt(slot, matrix);
			if (color) {
				mesh.setColorAt(slot, color.set(LIFE_ART.sparkle));
			}
		}
		mesh.instanceMatrix.needsUpdate = true;
	}, [slots]);
	useFrame(() => {
		const mesh = ref.current;
		if (!mesh) {
			return;
		}
		const { color, matrix } = mathKit(mesh);
		const out = bit.current;
		let colored = false;
		for (let index = 0; index < count; index++) {
			const runtime = runtimes.current?.[index] ?? null;
			const effect = runtime?.frame.effect ?? null;
			for (let part = 0; part < EFFECT_BITS; part++) {
				const slot = index * EFFECT_BITS + part;
				if (!(runtime && effect)) {
					matrix.makeScale(0, 0, 0);
					mesh.setMatrixAt(slot, matrix);
					continue;
				}
				effectBit(effect, part, runtime.frame.effectAge, out);
				const size = out.s * runtime.body.scale;
				matrix.makeScale(size, size, size);
				matrix.setPosition(
					runtime.body.x + out.x,
					runtime.body.y + out.y * runtime.body.scale,
					runtime.body.z + out.z
				);
				mesh.setMatrixAt(slot, matrix);
				if (color) {
					mesh.setColorAt(slot, color.set(EFFECT_COLOR[effect]));
					colored = true;
				}
			}
		}
		mesh.instanceMatrix.needsUpdate = true;
		if (colored && mesh.instanceColor) {
			mesh.instanceColor.needsUpdate = true;
		}
	});
	return (
		<instancedMesh args={[undefined, undefined, slots]} key={slots} ref={ref}>
			<sphereGeometry args={[1, 8, 6]} />
			<CurvedBasicMaterial toneMapped={false} />
		</instancedMesh>
	);
}

const BUBBLE_TONE: Record<NonNullable<LifeBubble["tone"]>, string> = {
	ask: "bg-(--gk-gold) text-(--gk-edge)",
	bad: "bg-(--gk-bad) text-white",
	good: "bg-(--gk-good) text-white",
	plain: "",
	warn: "bg-(--gk-warn) text-(--gk-edge)",
};

/** A bubble's words, at most five. */
export function bubbleWords(bubble: LifeBubble): string {
	return (bubble.label ?? "").trim().split(/\s+/).slice(0, 5).join(" ");
}

function BubbleIcon({ icon }: { icon: NonNullable<LifeBubble["icon"]> }) {
	const size = "size-3.5";
	switch (icon) {
		case "check":
			return <Check aria-hidden="true" className={size} strokeWidth={3} />;
		case "cross":
			return <X aria-hidden="true" className={size} strokeWidth={3} />;
		case "heart":
			return <Heart aria-hidden="true" className={size} strokeWidth={2.5} />;
		case "note":
			return <Music aria-hidden="true" className={size} strokeWidth={2.5} />;
		case "alert":
			return (
				<span aria-hidden="true" className="font-bold text-[13px] leading-none">
					!
				</span>
			);
		default:
			return <Ellipsis aria-hidden="true" className={size} strokeWidth={3} />;
	}
}

/**
 * A villager's speech bubble: a small kit plate with a tail, up and to the
 * right of its name plate (clear of the state badge). Its words also join
 * the name plate's accessible name, so the bubble itself is hidden from
 * assistive tech.
 */
export function LifeBubbleTag({
	bubble,
	side = "auto",
}: {
	bubble: LifeBubble;
	/** Where it hangs (`auto`: the stage picks a side clear of other plates). */
	side?: LifeBubbleSide;
}) {
	const words = bubbleWords(bubble);
	return (
		<span
			aria-hidden="true"
			className={cn(
				GAME_PLATE,
				"group/bubble pointer-events-none absolute flex h-6 items-center gap-1 whitespace-nowrap rounded-xl px-2 font-semibold text-[12px] leading-none",
				// Up-right and up-left clear the plate's state badge; straight up
				// clears it from above.
				"data-[side=left]:right-[calc(50%+16px)] data-[side=left]:bottom-[calc(100%+6px)] data-[side=right]:bottom-[calc(100%+6px)] data-[side=up]:bottom-[calc(100%+24px)] data-[side=right]:left-[calc(50%+16px)] data-[side=up]:left-1/2 data-[side=up]:-translate-x-1/2",
				BUBBLE_TONE[bubble.tone ?? "plain"],
				bubble.partial && "border-dashed"
			)}
			data-bubble-auto={side === "auto" ? "" : undefined}
			data-budgeted-overlay="bubble"
			data-life-bubble=""
			data-side={side === "auto" ? "right" : side}
		>
			{bubble.icon ? <BubbleIcon icon={bubble.icon} /> : null}
			{words ? <span className="max-w-32 truncate">{words}</span> : null}
			<span
				className={cn(
					"absolute -bottom-1 left-2 size-2 rotate-45 border-(--gk-edge) border-r-2 border-b-2 group-data-[side=left]/bubble:right-2 group-data-[side=left]/bubble:left-auto group-data-[side=up]/bubble:left-[calc(50%-4px)]",
					bubble.tone && bubble.tone !== "plain"
						? BUBBLE_TONE[bubble.tone]
						: "bg-(--gk-plate)"
				)}
			/>
		</span>
	);
}
