import { useEffect, useState } from "react";
import type { NotchGeometry } from "../../shared/notch.ts";
export function useNotch(): NotchGeometry | null | undefined {
	const [notch, setNotch] = useState<NotchGeometry | null>();
	useEffect(() => {
		let cancelled = false;
		void window.island.appearance.notch().then((value) => {
			if (!cancelled) {
				setNotch(value);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);
	return notch;
}
