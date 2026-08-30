import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@repo/contracts"],
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "indexd.app" }],
        destination: "https://www.indexd.app/:path*",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
