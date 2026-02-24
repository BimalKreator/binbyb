import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { Toaster } from "react-hot-toast";
import "./globals.css";
import { LayoutShell } from "@/components/LayoutShell";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  themeColor: "#0f172a",
};

export const metadata: Metadata = {
  title: "Binbyb — HFT Funding Arbitrage",
  description: "HFT funding arbitrage bot — mobile-first PWA",
  applicationName: "Binbyb",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Binbyb",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-[100dvh] antialiased">
        <LayoutShell>{children}</LayoutShell>
        <Toaster
          position="top-center"
          toastOptions={{
            duration: 4000,
            style: {
              background: "#1e293b",
              color: "#f1f5f9",
              borderRadius: "0.5rem",
            },
          }}
        />
      </body>
    </html>
  );
}
