// Registers the meshline JSX intrinsics for desktop's re-check of the Lanyard
// source imported from @ryu/ui. @react-three/fiber augments `react`'s JSX
// namespace (React.JSX.IntrinsicElements extends ThreeElements), so we merge
// into the same place. A permissive prop type is used on purpose: the precise
// types live in @react-three/fiber, which is a transitive dep of @ryu/ui and is
// not resolvable from this app — packages/ui carries the exact typing for its
// own type-check.
declare module "react" {
	namespace JSX {
		interface IntrinsicElements {
			meshLineGeometry: Record<string, unknown>;
			meshLineMaterial: Record<string, unknown>;
		}
	}
}

export {};
