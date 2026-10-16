import type { Metadata } from "next";
import type { ReactNode } from "react";

import { InlineScript, ThemeSync } from "@/components/theme";
import { THEME_BOOTSTRAP_JS } from "@/lib/theme";
import { siteUrl } from "@/lib/site";

import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "SARbase",
    template: "%s · SARbase",
  },
  description:
    "Open-source operations, administration, notification, and recordkeeping for volunteer search and rescue organizations.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the bootstrap script below sets the
    // `dark` class and colorScheme before hydration — React accepts the
    // script-applied DOM rather than the server-rendered default.
    <html lang="en" suppressHydrationWarning>
      <head>
        <InlineScript html={THEME_BOOTSTRAP_JS} />
      </head>
      <body className="min-h-screen bg-white text-neutral-900 antialiased">
        <ThemeSync />
        {children}
      </body>
    </html>
  );
}
