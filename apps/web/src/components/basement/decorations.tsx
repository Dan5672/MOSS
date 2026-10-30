// Holiday decorations for the Basement (holidays.ts says when): bunting under the lights, a sign, and props on the
// wall and floor, on the 1280×720 stage. Emoji for the small things, boxes for the big ones. Decoration only.
import type { CSSProperties, ReactNode } from "react";
import type { Holiday } from "./holidays";

const PIXEL = "var(--font-press-start), monospace";
const INK = "#14110f";

const box = (x: number, y: number, w: number, h: number, style: CSSProperties = {}): CSSProperties => ({ position: "absolute", left: x, top: y, width: w, height: h, boxSizing: "border-box", ...style });

function Emoji({ x, y, size = 40, z = 2, children }: { x: number; y: number; size?: number; z?: number; children: string }) {
  return <span style={{ position: "absolute", left: x, top: y, fontSize: size, lineHeight: 1, zIndex: z }}>{children}</span>;
}

/** Triangle flags on a string, under the ceiling lights. */
function Bunting({ colours }: { colours: string[] }) {
  return (
    <div style={box(330, 80, 940, 26, { display: "flex", justifyContent: "space-between", borderTop: `3px solid ${INK}`, zIndex: 2 })}>
      {Array.from({ length: 24 }, (_, i) => (
        <span key={i} style={{ width: 0, height: 0, borderLeft: "11px solid transparent", borderRight: "11px solid transparent", borderTop: `22px solid ${colours[i % colours.length]}` }} />
      ))}
    </div>
  );
}

function Sign({ text, colour, background }: { text: string; colour: string; background: string }) {
  return (
    <div style={box(960, 116, 200, 62, { background, border: `4px solid ${INK}`, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 6, fontFamily: PIXEL, fontSize: 10, lineHeight: 1.5, color: colour, zIndex: 2 })}>
      {text}
    </div>
  );
}

function Tree() {
  const tier = (w: number, top: number) => <span style={box(1225 - w / 2, top, 0, 0, { borderLeft: `${w / 2}px solid transparent`, borderRight: `${w / 2}px solid transparent`, borderBottom: `${w * 0.7}px solid #1f7a3a` })} />;
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 2 }}>
      {tier(60, 150)}
      {tier(76, 180)}
      {tier(92, 212)}
      <span style={box(1215, 276, 20, 22, { background: "#6b4a2e", border: `2px solid ${INK}` })} />
      <span style={box(1218, 134, 14, 14, { background: "#ffd23f", transform: "rotate(45deg)" })} />
      {[
        [1212, 196, "#e0483e"],
        [1236, 226, "#ffd23f"],
        [1204, 246, "#3a5bd9"],
        [1240, 258, "#e0483e"],
      ].map(([x, y, c]) => (
        <span key={`${x}-${y}`} className="b1-led" style={box(x as number, y as number, 8, 8, { background: c as string, borderRadius: "50%" })} />
      ))}
    </div>
  );
}

function Presents() {
  return (
    <>
      {[
        [968, 600, 40, 34, "#e0483e", "#ffd23f"],
        [1004, 612, 30, 24, "#3a5bd9", "#f5f1e6"],
        [990, 576, 26, 24, "#1f7a3a", "#e0483e"],
      ].map(([x, y, w, h, c, ribbon]) => (
        <span key={`${x}`} style={box(x as number, y as number, w as number, h as number, { background: c as string, border: `3px solid ${INK}`, zIndex: 6, backgroundImage: `linear-gradient(90deg, transparent 42%, ${ribbon} 42%, ${ribbon} 58%, transparent 58%)` })} />
      ))}
    </>
  );
}

function AussieFlag() {
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 2 }}>
      <span style={box(1196, 120, 5, 190, { background: "#8e958f" })} />
      <div style={box(1201, 124, 72, 44, { background: "#012169", border: `2px solid ${INK}` })}>
        {/* The Union Jack corner, simplified, and the Southern Cross. */}
        <span style={box(0, 0, 34, 20, { background: "#012169", backgroundImage: "linear-gradient(#fff 0 0), linear-gradient(#fff 0 0)", backgroundSize: "100% 6px, 6px 100%", backgroundPosition: "center", backgroundRepeat: "no-repeat" })} />
        <span style={box(0, 0, 34, 20, { backgroundImage: "linear-gradient(#c8102e 0 0), linear-gradient(#c8102e 0 0)", backgroundSize: "100% 2px, 2px 100%", backgroundPosition: "center", backgroundRepeat: "no-repeat" })} />
        {[
          [10, 28, 6],
          [52, 8, 5],
          [60, 22, 5],
          [46, 30, 5],
          [54, 34, 3],
        ].map(([x, y, s]) => (
          <span key={`${x}-${y}`} style={box(x!, y!, s!, s!, { background: "#fff", transform: "rotate(45deg)" })} />
        ))}
      </div>
    </div>
  );
}

