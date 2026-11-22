import { type ReactNode, useEffect, useState } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { useReducedMotion } from "@/ui";
import { useRevealed } from "../launch/launched";

/** Strong ease-out: the entrance starts fast, where the eye is, and settles slowly. */
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

/** Once per launch: the first Conversas after the splash arrives; every other visit is just there. */
let played = false;

/**
 * Whether Conversas plays its arrival: the first time it is in view after launch (the splash's window opening on it,
 * `useRevealed`, so it arrives as the window grows), once per launch, never again while the app runs (coming back
 * to the tab, a pull, a new day all show it still). Until then the parts wait hidden under the splash, so nothing
 * is seen twice.
 */
export function useHomeEntrance(): { armed: boolean; play: boolean } {
  const inView = useRevealed();
  const [armed] = useState(() => !played);
  useEffect(() => {
    if (armed && inView) played = true;
  }, [armed, inView]);
  return { armed, play: armed && inView };
}

/**
 * One part of the arrival: from `rise` points below and clear, to its place, starting `delay` after the splash left
 * (fades only, no travel, with reduced motion). Touches go through from the first frame: the arrival never holds a
 * tap back. Unarmed, the part is simply there.
 */
export function Arrive({
  armed,
  play,
  delay = 0,
  rise = 8,
  duration = 480,
  style,
  children,
}: {
  armed: boolean;
  play: boolean;
  delay?: number;
  rise?: number;
  duration?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const shown = useSharedValue(armed ? 0 : 1);
  useEffect(() => {
    if (!play) return;
    shown.set(withDelay(reduced ? 0 : delay, withTiming(1, { duration: reduced ? 200 : duration, easing: EASE_OUT })));
  }, [play, delay, duration, reduced, shown]);
  const look = useAnimatedStyle(() => ({
    opacity: shown.get(),
    transform: [{ translateY: reduced ? 0 : (1 - shown.get()) * rise }],
  }));
  return <Animated.View style={[style, look]}>{children}</Animated.View>;
}

/**
 * The right hand waking as the app opens: asleep under the splash, it opens its eyes `delay` after it left, the one
 * living thing that greets you; it stays where it is (a hop on a spring there made the home bounce as it opened).
 * Unarmed, it is just awake.
 */
export function useWake(armed: boolean, play: boolean, delay = 300) {
  const [awake, setAwake] = useState(!armed);
  useEffect(() => {
    if (!play || awake) return;
    const timer = setTimeout(() => setAwake(true), delay);
    return () => clearTimeout(timer);
  }, [play, awake, delay]);
  return { mode: awake ? ("idle" as const) : ("sleep" as const) };
}
