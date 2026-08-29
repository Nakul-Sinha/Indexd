"use client";

import { motion, type PanInfo } from "framer-motion";
import {
  Bell,
  ChevronRight,
  ClipboardCheck,
  Compass,
  Hammer,
  HeartPulse,
  Map as MapIcon,
  Server,
  Settings,
  ShieldCheck,
  X,
} from "lucide-react";
import { type ComponentType, useState } from "react";
import { PanoramaBackground } from "./panorama-background";

type AppId = "realms" | "review" | "forge" | "activity" | "settings";
type AppDefinition = {
  id: AppId;
  label: string;
  detail: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  color: string;
};

const apps: AppDefinition[] = [
  { id: "realms", label: "My Realms", detail: "3 servers", icon: Server, color: "#7a4f33" },
  {
    id: "review",
    label: "Review Queue",
    detail: "2 waiting",
    icon: ClipboardCheck,
    color: "#b07a47",
  },
  { id: "forge", label: "Rule Forge", detail: "Create safely", icon: Hammer, color: "#8b5e3c" },
  { id: "activity", label: "World Feed", detail: "Live events", icon: Compass, color: "#6d4a37" },
  { id: "settings", label: "Settings", detail: "Preferences", icon: Settings, color: "#9a7859" },
];

function WindowBody({ app, close }: { app: AppDefinition; close: () => void }) {
  if (app.id === "realms")
    return (
      <>
        <div className="window-hero">
          <p className="eyebrow">3 realms under your care</p>
          <h2>Good evening, Krishang.</h2>
          <p>Everything is green. Your players are having a great night.</p>
        </div>
        <div className="realm-list">
          {[
            "Emerald SMP|18 / 40 players|19.9 TPS",
            "Nether Run|6 / 20 players|20.0 TPS",
            "Creative Quarry|Sleeping|Ready when you are",
          ].map((line) => {
            const [name, players, tps] = line.split("|");
            return (
              <button className="realm-row" key={name} type="button">
                <span className="status-dot" />
                <span>
                  <b>{name}</b>
                  <small>{players}</small>
                </span>
                <span className="realm-tps">{tps}</span>
                <ChevronRight size={18} />
              </button>
            );
          })}
        </div>
      </>
    );
  if (app.id === "review")
    return (
      <>
        <div className="window-heading">
          <span className="app-badge">
            <ShieldCheck size={20} />
          </span>
          <div>
            <p className="eyebrow">Human approval required</p>
            <h2>2 changes need your eyes</h2>
          </div>
        </div>
        <div className="proposal-card">
          <span className="proposal-mark">13</span>
          <div>
            <b>Emerald SMP — Welcome Kit</b>
            <p>New players get bread, stone tools, and a welcome message.</p>
          </div>
          <button className="mini-button" onClick={close} type="button">
            Review
          </button>
        </div>
        <div className="proposal-card">
          <span className="proposal-mark gold">14</span>
          <div>
            <b>Nether Run — First Steps</b>
            <p>Play a chime when an explorer breaks their first block.</p>
          </div>
          <button className="mini-button" type="button">
            Review
          </button>
        </div>
      </>
    );
  if (app.id === "forge")
    return (
      <>
        <div className="window-heading">
          <span className="app-badge blue">
            <Hammer size={20} />
          </span>
          <div>
            <p className="eyebrow">No live effects until approval</p>
            <h2>Forge a rule</h2>
          </div>
        </div>
        <label className="forge-label">
          What should happen when a player joins?
          <textarea defaultValue="Welcome them to Emerald SMP and give them a starter kit with 16 bread." />
        </label>
        <div className="forge-preview">
          <p className="eyebrow">Preview</p>
          <p>Join greeting + starter kit</p>
          <small>Nothing changes in-game until you review and approve it.</small>
        </div>
        <button className="mc-button" type="button">
          Generate safe preview <ChevronRight size={17} />
        </button>
      </>
    );
  if (app.id === "activity")
    return (
      <>
        <div className="window-heading">
          <span className="app-badge pink">
            <HeartPulse size={20} />
          </span>
          <div>
            <p className="eyebrow">Emerald SMP • live</p>
            <h2>World activity</h2>
          </div>
        </div>
        {[
          "Mossgrove found diamonds in Mining World",
          "7 explorers are now online",
          "A proposal was created for Emerald SMP",
          "Tinbucket entered the Nether",
        ].map((event, index) => (
          <div className="feed-row" key={event}>
            <span className="feed-icon">{index === 0 ? "◆" : "•"}</span>
            <span>
              {event}
              <small>{index + 1} min ago</small>
            </span>
          </div>
        ))}
      </>
    );
  return (
    <>
      <div className="window-heading">
        <span className="app-badge gray">
          <Settings size={20} />
        </span>
        <div>
          <p className="eyebrow">Your control room</p>
          <h2>Preferences</h2>
        </div>
      </div>
      <div className="setting-row">
        <span>
          <b>Desktop notifications</b>
          <small>Alert me when proposals need approval</small>
        </span>
        <span className="toggle on" />
      </div>
      <div className="setting-row">
        <span>
          <b>Realm health alerts</b>
          <small>Tell me when TPS drops below 18</small>
        </span>
        <span className="toggle on" />
      </div>
    </>
  );
}