function Bbq() {
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 6 }}>
      <span style={box(966, 590, 80, 22, { background: "#2b2b2b", border: `3px solid ${INK}`, borderRadius: "0 0 30px 30px" })} />
      <span style={box(972, 584, 68, 6, { background: "#8e958f", border: `2px solid ${INK}` })} />
      <span style={box(976, 612, 4, 40, { background: INK })} />
      <span style={box(1032, 612, 4, 40, { background: INK })} />
      {[982, 998, 1014].map((x) => (
        <span key={x} style={box(x, 576, 14, 8, { background: "#a3542e", border: `2px solid ${INK}`, borderRadius: 4 })} />
      ))}
      <span style={box(994, 554, 8, 8, { background: "rgba(230,220,192,.5)", animation: "b1-steam 1.8s linear infinite" })} />
      <span style={box(1010, 560, 8, 8, { background: "rgba(230,220,192,.4)", animation: "b1-steam 1.8s linear infinite .8s" })} />
    </div>
  );
}

function Lightsabers() {
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 2 }}>
      {[
        [1206, "#ff3b3b", -12],
        [1236, "#3bc3ff", 12],
      ].map(([x, c, rot]) => (
        <div key={x} style={box(x as number, 130, 10, 170, { transform: `rotate(${rot}deg)`, transformOrigin: "bottom center" })}>
          <span className="b1-led" style={box(1, 0, 8, 130, { background: "#fff", boxShadow: `0 0 10px 4px ${c}`, borderRadius: 4 })} />
          <span style={box(0, 130, 10, 40, { background: "#8e958f", border: `2px solid ${INK}` })} />
        </div>
      ))}
    </div>
  );
}

function Lederhosen() {
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 2 }}>
      <span style={box(1196, 126, 66, 4, { background: "#6b4a2e" })} />
      <span style={box(1204, 130, 8, 50, { background: "#4a3220", transform: "rotate(-8deg)" })} />
      <span style={box(1246, 130, 8, 50, { background: "#4a3220", transform: "rotate(8deg)" })} />
      <span style={box(1206, 154, 46, 10, { background: "#4a3220" })} />
      <span style={box(1200, 176, 58, 30, { background: "#7a5230", border: `3px solid ${INK}` })} />
      <span style={box(1200, 204, 26, 30, { background: "#7a5230", border: `3px solid ${INK}` })} />
      <span style={box(1232, 204, 26, 30, { background: "#7a5230", border: `3px solid ${INK}` })} />
    </div>
  );
}

function Eggs() {
  return (
    <>
      {[
        [972, 626, "#ffb3d9", "#fff2a8"],
        [998, 634, "#a8e6ff", "#c9a8ff"],
        [1022, 622, "#b8f2b0", "#ffb3d9"],
        [300, 556, "#fff2a8", "#a8e6ff"],
      ].map(([x, y, a, b]) => (
        <span key={`${x}`} style={box(x as number, y as number, 20, 26, { background: `repeating-linear-gradient(0deg, ${a} 0 6px, ${b} 6px 12px)`, border: `2px solid ${INK}`, borderRadius: "50% 50% 50% 50% / 60% 60% 40% 40%", zIndex: 6 })} />
      ))}
    </>
  );
}

interface Theme {
  bunting: string[];
  sign: { text: string; colour: string; background: string };
  props: ReactNode;
}

