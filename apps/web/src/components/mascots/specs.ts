// An analyst with auburn twin buns, big round red glasses and a mustard cardigan. 16×16, one character per pixel, "." transparent, rows top to bottom.
// "G" is the glow colour, supplied when rendered.
export const specs = {
  id: "specs",
  label: "Specs",
  pal: { K: "#14110f", A: "#a0441e", S: "#e9c0a0", R: "#e0483e", L: "#d8ecff", E: "#14110f", C: "#d9a13a", W: "#f5f1e6", G: "GLOW" },
  blink: { row: 7, from: "E", to: "L", cols: [5, 10] },
  map: [
    ".KKK........KKK.", "KAAAK.KKKK.KAAAK", "KAAAKKAAAAKKAAAK", ".KKAAAAAAAAAAKK.",
    "..KAAAAAAAAAAK..", "..KASSSSSSSSAK..", "..KRRRRSSRRRRK..", "..KRLERSSRELRK..",
    "..KRRRRSSRRRRK..", "..KSSSSSSSSSSK..", "...KSSSKKSSSK...", "....KKKKKKKK....",
    "......KSSK......", "..KCCCWWWWCCCK..", ".KCCCCCWWCCCCCK.", ".KCCCCCGGCCCCCK.",
  ],
} as const;
