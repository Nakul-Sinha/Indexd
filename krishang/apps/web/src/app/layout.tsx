import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";

import { LoginScreen } from "@/components/login-screen";
import { getAuth } from "@/lib/auth";

import "./globals.css";
import { Providers } from "./providers";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Indexd",
  description: "A private control plane for Minecraft realms and game servers.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  let session = null;

  try {
    session = await getAuth().api.getSession({ headers: await headers() });
  } catch (error) {
    console.error("Unable to read the Indexd session", {
      message: error instanceof Error ? error.message : "Unknown authentication error",
    });
  }

  return (
    <html lang="en">
      <body>{session ? <Providers>{children}</Providers> : <LoginScreen />}</body>
    </html>
  );
}
