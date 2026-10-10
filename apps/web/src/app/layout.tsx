import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Press_Start_2P } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

// Pixel face for the wordmark and page titles only; Plex for everything else.
const pixel = Press_Start_2P({ variable: "--font-press-start", weight: "400", subsets: ["latin"] });
const sans = IBM_Plex_Sans({ variable: "--font-plex-sans", weight: ["400", "500", "600"], subsets: ["latin"] });
const mono = IBM_Plex_Mono({ variable: "--font-plex-mono", weight: ["400", "500"], subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "MOSS", template: "%s · MOSS" },
  description: "MOSS — your AI IT department",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${pixel.variable} ${sans.variable} ${mono.variable} h-full antialiased`}>
      <body className="min-h-full bg-background text-foreground">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster richColors />
        </ThemeProvider>
      </body>
    </html>
  );
}
