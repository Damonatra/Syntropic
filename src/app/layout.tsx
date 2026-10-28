import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "Vertebra Command Centre — Syntropic",
  description:
    "1-of-1 executive command centre: live telemetry radar, ranked strike queue, spatial theatres, reply-agent triage and engine health for the Syntropic lead & intelligence engine.",
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
      <body className="antialiased min-h-screen flex flex-col bg-[#0a0a0b] text-[#f2f2f4]">
        {children}
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
