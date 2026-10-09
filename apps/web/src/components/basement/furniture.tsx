// The Basement's static furniture: everything in the room except the people and their desks. One server
// component, positioned on the 1280×720 stage. Positions and colours follow the basement mockup.
import type { CSSProperties, ReactNode } from "react";
import { ledColours } from "./layout";

const MONO = "var(--font-plex-mono), monospace";
const PIXEL = "var(--font-press-start), monospace";

/** An absolutely positioned box on the stage. */
function At({ x, y, w, h, style, className, children }: { x: number; y: number; w?: number; h?: number; style?: CSSProperties; className?: string; children?: ReactNode }) {
  return (
    <div className={className} style={{ position: "absolute", left: x, top: y, width: w, height: h, boxSizing: "border-box", ...style }}>
      {children}
    </div>
  );
}

const anim = (animation: string, extra: CSSProperties = {}): CSSProperties => ({ animation, ...extra });
const label = (fontSize: number, extra: CSSProperties = {}): CSSProperties => ({ fontFamily: MONO, fontSize, color: "#14110f", ...extra });
const centred: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center" };

function Racks({ alarm }: { alarm: boolean }) {
  const { racks, ports } = ledColours(alarm);
  return (
    <>
      {racks.map((r) => (
        <At key={r.x} x={r.x} y={170} w={90} h={350} style={{ background: "#1b1f22", border: "4px solid #0b0d0e", padding: "10px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
          {r.units.map((leds, i) => (
            <div key={i} style={{ height: 22, background: "#262c30", borderTop: "2px solid #343b40", display: "flex", alignItems: "center", gap: 4, padding: "0 5px" }}>
              {leds.map((l, j) => (
                <span key={j} className="b1-led" style={{ width: 5, height: 5, background: l.c, animationDelay: `${l.d}s` }} />
              ))}
              <span style={{ flex: 1 }} />
              <span style={{ width: 14, height: 4, background: "#3c454b" }} />
            </div>
          ))}
        </At>
      ))}
      {/* Network switch with port LEDs. */}
      <At x={910} y={200} w={110} h={22} style={{ background: "#2a3035", border: "3px solid #0b0d0e", display: "flex", alignItems: "center", gap: 3, padding: "0 5px" }}>
        {ports.map((p, i) => (
          <span key={i} className="b1-led" style={{ width: 6, height: 6, background: p.c, animationDelay: `${p.d}s` }} />
        ))}
      </At>
    </>
  );
}

export function BasementFurniture({ alarm }: { alarm: boolean }) {
  return (
    <>
      {/* Floor and stains */}
      <At
        x={0}
        y={520}
        w={1280}
        h={200}
        style={{
          background: "#232a26",
          backgroundImage:
            "linear-gradient(45deg, #1d2420 25%, transparent 25%, transparent 75%, #1d2420 75%), linear-gradient(45deg, #1d2420 25%, transparent 25%, transparent 75%, #1d2420 75%)",
          backgroundSize: "48px 48px",
          backgroundPosition: "0 0, 24px 24px",
          borderTop: "6px solid #0e1311",
        }}
      />
      <At x={520} y={300} w={90} h={70} style={{ background: "rgba(60,48,30,.35)" }} />
      <At x={980} y={420} w={60} h={100} style={{ background: "rgba(60,48,30,.3)" }} />

      {/* Ceiling pipes, a slow drip into a bucket */}
      <At x={0} y={18} w={1280} h={16} style={{ background: "#4a524d", borderTop: "3px solid #6b736e", borderBottom: "3px solid #2b322e" }} />
      <At x={0} y={44} w={1280} h={10} style={{ background: "#6b4a2e", borderBottom: "2px solid #3d2a1a" }} />
      <At x={300} y={12} w={18} h={46} style={{ background: "#6b736e" }} />
      <At x={820} y={12} w={18} h={46} style={{ background: "#6b736e" }} />
      <At x={1006} y={12} w={18} h={30} style={{ background: "#6b736e" }} />
      <At x={1012} y={40} w={5} h={8} style={anim("b1-drip 2.4s linear infinite", { background: "#5ad8ff" })} />
      <At x={996} y={676} w={30} h={30} style={{ background: "#3a5bd9", border: "3px solid #14110f", borderTopWidth: 5, zIndex: 6 }} />

      {/* Light tubes (one flickers) and a hanging ceiling tile */}
      <At x={420} y={66} w={180} h={10} style={{ background: "#f2fbe9", boxShadow: "0 0 40px 14px rgba(220,255,230,.18)" }} />
      <At x={780} y={66} w={180} h={10} style={anim("b1-tube 5s steps(1) infinite", { background: "#f2fbe9", boxShadow: "0 0 40px 14px rgba(220,255,230,.18)" })} />
      <At x={640} y={56} w={70} h={10} style={anim("b1-sway 4s ease-in-out infinite", { background: "#8e958f", border: "2px solid #4a524d", transformOrigin: "left center" })} />
      <At x={700} y={56} w={3} h={40} style={{ background: "#ffb547" }} />

      <Racks alarm={alarm} />

      {/* The cloud, which is on-prem */}
      <At x={42} y={324} w={66} h={50} style={{ background: "#f5f1e6", border: "3px solid #14110f", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, zIndex: 2 }}>
        <div style={{ position: "relative", width: 26, height: 12 }}>
          <span style={{ position: "absolute", left: 0, top: 6, width: 26, height: 6, background: "#5ad8ff" }} />
          <span style={{ position: "absolute", left: 4, top: 2, width: 10, height: 6, background: "#5ad8ff" }} />
          <span style={{ position: "absolute", left: 12, top: 0, width: 10, height: 8, background: "#5ad8ff" }} />
        </div>
        <span style={label(8, { fontWeight: 500, letterSpacing: 0.5 })}>THE CLOUD</span>
        <span className="b1-led" style={{ position: "absolute", right: 5, top: 5, width: 4, height: 4, background: "#4dff9a" }} />
      </At>
      <At x={92} y={366} w={46} h={28} style={{ ...centred, ...label(8, { lineHeight: 1.1 }), background: "#ffd23f", transform: "rotate(6deg)", zIndex: 3 }}>
        (on-prem)
      </At>
      <At x={140} y={230} w={44} h={30} style={{ ...centred, ...label(8, { lineHeight: 1.1 }), background: "#ff7ad9", transform: "rotate(-5deg)", zIndex: 3 }}>
        DO NOT UNPLUG
      </At>

      {/* Alarm beacon on the racks: a lit layer fading over a dark one */}
      {alarm && (
        <At x={160} y={150} w={30} h={20} style={{ background: "#5a1610" }}>
          <div style={{ position: "absolute", inset: 0, background: "#ff3b2a", boxShadow: "0 0 22px 8px rgba(255,59,42,.55)", animation: "b1-beacon .8s steps(1) infinite" }} />
        </At>
      )}

      {/* Cable runs drooping off the racks and across the ceiling */}
      <At x={116} y={72} w={6} h={104} style={{ background: "#3a5bd9" }} />
      <At x={124} y={72} w={6} h={104} style={{ background: "#ffb547" }} />
      <At x={216} y={72} w={6} h={104} style={{ background: "#e0483e" }} />
      <At x={224} y={72} w={6} h={104} style={{ background: "#4dff9a" }} />
      <At x={232} y={60} w={6} h={116} style={{ background: "#ff7ad9" }} />
      <At x={100} y={300} w={50} h={70} style={{ border: "5px solid #ffb547", borderTop: 0, borderRadius: "0 0 40px 40px" }} />
      <At x={200} y={330} w={50} h={60} style={{ border: "5px solid #3a5bd9", borderTop: 0, borderRadius: "0 0 40px 40px" }} />
      <At x={196} y={260} w={60} h={150} style={{ border: "4px solid #4dff9a", borderTop: 0, borderRadius: "0 0 40px 30px" }} />
      <At x={20} y={380} w={120} h={160} style={{ border: "4px solid #e0483e", borderTop: 0, borderRadius: "0 0 60px 20px" }} />
      <At x={318} y={150} w={600} h={70} style={{ border: "4px solid #5d6b66", borderTop: 0, borderRadius: "0 0 300px 300px" }} />
      <At x={318} y={160} w={600} h={90} style={{ border: "4px solid #ffb547", borderTop: 0, borderRadius: "0 0 300px 300px" }} />

      {/* The shelf of retired hardware */}
      <At x={350} y={250} w={680} h={10} style={{ background: "#6b4a2e", borderBottom: "4px solid #3d2a1a" }} />
      <At x={370} y={196} w={64} h={54} style={{ background: "#d9cfb4", border: "3px solid #14110f", padding: 6 }}>
        <div style={{ width: "100%", height: "100%", background: "#20302a" }} />
      </At>
      <At x={376} y={160} w={52} h={36} style={{ background: "#c4b996", border: "3px solid #14110f", padding: 4, transform: "rotate(-4deg)" }}>
        <div style={{ width: "100%", height: "100%", background: "#1a1f1d" }} />
      </At>
      <At x={444} y={206} w={54} h={44} style={{ background: "#c4b996", border: "3px solid #14110f", padding: 5 }}>
        <div style={{ width: "100%", height: "100%", background: "#1a1f1d", backgroundImage: "linear-gradient(135deg, transparent 45%, #6b736e 45%, #6b736e 52%, transparent 52%)" }} />
      </At>
      <At x={510} y={234} w={56} h={16} style={{ background: "#2b2b2b", border: "2px solid #14110f", display: "flex", alignItems: "center", gap: 4, padding: "0 6px" }}>
        <span className="b1-led" style={{ width: 4, height: 4, background: "#4dff9a" }} />
        <span className="b1-led" style={{ width: 4, height: 4, background: "#ffb547", animationDelay: ".4s" }} />
        <span className="b1-led" style={{ width: 4, height: 4, background: "#4dff9a", animationDelay: ".9s" }} />
      </At>
      <At x={512} y={218} w={52} h={16} style={{ background: "#3b4450", border: "2px solid #14110f" }} />
      <At x={576} y={214} w={90} h={36} style={{ background: "#d9cfb4", border: "3px solid #14110f" }} />
      <At x={584} y={192} w={74} h={22} style={{ background: "#c4b996", border: "3px solid #14110f" }} />
      <At x={680} y={218} w={40} h={32} style={{ background: "#3a5bd9", border: "3px solid #14110f" }} />
      <At x={686} y={222} w={28} h={10} style={{ background: "#e6dcc0" }} />
      <At x={726} y={230} w={70} h={20} style={{ background: "#a07a4a", border: "3px solid #5e4024" }} />
      <At x={732} y={212} w={60} h={18} style={{ background: "#a07a4a", border: "3px solid #5e4024" }} />
      <At x={600} y={260} w={4} h={50} style={{ background: "#e0483e" }} />
      <At x={640} y={260} w={4} h={80} style={{ background: "#5ad8ff" }} />
      <At x={470} y={260} w={4} h={36} style={{ background: "#4dff9a" }} />

      <At x={800} y={110} w={120} h={40} style={{ ...centred, background: "#0e1311", border: "4px solid #3a423e", fontFamily: PIXEL, fontSize: 10, color: "#e6dcc0", letterSpacing: 1, whiteSpace: "nowrap", transform: "rotate(-3deg)" }}>
        B1 · IT
      </At>
      <At x={924} y={222} w={4} h={28} style={{ background: "#ffb547" }} />
      <At x={940} y={222} w={4} h={28} style={{ background: "#5ad8ff" }} />
      <At x={980} y={222} w={4} h={28} style={{ background: "#4dff9a" }} />

      {/* Poster, whiteboard, sticky notes and the on-call roster */}
      <At x={372} y={290} w={116} h={86} style={{ ...label(10), background: "#e6dcc0", border: "4px solid #14110f", transform: "rotate(-2deg)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, textAlign: "center" }}>
        <span style={{ fontWeight: 500, lineHeight: 1.2 }}>
          THINK BEFORE
          <br />
          YOU REBOOT
        </span>
        <span style={{ width: 60, height: 4, background: "#e0483e" }} />
      </At>
      <At x={520} y={282} w={200} h={118} style={{ background: "#eef1ec", border: "6px solid #8e958f" }}>
        <span style={{ position: "absolute", left: 12, top: 12, width: 34, height: 20, border: "2px solid #3a5bd9" }} />
        <span style={{ position: "absolute", left: 80, top: 12, width: 34, height: 20, border: "2px solid #3a5bd9" }} />
        <span style={{ position: "absolute", left: 144, top: 40, width: 34, height: 20, border: "2px solid #e0483e" }} />
        <span style={{ position: "absolute", left: 46, top: 21, width: 34, height: 2, background: "#3a5bd9" }} />
        <span style={{ position: "absolute", left: 114, top: 26, width: 34, height: 2, background: "#3a5bd9", transform: "rotate(20deg)" }} />
        <span style={{ position: "absolute", left: 12, top: 68, fontFamily: MONO, fontSize: 11, fontWeight: 500, color: "#14110f", transform: "rotate(-3deg)", whiteSpace: "nowrap" }}>
          IT&apos;S ALWAYS DNS
        </span>
        <span style={{ position: "absolute", left: 12, top: 86, width: 110, height: 2, background: "#e0483e", transform: "rotate(-3deg)" }} />
      </At>
      <At x={736} y={292} w={26} h={26} style={{ background: "#ffd23f", transform: "rotate(-8deg)" }} />
      <At x={766} y={288} w={26} h={26} style={{ background: "#ff7ad9", transform: "rotate(5deg)" }} />
      <At x={744} y={322} w={26} h={26} style={{ background: "#5ad8ff", transform: "rotate(3deg)" }} />
      <At x={776} y={320} w={26} h={26} style={{ background: "#ffd23f", transform: "rotate(-4deg)" }} />
      <At x={760} y={352} w={26} h={26} style={{ background: "#4dff9a", transform: "rotate(9deg)" }} />
      <At x={822} y={296} w={92} h={120} style={{ ...label(9, { lineHeight: 1.2 }), background: "#d9cfb4", border: "4px solid #14110f", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "8px 6px", textAlign: "center" }}>
        <span style={{ fontWeight: 500 }}>ON-CALL</span>
        <span style={{ width: "100%", height: 2, background: "#14110f" }} />
        <span>MON · ??</span>
        <span>TUE · ??</span>
        <span>WED · ??</span>
        <span style={{ color: "#c2361b" }}>ALL · YOU</span>
      </At>

      {/* Cardboard boxes and tower PCs */}
      <At x={930} y={436} w={54} h={44} style={{ ...centred, background: "#a07a4a", border: "3px solid #5e4024", fontFamily: MONO, fontSize: 8, color: "#2a1c12" }}>
        MISC
      </At>
      <At x={984} y={448} w={60} h={72} style={{ ...centred, background: "#a07a4a", border: "3px solid #5e4024", fontFamily: MONO, fontSize: 8, color: "#2a1c12" }}>
        CABLES?
      </At>
      <At x={938} y={480} w={46} h={40} style={{ ...centred, background: "#8f6a3c", border: "3px solid #5e4024", fontFamily: MONO, fontSize: 7, color: "#2a1c12", lineHeight: 1.1 }}>
        DO NOT
        <br />
        OPEN
      </At>
      <At x={994} y={410} w={40} h={38} style={{ background: "#d9cfb4", border: "3px solid #14110f", transform: "rotate(8deg)" }} />
      <At x={326} y={448} w={30} h={72} style={{ background: "#c4b996", border: "3px solid #14110f" }} />
      <At x={324} y={400} w={34} h={48} style={{ background: "#d9cfb4", border: "3px solid #14110f", transform: "rotate(-6deg)" }} />

      {/* Bookshelf */}
      <At x={1050} y={290} w={110} h={230} style={{ background: "#4a3220", border: "4px solid #2a1c12", display: "flex", flexDirection: "column", justifyContent: "space-around", padding: 6 }}>
        {[
          [[10, 44, "#3a5bd9"], [8, 38, "#e6dcc0"], [12, 46, "#e0483e"], [9, 40, "#1f7a6d"], [11, 36, "#ffb547", 14], [10, 44, "#5d6b66"]],
          [[14, 30, "#e6dcc0"], [10, 44, "#34405a"], [10, 40, "#ff7ad9"], [12, 46, "#3a5bd9", -10], [8, 34, "#ffb547"]],
          [[30, 18, "#c4b996"], [30, 14, "#d9cfb4"], [20, 26, "#2b2b2b"]],
        ].map((shelf, i) => (
          <div key={i} style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 50, borderBottom: "4px solid #2a1c12" }}>
            {shelf.map(([w, h, c, rot], j) => (
              <span key={j} style={{ width: w as number, height: h as number, background: c as string, transform: rot ? `rotate(${rot}deg)` : undefined }} />
            ))}
          </div>
        ))}
      </At>
      <At x={1060} y={266} w={44} h={24} style={{ background: "#2b2b2b", border: "3px solid #14110f" }} />
      <At x={1066} y={252} w={30} h={14} style={{ background: "#d9cfb4", border: "2px solid #14110f" }} />

      {/* Arcade cabinet: the screen cycles colours by cross-fading three layers */}
      <At x={1180} y={300} w={84} h={220} style={{ background: "#1d1640", border: "4px solid #0b0816", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "8px 6px" }}>
        <div style={{ fontFamily: PIXEL, fontSize: 8, color: "#ffd23f" }}>ARCADE</div>
        <div style={{ position: "relative", width: 64, height: 54, border: "3px solid #0b0816", background: "#2b1b5e" }}>
          <div style={{ position: "absolute", inset: 0, background: "#5e1b4a", animation: "b1-arcade-2 1.5s steps(1) infinite" }} />
          <div style={{ position: "absolute", inset: 0, background: "#1b4a5e", animation: "b1-arcade-3 1.5s steps(1) infinite" }} />
        </div>
        <div style={{ width: 70, height: 18, background: "#34405a", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <span style={{ width: 6, height: 6, background: "#e0483e" }} />
          <span style={{ width: 6, height: 6, background: "#ffd23f" }} />
        </div>
      </At>

      {/* Coffee cart */}
      <At x={40} y={600} w={120} h={90} style={{ background: "#5d6b66", border: "4px solid #2b322e", zIndex: 5 }} />
      <At x={58} y={540} w={50} h={60} style={{ background: "#2b2b2b", border: "3px solid #14110f", zIndex: 5, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", paddingBottom: 6 }}>
        <span style={{ width: 20, height: 16, background: "#6b4a2e", border: "2px solid #e6dcc0" }} />
      </At>
      <At x={76} y={520} w={6} h={6} style={anim("b1-steam 1.8s linear infinite", { background: "rgba(230,220,192,.7)", zIndex: 5 })} />
      <At x={84} y={526} w={6} h={6} style={anim("b1-steam 1.8s linear infinite .7s", { background: "rgba(230,220,192,.6)", zIndex: 5 })} />
      <At x={118} y={582} w={16} h={18} style={{ background: "#e6dcc0", border: "2px solid #14110f", zIndex: 5 }} />
      <At x={134} y={586} w={14} h={14} style={{ background: "#ff7ad9", border: "2px solid #14110f", zIndex: 5 }} />
      <At x={44} y={640} w={112} h={20} style={{ ...centred, zIndex: 5, fontFamily: MONO, fontSize: 9, color: "#e6dcc0" }}>
        WASH YOUR MUG
      </At>

      {/* Loose cables on the floor */}
      <At x={160} y={694} w={60} h={14} style={{ border: "4px solid #e0483e", borderRadius: "50%", zIndex: 4 }} />
      <At x={172} y={698} w={40} h={10} style={{ border: "3px solid #3a5bd9", borderRadius: "50%", zIndex: 4 }} />
      <At x={380} y={700} w={120} h={4} style={{ background: "#ffb547", transform: "rotate(-2deg)", zIndex: 7 }} />
      <At x={700} y={708} w={160} h={4} style={{ background: "#4dff9a", transform: "rotate(1deg)", zIndex: 7 }} />

      {/* Beanbag */}
      <At x={1050} y={666} w={170} h={50} style={{ background: "#b03a2e", border: "4px solid #5e1b16", borderRadius: "26px 26px 6px 6px", zIndex: 8 }} />
    </>
  );
}
