import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Syntropic | RFQ Audit Workstation",
  description: "Review RFQ extraction, provenance, and catalog decisions.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
