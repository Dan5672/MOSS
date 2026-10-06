// The brand mascot: the agent as a terminal. 16×16, one character per pixel, "." transparent, rows top to bottom.
// "G" is the glow colour, supplied when rendered.
export const monitor = {
  id: "monitor",
  label: "Unit 01",
  pal: { K: "#14110f", B: "#e6dcc0", D: "#b3a88a", S: "#0e2a20", G: "GLOW", H: "#2b2b2b", C: "#3a5bd9", W: "#f5f1e6", R: "#e0483e" },
  blink: { row: 4, from: "G", to: "S" },
  map: [
    "..KKKKKKKKKKKK..", ".KBBBBBBBBBBBBK.", ".KBKKKKKKKKKKDK.", ".KBKSSSSSSSSKDK.",
    "HKBKSGGSSGGSKDKH", "HKBKSGGSSGGSKDKH", "HKBKSSSSSSSSKDKH", ".KBKSSGSSGSSKDK.",
    ".KBKSSSGGSSSKDK.", ".KBKKKKKKKKKKDK.", ".KBBBBBBBBBBGDK.", "..KKKKKKKKKKKK..",
    "......KDDK......", "..KCCCWRRWCCCK..", ".KCCCCCRRCCCCCK.", ".KCCCCCRRCCCCCK.",
  ],
} as const;
