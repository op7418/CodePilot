import { createMDX } from 'fumadocs-mdx/next';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  images: { qualities: [75, 90] },
  outputFileTracingRoot: path.resolve(__dirname, '../../'),
};

const withMDX = createMDX();

export default withMDX(config);
