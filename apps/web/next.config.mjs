/** @type {import('next').NextConfig} */
// NEXT_DIST_DIR lets `next dev` and `next start` run side by side without sharing a build folder.
export default { reactStrictMode: true, serverExternalPackages: ["mongodb"], distDir: process.env.NEXT_DIST_DIR || ".next" };
