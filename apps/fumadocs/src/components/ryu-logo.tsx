"use client";

/*
 * Animated rendering of the Ryu ghost mark — the "outline" variant of the shared
 * `@ryu/ui` Logo (packages/ui/src/components/logo.tsx) at its 24px reference
 * scale, with the eyes that blink on an interval and track the cursor. Kept as a
 * self-contained, dependency-free copy because fumadocs does not depend on
 * `@ryu/ui`. Inherits `currentColor`, matching the landing header.
 */

import { useEffect, useRef, useState } from "react";

// Ghost outline path at scaleFactor = 1 (the component's 24px reference geometry).
const GHOST_PATH =
  "M12,24c9.2,0,12.9-4.8,12.4-14.6C24.1,0.3,12.8-3.7,8.8,5.4c-2.2,5.7,1.1,7.9-2.9,12.6c-0.9,1.1-1.8,2-2.7,3.1c-1.2,1.3,0.7,2.2,1.9,2.2C7.4,23.3,9.7,24,12,24z";

// Eye geometry in the 24-unit viewBox (matches the static reference).
const LEFT_EYE_X = 15;
const RIGHT_EYE_X = 19;
const EYE_Y = 10;
const EYE_RX = 1.5;
const EYE_RY = 3;
// How far (in viewBox units) the pupils drift toward the cursor / when idle.
const MAX_GAZE = 2.2;
const IDLE_DELAY_MS = 3000;

export function RyuLogo({ size = 22 }: { size?: number }) {
  const [isBlinking, setIsBlinking] = useState(false);
  const [gaze, setGaze] = useState({ x: 0, y: 0 });
  const [isIdle, setIsIdle] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Blink on a randomized interval.
  useEffect(() => {
    const interval = setInterval(
      () => {
        setIsBlinking(true);
        setTimeout(() => setIsBlinking(false), 150);
      },
      3000 + Math.random() * 2000
    );
    return () => clearInterval(interval);
  }, []);

  // Track the cursor; fall back to idle after a pause without movement.
  useEffect(() => {
    const resetIdleTimer = () => {
      setIsIdle(false);
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
      }
      idleTimerRef.current = setTimeout(() => setIsIdle(true), IDLE_DELAY_MS);
    };

    const handleMouseMove = (event: MouseEvent) => {
      resetIdleTimer();
      if (!svgRef.current) {
        return;
      }
      const rect = svgRef.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const angle = Math.atan2(event.clientY - centerY, event.clientX - centerX);
      setGaze({
        x: Math.cos(angle) * MAX_GAZE,
        y: Math.sin(angle) * MAX_GAZE,
      });
    };

    resetIdleTimer();
    window.addEventListener("mousemove", handleMouseMove);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
      }
    };
  }, []);

  // While idle, let the gaze wander to keep the mark feeling alive.
  useEffect(() => {
    if (!isIdle) {
      return;
    }
    const wander = () => {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.random() * MAX_GAZE;
      setGaze({
        x: Math.cos(angle) * distance,
        y: Math.sin(angle) * distance,
      });
    };
    wander();
    const interval = setInterval(wander, 2000 + Math.random() * 2000);
    return () => clearInterval(interval);
  }, [isIdle]);

  return (
    <svg
      aria-hidden="true"
      height={size}
      overflow="visible"
      ref={svgRef}
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
      {isBlinking ? (
        <>
          <line
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            x1={LEFT_EYE_X - EYE_RX}
            x2={LEFT_EYE_X + EYE_RX}
            y1={EYE_Y}
            y2={EYE_Y}
          />
          <line
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            x1={RIGHT_EYE_X - EYE_RX}
            x2={RIGHT_EYE_X + EYE_RX}
            y1={EYE_Y}
            y2={EYE_Y}
          />
        </>
      ) : (
        <>
          <ellipse
            cx={LEFT_EYE_X + gaze.x}
            cy={EYE_Y + gaze.y}
            fill="currentColor"
            rx={EYE_RX}
            ry={EYE_RY}
          />
          <ellipse
            cx={RIGHT_EYE_X + gaze.x}
            cy={EYE_Y + gaze.y}
            fill="currentColor"
            rx={EYE_RX}
            ry={EYE_RY}
          />
        </>
      )}
    </svg>
  );
}
