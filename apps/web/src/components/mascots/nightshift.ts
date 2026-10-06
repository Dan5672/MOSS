// A hooded operator with a phosphor visor. 16×16, one character per pixel, "." transparent, rows top to bottom.
// "G" is the glow colour, supplied when rendered.
export const nightshift = {
  id: "nightshift",
  label: "Night Shift",
  pal: { K: "#14110f", Q: "#34405a", S: "#f1c9a5", G: "GLOW", V: "#eafff3", W: "#e6dcc0" },
  blink: { row: 7, from: "V", to: "G" },
  map: [
    "....KKKKKKKK....", "...KQQQQQQQQK...", "..KQQQQQQQQQQK..", ".KQQQKKKKKKQQQK.",
    ".KQQKSSSSSSKQQK.", ".KQKSSSSSSSSKQK.", ".KQKGGGGGGGGKQK.", ".KQKGVGGGGVGKQK.",
    ".KQKSSSSSSSSKQK.", ".KQKSSSKKSSSKQK.", ".KQQKSSSSSSKQQK.", "..KQQKKKKKKQQK..",
    "..KQQQQQQQQQQK..", ".KQQQWQQQQWQQQK.", ".KQQQWQQQQWQQQK.", ".KQQQQQQQQQQQQK.",
  ],
} as const;
