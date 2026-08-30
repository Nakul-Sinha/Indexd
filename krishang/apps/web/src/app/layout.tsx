import type { ReactNode } from "react";
import "./globals.css";
import { Providers } from "./providers";

export const metadata = { title: "Indexd" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  );
}
