/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export when EXPORT=1 (GitHub Pages build); dev server otherwise.
  ...(process.env.EXPORT === "1"
    ? {
        output: "export",
        basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? "",
        images: { unoptimized: true },
      }
    : {}),
};

export default nextConfig;
