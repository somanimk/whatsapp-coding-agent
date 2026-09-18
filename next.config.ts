import type { NextConfig } from "next";
const config: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  turbopack: { root: process.cwd() },
};
export default config;
