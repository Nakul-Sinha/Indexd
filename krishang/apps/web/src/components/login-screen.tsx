"use client";

import { KeyRound, Map as MapIcon, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";
import { PanoramaBackground } from "./panorama-background";

function GoogleMark() {
  return (
    <svg aria-hidden="true" className="google-mark" viewBox="0 0 18 18">
      <path
        d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.797 2.716v2.258h2.909c1.702-1.567 2.684-3.874 2.684-6.614Z"
        fill="#4285f4"
      />
      <path
        d="M9 18c2.43 0 4.467-.806 5.956-2.181l-2.909-2.258c-.806.54-1.835.859-3.047.859-2.344 0-4.328-1.585-5.037-3.714H.956v2.332A8.998 8.998 0 0 0 9 18Z"
        fill="#34a853"
      />
      <path
        d="M3.963 10.706A5.41 5.41 0 0 1 3.682 9c0-.592.102-1.167.281-1.706V4.962H.956A8.997 8.997 0 0 0 0 9c0 1.452.347 2.827.956 4.038l3.007-2.332Z"
        fill="#fbbc05"
      />
      <path
        d="M9 3.58c1.321 0 2.507.454 3.441 1.345l2.581-2.581C13.463.892 11.426 0 9 0A8.998 8.998 0 0 0 .956 4.962l3.007 2.332C4.672 5.165 6.656 3.58 9 3.58Z"
        fill="#ea4335"
      />
    </svg>
  );
}

export function LoginScreen() {
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signInWithGoogle() {
    setIsSigningIn(true);
    setError(null);

    try {
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: "/",
      });

      if (result.error) {
        setError(result.error.message ?? "Google sign-in could not be started.");
        setIsSigningIn(false);
      }
    } catch {
      setError("Google sign-in is unavailable right now. Please try again.");
      setIsSigningIn(false);
    }
  }

  return (
    <main className="login-screen">
      <PanoramaBackground />
      <div className="desktop-sky" />

      <header className="login-brand">
        <MapIcon aria-hidden="true" size={19} />
        <span>Indexd</span>
      </header>

      <section className="login-window pixel-border" aria-labelledby="login-title">
        <div className="login-window-bar">
          <span className="login-window-icon" aria-hidden="true">
            <KeyRound size={16} />
          </span>
          Private control room
        </div>

        <div className="login-content">
          <span className="login-shield" aria-hidden="true">
            <ShieldCheck size={29} strokeWidth={2.2} />
          </span>
          <p className="eyebrow">Account required</p>
          <h1 id="login-title">Enter your world.</h1>
          <p className="login-intro">
            Sign in to load the realms assigned to your account. Server details stay hidden until
            Google verifies who you are.
          </p>

          <button
            className="google-sign-in"
            disabled={isSigningIn}
            onClick={signInWithGoogle}
            type="button"
          >
            <GoogleMark />
            <span>{isSigningIn ? "Opening Google…" : "Continue with Google"}</span>
          </button>

          <p className="login-scope">
            One account, one scope. Only realms owned by this account will appear.
          </p>

          {error ? (
            <p className="auth-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </section>
    </main>
  );
}
