import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "Vertebra — Syntropic Lead & Intelligence Engine",
  description:
    "Autonomous lead generation, Quote Leakage Vulnerability scoring and dual-channel dispatch for US & Canada industrial distributors.",
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;1,8..60,400&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased min-h-screen flex flex-col bg-white text-[#17191c]">
        {children}
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
