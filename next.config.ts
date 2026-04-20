import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow images from Supabase Storage buckets
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "pwharracxurdsnaddpae.supabase.co",
        pathname: "/storage/v1/object/**",
      },
    ],
  },

  // Increase body size limit for file uploads (10 MB)
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
