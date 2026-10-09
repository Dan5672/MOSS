// A goth with a swept black undercut, a glow-coloured streak, dark lipstick and a choker. 16×16, one character per pixel, "." transparent, rows top to bottom.
// "G" is the glow colour, supplied when rendered.
export const goth = {
  id: "goth",
  label: "The Goth",
  pal: { K: "#14110f", H: "#1a1420", S: "#efe2da", L: "#5a1a3a", C: "#c0c4c8", T: "#1f1a24", G: "GLOW" },
  blink: { row: 6, from: "K", to: "S", cols: [10, 11] },
  map: [
    "...KKKKKKKKK....", "..KHHHHHGGHHK...", ".KHHHHHGGHHHHK..", ".KHHHHGGHHHSSK..",
    ".KHHHHHHSSSSSK..", ".KHHHHSSSSSSSK..", ".KHHHKKSSSKKSK..", ".KHHHSSSSSSSSK..",
    ".KHHHSSSLLSSSK..", ".KHHHHSSSSSSK...", "..KHHHKSSSSK....", "......KSSK......",
    "....KCCCCCCK....", "..KTTTTSSTTTTK..", ".KTTTTTTTTTTTTK.", ".KTTTTTGTTTTTTK.",
  ],
} as const;
