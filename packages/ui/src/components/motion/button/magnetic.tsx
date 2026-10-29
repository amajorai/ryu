"use client";

import { forwardRef } from "react";
import { Magnetic } from "../magnetic.tsx";
import { Button, type ButtonProps } from "./base.tsx";

export interface MagneticButtonProps extends ButtonProps {
	/** Class applied to the magnetic wrapper. */
	magneticClassName?: string;
	/** Magnetic pull strength. Default 0.25. */
	strength?: number;
}

export const MagneticButton = forwardRef<
	HTMLButtonElement,
	MagneticButtonProps
>(function MagneticButton(
	{ strength = 0.25, magneticClassName, children, ...rest },
	ref
) {
	return (
		<Magnetic className={magneticClassName} strength={strength}>
			<Button ref={ref} {...rest}>
				{children}
			</Button>
		</Magnetic>
	);
});
