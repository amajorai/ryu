// Registers the `meshLineGeometry` / `meshLineMaterial` JSX intrinsics. They are
// added at runtime via `extend({ MeshLineGeometry, MeshLineMaterial })` in
// Lanyard.tsx. Under React 19 + @react-three/fiber v9 the JSX catalogue is the
// `ThreeElements` interface (which R3F merges into `JSX.IntrinsicElements`), NOT
// the legacy global `JSX` namespace.
//
// Asset-module (`*.glb` / `*.png`) declarations live in lanyard-assets.d.ts —
// they must be in a script file, not this module file.
import type { ThreeElement } from "@react-three/fiber";
import type { MeshLineGeometry, MeshLineMaterial } from "meshline";

declare module "@react-three/fiber" {
	interface ThreeElements {
		meshLineGeometry: ThreeElement<typeof MeshLineGeometry>;
		meshLineMaterial: ThreeElement<typeof MeshLineMaterial>;
	}
}
