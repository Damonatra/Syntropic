import type { Metadata } from "next";
import { Inter, Source_Serif_4 } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

// Steep substitutes: Source Serif 4 ≈ Signifier (display serif, weight 400)
// Inter ≈ Sohne (body/UI sans, fine-grained weights 400–500)
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-source-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "The Backbone — Syntropic Command Tower",
  description:
    "Editorial command tower for the Syntropic Backbone: live telemetry, spatial OCR ingestion with human-in-the-loop review, tenant enclaves, unified client inbox, and built-in executive calls.",
  keywords: ["Syntropic", "The Backbone", "Command Tower", "HITL", "OCR", "Rev-share"],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "The Backbone — Syntropic Command Tower",
    description: "Live telemetry, HITL quality control, and tenant enclave operations.",
    siteName: "The Backbone",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${sourceSerif.variable} antialiased bg-paper text-ink font-sans`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
