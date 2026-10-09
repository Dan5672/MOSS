// An elderly oracle with a white bun, closed eyes, a glowing forehead gem and a starry shawl. The gem flickers instead of blinking. 16×16, one character per pixel, "." transparent, rows top to bottom.
// "G" is the glow colour, supplied when rendered.
export const oracle = {
  id: "oracle",
  label: "The Oracle",
  pal: { K: "#14110f", W: "#eeeeea", S: "#b07a52", G: "GLOW", V: "#4b2a7a", Y: "#ffd23f" },
  blink: { row: 4, from: "G", to: "Y" },
  map: [
    ".....KKKKKK.....", "....KWWWWWWK....", "...KKWWWWWWKK...", "..KWWWWWWWWWWK..",
    ".KWWWSSGGSSWWWK.", ".KWWSSSGGSSSWWK.", ".KWWSSSSSSSSWWK.", ".KWWSKKSSKKSWWK.",
    ".KWWSSSSSSSSWWK.", ".KWWSSSKKSSSWWK.", ".KWWWSSSSSSWWWK.", "..KWWKSSSSKWWK..",
    "..KVVVKSSKVVVK..", ".KVVVVVVVVVVVVK.", ".KVVVVVYVVVVVVK.", ".KVVVVYYYVVVVVK.",
  ],
} as const;