type WindowState = {
  appId: AppId;
  x: number;
  y: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
};

const initialWindows: WindowState[] = [
  { appId: "realms", x: 220, y: 190, z: 1, minimized: false, maximized: false },
];

export function Desktop() {
  const [windows, setWindows] = useState<WindowState[]>(initialWindows);
  const nextZ = () => Math.max(0, ...windows.map((window) => window.z)) + 1;
  const focus = (appId: AppId) =>
    setWindows((items) =>
      items.map((window) =>
        window.appId === appId ? { ...window, z: nextZ(), minimized: false } : window,
      ),
    );
  const open = (appId: AppId) =>
    setWindows((items) => {
      const found = items.some((window) => window.appId === appId);
      if (found)
        return items.map((window) =>
          window.appId === appId ? { ...window, minimized: false, z: nextZ() } : window,
        );
      const offset = 36 * items.length;
      return [
        ...items,
        { appId, x: 140 + offset, y: 118 + offset, z: nextZ(), minimized: false, maximized: false },
      ];
    });
  const close = (appId: AppId) =>
    setWindows((items) => items.filter((window) => window.appId !== appId));
  const minimize = (appId: AppId) =>
    setWindows((items) =>
      items.map((window) => (window.appId === appId ? { ...window, minimized: true } : window)),
    );
  const toggleMaximize = (appId: AppId) =>
    setWindows((items) =>
      items.map((window) =>
        window.appId === appId
          ? { ...window, maximized: !window.maximized, z: nextZ(), minimized: false }
          : window,
      ),
    );
  const move = (appId: AppId, info: PanInfo) =>
    setWindows((items) =>
      items.map((window) =>
        window.appId === appId
          ? {
              ...window,
              x: Math.max(12, window.x + info.offset.x),
              y: Math.max(65, window.y + info.offset.y),
            }
          : window,
      ),
    );

  return (
    <div className="mc-desktop">
      <PanoramaBackground />
      <div className="desktop-sky" />
      <header className="desktop-topbar">
        <div className="brand-mark">
          <MapIcon size={18} fill="currentColor" /> FARLANDS <span>LIVE</span>
        </div>
        <div className="topbar-status">
          <span className="status-dot" /> All realms online <Bell size={17} />
        </div>
      </header>
      <section className="desktop-icons" aria-label="Desktop applications">
        {apps.map((app) => {
          const Icon = app.icon;
          return (
            <button
              className="desktop-icon"
              key={app.id}
              onClick={() => open(app.id)}
              type="button"
            >
              <span className="icon-tile" style={{ backgroundColor: app.color }}>
                <Icon size={28} strokeWidth={2.4} />
              </span>
              <b>{app.label}</b>
              <small>{app.detail}</small>
            </button>
          );
        })}
      </section>
      {windows
        .filter((window) => !window.minimized)
        .map((window) => {
          const app = apps.find((entry) => entry.id === window.appId);
          if (!app) return null;
          const Icon = app.icon;
          return (
            <motion.section
              aria-label={app.label}
              className={`app-window pixel-border ${window.maximized ? "maximized" : ""}`}
              drag={!window.maximized}
              dragMomentum={false}
              initial={{ opacity: 0, scale: 0.92, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              key={window.appId}
              onDragEnd={(_event, info) => move(window.appId, info)}
              onPointerDown={() => focus(window.appId)}
              style={{ left: window.x, top: window.y, zIndex: window.z }}
            >
              <div className="window-bar">
                <div className="window-title">
                  <span style={{ color: app.color }}>
                    <Icon size={17} />
                  </span>
                  {app.label}
                </div>
                <div className="window-controls">
                  <button
                    aria-label={`Minimize ${app.label}`}
                    onClick={() => minimize(window.appId)}
                    type="button"
                  >
                    —
                  </button>
                  <button
                    aria-label={`Maximize ${app.label}`}
                    onClick={() => toggleMaximize(window.appId)}
                    type="button"
                  >
                    □
                  </button>
                  <button
                    aria-label={`Close ${app.label}`}
                    onClick={() => close(window.appId)}
                    type="button"
                  >
                    <X size={15} />
                  </button>
                </div>
              </div>
              <div className="window-content">
                <WindowBody app={app} close={() => open("review")} />
              </div>
            </motion.section>
          );
        })}
      <footer className="desktop-taskbar">
        <button className="start-button" onClick={() => open("realms")} type="button">
          <span>◆</span> Start
        </button>
        <div className="taskbar-apps">
          {windows.map((window) => {
            const app = apps.find((entry) => entry.id === window.appId);
            if (!app) return null;
            const Icon = app.icon;
            return (
              <button
                aria-label={`Switch to ${app.label}`}
                className={!window.minimized ? "task-app active" : "task-app"}
                key={window.appId}
                onClick={() => focus(window.appId)}
                type="button"
              >
                <Icon size={18} />
              </button>
            );
          })}
        </div>
        <div className="taskbar-time">
          10:20 PM
          <br />
          <span>Saturday</span>
        </div>
      </footer>
    </div>
  );
}
