import type { SkyPair } from "@agenteschat/ui/agent/engine";
import { MARK_BUBBLE, MARK_DOTS, MARK_SQUARE } from "@agenteschat/ui/brand/squad-mark";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { useTheme } from "./theme";

const { x, y, size: side, r } = MARK_SQUARE;

/**
 * The squadchat mark, as the web's (`packages/ui` `LogoMark`): the bubble in ink, the people's dots in the ground's
 * color and the agent's square in the theme's `agent` color. A workspace without a logo of its own wears it. `sky`: a
 * given workspace's pair (`workspaceSky`) colors the square in place of the active accent.
 */
export function LogoMark({ size, sky }: { size: number; sky?: SkyPair }) {
  const { colors } = useTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" accessibilityElementsHidden importantForAccessibility="no">
      <Path d={MARK_BUBBLE} fill={colors.ink} />
      {MARK_DOTS.map(([cx, cy, dr]) => (
        <Circle key={cx} cx={cx} cy={cy} r={dr} fill={colors.bg} />
      ))}
      <Rect x={x} y={y} width={side} height={side} rx={r} fill={sky ? sky[1] : colors.agent} />
    </Svg>
  );
}
