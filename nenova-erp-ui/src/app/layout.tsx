import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NENOVA ERP",
  description: "네노바 내부 업무 시스템",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
