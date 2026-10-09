// A cyborg with a buzz cut and a metal plate over half the face; the mechanical eye is the glow colour. 16×16, one character per pixel, "." transparent, rows top to bottom.
// "G" is the glow colour, supplied when rendered.
export const cyborg = {
  id: "cyborg",
  label: "The Cyborg",
  pal: { K: "#14110f", H: "#4a3b30", S: "#d9a27a", M: "#8e9aa6", D: "#5d6b77", E: "#14110f", J: "#2b2b2b", G: "GLOW" },
  blink: { row: 6, from: "E", to: "S", cols: [4] },
  map: [
    "....KKKKKKKK....", "...KHHHHHMMMK...", "..KHHHHHMMMMMK..", "..KSSSSSMDDDMK..",
    "..KSSSSSMDDDMK..", "..KSKKSSMKKKMK..", "..KSESSSMDGDMK..", "..KSSSSSMDDDMK..",
    "..KSSSSSMMMMMK..", "..KSSKKKKKMMMK..", "...KSSSSSMMMK...", "....KKKKKKKKK...",
    "......KSDK......", "..KJJJJSDJJJJK..", ".KJJJJJJJJGJJJK.", ".KJJJJJJJJJJJJK.",
  ],
} as const;
