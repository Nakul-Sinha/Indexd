import { status } from "elysia";

const DNS_NAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function getMinecraftRouteHostname(serverId: string, configuredDomain?: string): string {
  const domainSource =
    arguments.length >= 2 ? configuredDomain : process.env.MINECRAFT_ROUTE_DOMAIN;
  const routeDomain = domainSource?.trim().toLowerCase().replace(/\.$/, "");

  if (!routeDomain || !DNS_NAME_PATTERN.test(routeDomain)) {
    throw status(503, "Minecraft routing is not configured.");
  }

  return `${serverId}.${routeDomain}`;
}
