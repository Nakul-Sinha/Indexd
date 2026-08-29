"use client";

/**
 * A single panorama face cannot form a correct cube skybox. Pan it smoothly
 * across the desktop and reverse at each edge instead of stretching it into
 * mismatched cube faces.
 */
export function PanoramaBackground() {
  return <div aria-hidden="true" className="panorama-canvas" />;
}