const THEMES: Record<Holiday, Theme> = {
  christmas: {
    bunting: ["#e0483e", "#1f7a3a", "#f5f1e6"],
    sign: { text: "MERRY CHRISTMAS", colour: "#f5f1e6", background: "#b03a2e" },
    props: (
      <>
        <Tree />
        <Presents />
        <Emoji x={300} y={540} size={36} z={6}>⛄</Emoji>
      </>
    ),
  },
  halloween: {
    bunting: ["#ff7a1a", "#14110f", "#7a3ab0"],
    sign: { text: "HAPPY HALLOWEEN", colour: "#ff7a1a", background: "#1d1640" },
    props: (
      <>
        <Emoji x={1196} y={120} size={64}>🕸️</Emoji>
        <Emoji x={1210} y={196} size={34}>🦇</Emoji>
        <Emoji x={500} y={110} size={28}>🦇</Emoji>
        <Emoji x={1180} y={240} size={40}>👻</Emoji>
        <Emoji x={970} y={590} size={48} z={6}>🎃</Emoji>
        <Emoji x={296} y={540} size={40} z={6}>🎃</Emoji>
        <Emoji x={1020} y={606} size={30} z={6}>🍬</Emoji>
      </>
    ),
  },
  easter: {
    bunting: ["#ffb3d9", "#fff2a8", "#a8e6ff", "#b8f2b0"],
    sign: { text: "HAPPY EASTER", colour: "#5e1b4a", background: "#fff2a8" },
    props: (
      <>
        <Eggs />
        <Emoji x={1196} y={150} size={56}>🐰</Emoji>
        <Emoji x={1004} y={584} size={40} z={6}>🐇</Emoji>
        <Emoji x={1200} y={230} size={40}>🍫</Emoji>
        <Emoji x={320} y={570} size={30} z={6}>🍫</Emoji>
      </>
    ),
  },
  valentines: {
    bunting: ["#e0483e", "#ff7ad9", "#f5f1e6"],
    sign: { text: "BE MY VALENTINE", colour: "#f5f1e6", background: "#c2185b" },
    props: (
      <>
        <Emoji x={1196} y={124} size={48}>💘</Emoji>
        <Emoji x={1210} y={196} size={40}>💕</Emoji>
        <Emoji x={500} y={110} size={26}>❤️</Emoji>
        <Emoji x={700} y={112} size={22}>💗</Emoji>
        <Emoji x={970} y={586} size={52} z={6}>🌹</Emoji>
        <Emoji x={1020} y={612} size={30} z={6}>💌</Emoji>
        <Emoji x={300} y={548} size={34} z={6}>🍫</Emoji>
      </>
    ),
  },
  st_patricks: {
    bunting: ["#1f7a3a", "#4dff9a", "#f5f1e6", "#ff9a3c"],
    sign: { text: "ST PATRICK'S DAY", colour: "#ffd23f", background: "#1f7a3a" },
    props: (
      <>
        <Emoji x={1192} y={120} size={64}>🌈</Emoji>
        <Emoji x={1206} y={200} size={44}>☘️</Emoji>
        <Emoji x={500} y={112} size={26}>🍀</Emoji>
        <Emoji x={700} y={112} size={26}>☘️</Emoji>
        <Emoji x={970} y={590} size={46} z={6}>💰</Emoji>
        <Emoji x={1018} y={600} size={38} z={6}>🧙</Emoji>
        <Emoji x={300} y={548} size={34} z={6}>🍀</Emoji>
      </>
    ),
  },
  star_wars: {
    bunting: ["#14110f", "#ffd23f", "#3bc3ff"],
    sign: { text: "MAY THE 4TH BE WITH YOU", colour: "#ffd23f", background: "#0b0d0e" },
    props: (
      <>
        <Lightsabers />
        <Emoji x={480} y={108} size={26}>⭐</Emoji>
        <Emoji x={720} y={110} size={30}>🪐</Emoji>
        <Emoji x={600} y={106} size={18}>✨</Emoji>
        <Emoji x={970} y={588} size={46} z={6}>🚀</Emoji>
        <Emoji x={1020} y={604} size={34} z={6}>👽</Emoji>
        <Emoji x={300} y={548} size={34} z={6}>🛸</Emoji>
      </>
    ),
  },
  oktoberfest: {
    bunting: ["#1f6fd0", "#f5f1e6"],
    sign: { text: "O'ZAPFT IS!", colour: "#1f6fd0", background: "#f5f1e6" },
    props: (
      <>
        <Lederhosen />
        <Emoji x={500} y={110} size={26}>🥨</Emoji>
        <Emoji x={720} y={110} size={26}>🥨</Emoji>
        <Emoji x={966} y={586} size={50} z={6}>🍺</Emoji>
        <Emoji x={1016} y={600} size={38} z={6}>🥨</Emoji>
        <Emoji x={300} y={548} size={36} z={6}>🍻</Emoji>
      </>
    ),
  },
  australia_day: {
    bunting: ["#00843d", "#ffcd00"],
    sign: { text: "HAPPY AUSTRALIA DAY", colour: "#ffcd00", background: "#00843d" },
    props: (
      <>
        <AussieFlag />
        <Bbq />
        <Emoji x={1196} y={220} size={44}>🦘</Emoji>
        <Emoji x={300} y={548} size={34} z={6}>🌭</Emoji>
      </>
    ),
  },
};

export const HOLIDAY_NAMES: Record<Holiday, string> = {
  christmas: "Christmas",
  halloween: "Halloween",
  easter: "Easter",
  valentines: "Valentine's Day",
  st_patricks: "St Patrick's Day",
  star_wars: "Star Wars Day",
  oktoberfest: "Oktoberfest",
  australia_day: "Australia Day",
};

export function HolidayDecorations({ holiday }: { holiday: Holiday }) {
  const t = THEMES[holiday];
  return (
    <>
      <Bunting colours={t.bunting} />
      <Sign {...t.sign} />
      {t.props}
    </>
  );
}

/** A Santa hat for an 80px mascot, at Christmas. */
export function HolidayHat({ holiday }: { holiday: Holiday | null }) {
  if (holiday !== "christmas") return null;
  return (
    <span aria-hidden style={{ position: "absolute", left: 22, top: -14, width: 40, height: 30, pointerEvents: "none" }}>
      <span style={box(4, 0, 0, 0, { borderLeft: "16px solid transparent", borderRight: "16px solid transparent", borderBottom: "24px solid #e0483e", transform: "rotate(12deg)" })} />
      <span style={box(0, 20, 40, 9, { background: "#f5f1e6", border: `2px solid ${INK}` })} />
      <span style={box(28, -4, 9, 9, { background: "#f5f1e6", border: `2px solid ${INK}`, borderRadius: "50%" })} />
    </span>
  );
}
