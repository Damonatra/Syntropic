import type { Metadata } from "next";
import { Inter, Source_Serif_4 } from "next/font/google";
import "./globals.css";

const serif = Source_Serif_4({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-signifier",
  display: "swap",
});

const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sohne",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Syntropic | RFQ Audit Workstation",
  description: "Review RFQ extraction, provenance, and catalog decisions.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
