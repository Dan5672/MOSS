// A stocky IT guy with a ponytail over one shoulder, glasses and a beard. 16×16, one character per pixel, "." transparent, rows top to bottom.
// "G" is the glow colour, supplied when rendered.
export const ponytail = {
  id: "ponytail",
  label: "Ponytail",
  pal: { K: "#14110f", H: "#6b4426", B: "#6b4426", S: "#e8b48a", L: "#cfe8ff", E: "#14110f", T: "#2f4f3a", G: "GLOW" },
  blink: { row: 6, from: "E", to: "L", cols: [5, 10] },
  map: [
    "....KKKKKKKK....", "...KHHHHHHHHK...", "..KHHHHHHHHHHK..", "..KHSSSSSSSSHK..",
    ".KSSSSSSSSSSSSK.", ".KSKKKKSSKKKKSK.", ".KSKLEKSSKELKSK.", ".KSKKKKSSKKKKSK.",
    ".KSSSSSSSSSSSSK.", ".KBSSSSSSSSSSBK.", ".KBBBSKKKKSBBBK.", "..KBBBBBBBBBBKH.",
    "...KKKKKKKKKKKH.", "KTTTTTTTTTTTTHTK", "KTTTTTGGTTTTTTTK", "KTTTTTGGTTTTTTTK",
  ],
} as const;
