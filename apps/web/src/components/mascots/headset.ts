// Runs the queue: bob, mic, lanyard. 16×16, one character per pixel, "." transparent, rows top to bottom.
// "G" is the glow colour, supplied when rendered.
export const headset = {
  id: "headset",
  label: "Desk Lead",
  pal: { K: "#14110f", H: "#2a1d2e", S: "#8d5a3b", P: "#c2410c", M: "#5d6b66", J: "#1f7a6d", Y: "#ffd23f", W: "#f5f1e6", G: "GLOW" },
  blink: { row: 6, from: "K", to: "S", cols: [4, 5, 10, 11] },
  map: [
    "....KKKKKKKK....", "...KHHHHHHHHK...", "..KHHHHHHHHHHK..", ".KHHHHHHHHHHHHK.",
    ".KHHSSSSSSSSHHK.", ".KHSSSSSSSSSSHK.", "MKHSKKSSSSKKSHK.", "MKHSSSSSSSSSSHK.",
    "MKHSSSSSSSSSSHK.", ".MHHSSSPPSSSHHK.", "..MGHSSSSSSHHK..", "..KKHKSSSSKHKK..",
    "......KSSK......", "..KJJJJYYJJJJK..", ".KJJJJJYYJJJJJK.", ".KJJJJJWWJJJJJK.",
  ],
} as const;
