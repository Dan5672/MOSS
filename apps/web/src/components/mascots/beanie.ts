// A seen-it-all sysadmin: beanie, beard, headset. 16×16, one character per pixel, "." transparent, rows top to bottom.
// "G" is the glow colour, supplied when rendered.
export const beanie = {
  id: "beanie",
  label: "The Greybeard",
  pal: { K: "#14110f", O: "#ff8a3d", P: "#c4561f", S: "#e0a77a", B: "#5a3a22", H: "#2b2b2b", T: "#3b4450", G: "GLOW" },
  blink: { row: 5, from: "K", to: "S", cols: [4, 11] },
  map: [
    "...KKKKKKKKKK...", "..KOOOOOOOOOOK..", ".KOOOOOOOOOOOOK.", ".KPPPPPPPPPPPPK.",
    ".KSSSSSSSSSSSSK.", "HKSSKSSSSSSKSSKH", "HKSSSSSSSSSSSSKH", "HKBSSSSSSSSSSBKH",
    ".KBBSSSSSSSSBBK.", ".KBBBBBKKBBBBBK.", "..KBBBBBBBBBBK..", "...KBBBBBBBBK...",
    "....KKKKKKKK....", "..KTTTTSSTTTTK..", ".KTTTTTTTTTTTTK.", ".KTTTTGTTTTTTTK.",
  ],
} as const;
