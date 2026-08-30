"use client";

import { useQuery } from "@tanstack/react-query";
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
  Skull,
  X,
} from "lucide-react";
import { type ComponentType, type PointerEvent, useRef, useState } from "react";
import { api, joinAddress, type LiveListResponse, type LiveServer } from "@/lib/api";
import { AllayCompanion } from "./allay-companion";
import { DoomPlayer } from "./doom-player";
import { PanoramaBackground } from "./panorama-background";

type AppId = "realms" | "review" | "forge" | "activity" | "settings" | "doom";
type AppDefinition = {
  id: AppId;
  label: string;
  detail: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  color: string;
};

type ConnectorState = "checking" | "connected" | "unavailable";

type HealthResponse = {
  status: string;
};

const apps: AppDefinition[] = [
  {
    id: "realms",
    label: "My Realms",
    detail: "Live inventory",
    icon: Server,
    color: "#7a4f33",
  },
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
  { id: "doom", label: "DOOM", detail: "Shareware", icon: Skull, color: "#9b3f2f" },
];

function WindowBody({
  app,
  close,
  connectorState,
  liveServers,
  serversLoading,
}: {
  app: AppDefinition;
  close: () => void;
  connectorState: ConnectorState;
  liveServers: LiveServer[] | undefined;
  serversLoading: boolean;
}) {
  if (app.id === "doom") return <DoomPlayer />;
  if (app.id === "realms") {
    const realms = liveServers ?? [];
    const running = realms.filter(
      (server) => server.currentState.toLocaleLowerCase() === "running",
    ).length;
    return (
      <>
        <div className="window-hero">
          <p className="eyebrow">
            {serversLoading ? "Loading live inventory" : `${realms.length} realms under your care`}
          </p>
          <h2>
            {connectorState === "unavailable" ? "Last known realm state" : "Your realms, live."}
          </h2>
          <p>
            {connectorState === "unavailable"
              ? "The connector is offline. Controls stay disabled until live truth returns."
              : `${running} of ${realms.length} realms are running.`}
          </p>
        </div>
        <div className="realm-list">
          {serversLoading ? <p role="status">Checking the control plane…</p> : null}
          {!serversLoading && realms.length === 0 ? (
            <p>
              {connectorState === "unavailable"
                ? "No cached realms are available."
                : "No realms yet. Ask Allay to create one."}
            </p>
          ) : null}
          {realms.map((server) => {
            const state = server.currentState.replaceAll("_", " ");
            return (
              <div className="realm-row live-realm-row" key={server.id}>
                <span
                  className={server.currentState === "running" ? "status-dot" : "status-dot warn"}
                />
                <span>
                  <b>{server.name}</b>
                  <small>{state}</small>
                </span>
                <span className="realm-tps">
                  {server.hostname ? joinAddress(server) : `Minecraft ${server.version ?? "realm"}`}
                </span>
              </div>
            );
          })}
        </div>
      </>
    );
  }
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

type DragOperation = {
  appId: AppId;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
};

const initialWindows: WindowState[] = [
  { appId: "realms", x: 220, y: 190, z: 1, minimized: false, maximized: false },
];

function focusWindow(items: WindowState[], appId: AppId): WindowState[] {
  const ordered = [...items].sort((a, b) => a.z - b.z);
  const target = ordered.find((item) => item.appId === appId);
  if (!target) return items;

  return [...ordered.filter((item) => item.appId !== appId), { ...target, minimized: false }].map(
    (item, index) => ({ ...item, z: index + 1 }),
  );
}

export function Desktop() {
  const [windows, setWindows] = useState<WindowState[]>(initialWindows);
  const dragOperation = useRef<DragOperation | null>(null);
  const health = useQuery({
    queryKey: ["control-plane", "health"],
    queryFn: () => api<HealthResponse>("/health"),
    retry: 1,
    refetchInterval: 30_000,
  });
  const servers = useQuery({
    queryKey: ["control-plane", "servers"],
    queryFn: () => api<LiveListResponse>("/api/servers"),
    retry: 1,
    refetchInterval: 15_000,
  });
  const connectorState: ConnectorState =
    health.isError || servers.isError
      ? "unavailable"
      : health.data?.status === "ok" && servers.data
        ? "connected"
        : "checking";
  const runningRealms = servers.data?.data.filter(
    (server) => server.currentState.toLocaleLowerCase() === "running",
  ).length;
  const totalRealms = servers.data?.data.length;
  const connectorLabel =
    connectorState === "unavailable"
      ? "Control plane unavailable"
      : connectorState === "checking"
        ? "Checking control plane"
        : totalRealms === 0
          ? "Connected, no realms yet"
          : `${runningRealms} of ${totalRealms} realms running`;
  const focus = (appId: AppId) => setWindows((items) => focusWindow(items, appId));
  const open = (appId: AppId) =>
    setWindows((items) => {
      const found = items.some((window) => window.appId === appId);
      if (found) return focusWindow(items, appId);
      const offset = 36 * items.length;
      return focusWindow(
        [
          ...items,
          {
            appId,
            x: 140 + offset,
            y: 118 + offset,
            z: 0,
            minimized: false,
            maximized: false,
          },
        ],
        appId,
      );
    });
  const close = (appId: AppId) =>
    setWindows((items) => items.filter((window) => window.appId !== appId));
  const minimize = (appId: AppId) =>
    setWindows((items) =>
      items.map((window) => (window.appId === appId ? { ...window, minimized: true } : window)),
    );
  const toggleMaximize = (appId: AppId) =>
    setWindows((items) =>
      focusWindow(
        items.map((window) =>
          window.appId === appId
            ? { ...window, maximized: !window.maximized, minimized: false }
            : window,
        ),
        appId,
      ),
    );
  const beginDrag = (appId: AppId, event: PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button")) return;

    const current = windows.find((window) => window.appId === appId);
    if (!current || current.maximized) return;

    focus(appId);
    dragOperation.current = {
      appId,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: current.x,
      startY: current.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    const operation = dragOperation.current;
    if (!operation || operation.pointerId !== event.pointerId) return;

    const maxX = Math.max(12, window.innerWidth - 80);
    const maxY = Math.max(60, window.innerHeight - 80);
    const x = Math.min(
      maxX,
      Math.max(12, operation.startX + event.clientX - operation.startClientX),
    );
    const y = Math.min(
      maxY,
      Math.max(60, operation.startY + event.clientY - operation.startClientY),
    );

    setWindows((items) =>
      items.map((window) =>
        window.appId === operation.appId
          ? {
              ...window,
              x,
              y,
            }
          : window,
      ),
    );
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const operation = dragOperation.current;
    if (!operation || operation.pointerId !== event.pointerId) return;
    drag(event);
    dragOperation.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="mc-desktop">
      <PanoramaBackground />
      <div className="desktop-sky" />
      <header className="desktop-topbar">
        <div className="brand-mark">
          <MapIcon size={18} fill="currentColor" /> INDEXD
        </div>
        <div className="topbar-status" aria-live="polite">
          <span className={connectorState === "unavailable" ? "status-dot warn" : "status-dot"} />
          {connectorLabel} <Bell aria-hidden="true" size={17} />
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
            <section
              aria-label={app.label}
              className={`app-window pixel-border ${app.id === "doom" ? "doom-window" : ""} ${window.maximized ? "maximized" : ""}`}
              key={window.appId}
              onPointerDown={() => focus(window.appId)}
              style={{ left: window.x, top: window.y, zIndex: window.z }}
            >
              <div
                className="window-bar"
                onPointerCancel={endDrag}
                onPointerDown={(event) => beginDrag(window.appId, event)}
                onPointerMove={drag}
                onPointerUp={endDrag}
              >
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
              <div className={`window-content ${app.id === "doom" ? "doom-window-content" : ""}`}>
                <WindowBody
                  app={app}
                  close={() => open("review")}
                  connectorState={connectorState}
                  liveServers={servers.data?.data}
                  serversLoading={servers.isPending}
                />
              </div>
            </section>
          );
        })}
      <AllayCompanion
        connectorState={connectorState}
        operatorName="Krishang"
        refreshServers={() => servers.refetch()}
        servers={servers.data?.data}
        serversLoading={servers.isPending}
      />
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
