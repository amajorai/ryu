import {
	Color,
	Shape as ContourPath,
	ExtrudeGeometry,
	Group,
	InstancedMesh,
	Mesh,
	MeshPhysicalMaterial,
	Object3D,
	SphereGeometry,
} from "three";
import type { ExpressiveAnimationDecoration } from "./expressive-animation.ts";

/** Reusable volumes for the shared animation timeline's dots, rings and marks. */
export function createGhostDecorations(
	particleColors = [
		new Color("#c28cff"),
		new Color("#7e8cff"),
		new Color("#5dc5ee"),
	]
) {
	const group = new Group();
	const sphere = new SphereGeometry(1, 16, 12);
	const transform = new Object3D();
	const triangle = new ContourPath();
	triangle.moveTo(-1.6, 2.1);
	triangle.lineTo(2.1, 0);
	triangle.lineTo(-1.6, -2.1);
	triangle.closePath();
	const play = new ExtrudeGeometry(triangle, {
		depth: 0.25,
		bevelEnabled: true,
		bevelSize: 0.08,
		bevelThickness: 0.08,
		bevelSegments: 2,
		steps: 1,
	});
	const entries: {
		root: Group;
		material: MeshPhysicalMaterial;
		kind: string;
	}[] = [];
	const make = (kind: ExpressiveAnimationDecoration["kind"]) => {
		const root = new Group();
		const material = new MeshPhysicalMaterial({
			color: "#6f7f98",
			roughness: 0.3,
			clearcoat: 0.7,
			transparent: true,
			depthWrite: false,
		});
		if (kind === "ring" || kind === "ray" || kind === "comet") {
			const particles = new InstancedMesh(sphere, material, 20);
			particles.frustumCulled = false;
			root.add(particles);
		} else {
			root.add(new Mesh(kind === "play" ? play : sphere, material));
			if (kind === "exclamation") {
				root.add(new Mesh(sphere, material));
			}
		}
		group.add(root);
		return { root, material, kind };
	};
	const update = (decorations: readonly ExpressiveAnimationDecoration[]) => {
		for (const entry of entries) {
			entry.root.visible = false;
		}
		for (const [index, decoration] of decorations.entries()) {
			let entry = entries[index];
			if (!entry || entry.kind !== decoration.kind) {
				if (entry) {
					entry.root.traverse((child) => {
						if (child instanceof InstancedMesh) {
							child.dispose();
						}
					});
					group.remove(entry.root);
					entry.material.dispose();
				}
				entry = make(decoration.kind);
				entries[index] = entry;
			}
			const { root, material } = entry;
			root.visible = decoration.opacity > 0.001;
			root.position.set(0, 0, 8);
			root.rotation.set(0, 0, 0);
			root.scale.set(1, 1, 1);
			material.opacity = decoration.opacity;
			const color =
				"color" in decoration ? (decoration.color ?? "#6f7f98") : "#6f7f98";
			material.color.setStyle(
				color.replace(/hsl\((\d+) (\d+)% (\d+)%\)/, "hsl($1,$2%,$3%)")
			);
			const first = root.children[0];
			const second = root.children[1];
			if (!first) {
				continue;
			}
			switch (decoration.kind) {
				case "dot":
				case "badge":
					root.position.set(decoration.x - 14, 12 - decoration.y, 8);
					first.scale.setScalar(decoration.r);
					break;
				case "ring":
				case "ray":
				case "comet": {
					if (!(first instanceof InstancedMesh)) {
						break;
					}
					material.color.copy(
						particleColors[index % particleColors.length] ??
							new Color("#7e8cff")
					);
					const count = decoration.kind === "ray" ? 4 : 20;
					first.count = count;
					root.position.set(0, 0, 0);
					root.rotation.set(0, 0, 0, "ZXY");
					if (decoration.kind === "ring") {
						root.rotation.set(
							0.55 + (index % 3) * 0.18,
							0,
							(index * Math.PI) / 3,
							"ZXY"
						);
					}
					if (decoration.kind === "comet") {
						root.rotation.x = 0.5;
					}
					for (let part = 0; part < count; part += 1) {
						const fade = 1 - part / count;
						if (decoration.kind === "ray") {
							const spread = Math.hypot(
								decoration.x2 - 12,
								decoration.y2 - 11.8
							);
							const angle = index * 2.399_963 + part * 0.52;
							const radius =
								spread * (0.55 + ((index * 7 + part * 3) % 11) / 14);
							transform.position.set(
								Math.cos(angle) * radius,
								Math.sin(angle) * radius,
								Math.sin(index * 2.4 + part) * 2.5
							);
							transform.scale.setScalar(0.2 + ((index + part * 3) % 5) * 0.065);
						} else {
							const angle =
								(-decoration.rotate * Math.PI) / 180 -
								part * 0.045 +
								(decoration.kind === "comet" ? (index * Math.PI) / 2 : 0);
							const radius =
								decoration.kind === "ring" ? 10.8 : 7.5 + index * 0.2;
							transform.position.set(
								radius * Math.cos(angle),
								radius * Math.sin(angle) * 0.86,
								0
							);
							transform.scale.setScalar(
								(decoration.kind === "ring" ? 0.38 : 0.5) * fade * fade + 0.035
							);
						}
						transform.updateMatrix();
						first.setMatrixAt(part, transform.matrix);
					}
					first.instanceMatrix.needsUpdate = true;
					break;
				}
				case "exclamation":
					root.position.set(decoration.x - 14, 12 - decoration.y, 8);
					root.rotation.z = (-decoration.rotate * Math.PI) / 180;
					root.scale.setScalar(decoration.scale);
					first.position.y = 0.75;
					first.scale.set(0.42, 1.85, 0.42);
					if (second) {
						second.position.y = -2.2;
						second.scale.setScalar(0.52);
					}
					break;
				case "play":
					root.position.set(decoration.x - 14, 12 - decoration.y, 8);
					root.rotation.z = (-decoration.rotate * Math.PI) / 180;
					root.scale.setScalar(decoration.scale);
					break;
			}
		}
	};
	const dispose = () => {
		sphere.dispose();

		play.dispose();
		for (const entry of entries) {
			entry.root.traverse((child) => {
				if (child instanceof InstancedMesh) {
					child.dispose();
				}
			});
			entry.material.dispose();
		}
	};
	return { group, update, dispose };
}
