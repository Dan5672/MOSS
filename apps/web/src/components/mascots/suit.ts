// A manager in a navy suit with slicked hair; the tie is the glow colour. 16×16, one character per pixel, "." transparent, rows top to bottom.
// "G" is the glow colour, supplied when rendered.
export const suit = {
  id: "suit",
  label: "The Suit",
  pal: { K: "#14110f", H: "#2a2a2a", S: "#c98a5e", E: "#14110f", N: "#1f2a44", W: "#f5f1e6", G: "GLOW" },
  blink: { row: 6, from: "E", to: "S", cols: [5, 10] },
  map: [
    "....KKKKKKKK....", "...KHHHHHHHHK...", "..KHHHHHHHHHHK..", "..KHHSSSSSSSSK..",
    "..KSSSSSSSSSSK..", "..KSKKSSSSKKSK..", "..KSSESSSSESSK..", "..KSSSSSSSSSSK..",
    "..KSSSSSKKKSSK..", "...KSSSSSSSSK...", "....KKKKKKKK....", "....KWWWWWWK....",
    "..KNNWWGGWWNNK..", ".KNNNNWGGWNNNNK.", ".KNNNNNGGNNNNNK.", ".KNNNNNGGNNNNNK.",
  ],
} as const;
