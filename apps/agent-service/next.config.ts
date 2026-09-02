import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: {
      // Default is 1MB; profile photos allow up to 5MB (+ multipart overhead).
      bodySizeLimit: "6mb",
    },
  },
};

export default nextConfig;
