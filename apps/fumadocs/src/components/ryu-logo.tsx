/*
 * Static rendering of the Ryu ghost mark — the "outline" variant of the shared
 * `@ryu/ui` Logo (packages/ui/src/components/logo.tsx) at its 24px reference
 * scale, with the eye/blink animation stripped out so it is server-safe and
 * dependency-free. Inherits `currentColor`, matching the landing header.
 */

// Ghost outline path at scaleFactor = 1 (the component's 24px reference geometry).
const GHOST_PATH =
  "M12,24c9.2,0,12.9-4.8,12.4-14.6C24.1,0.3,12.8-3.7,8.8,5.4c-2.2,5.7,1.1,7.9-2.9,12.6c-0.9,1.1-1.8,2-2.7,3.1c-1.2,1.3,0.7,2.2,1.9,2.2C7.4,23.3,9.7,24,12,24z";

export function RyuLogo({ size = 22 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      height={size}
      overflow="visible"
      viewBox="0 0 24 24"
      width={size}
    >
      <path
        d={GHOST_PATH}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
      <ellipse cx="15" cy="10" fill="currentColor" rx="1.5" ry="3" />
      <ellipse cx="19" cy="10" fill="currentColor" rx="1.5" ry="3" />
    </svg>
  );
}
