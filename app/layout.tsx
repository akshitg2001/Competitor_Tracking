import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Market Pulse · Kids’ Footwear Intelligence",
  description: "A local dashboard for monitoring kids’ footwear products, prices and campaigns.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
