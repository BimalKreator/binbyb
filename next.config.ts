import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
  // When set, proxy /api/* to the backend (e.g. Vercel + separate backend, or single server without Nginx)
  async rewrites() {
    const backend = process.env.NEXT_PUBLIC_API_BACKEND_URL;
    if (backend) {
      const base = backend.replace(/\/$/, "");
      return [{ source: "/api/:path*", destination: `${base}/api/:path*` }];
    }
    return [];
  },
};

export default nextConfig;
