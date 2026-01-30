// build.js
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["node_modules/@coral-xyz/anchor/dist/browser/index.js"],
  bundle: true,
  format: "iife",
  globalName: "anchor",
  outfile: "anchor-build/anchor.browser.js",
  sourcemap: false,
  minify: false,
  define: {
    "process.env.ANCHOR_BROWSER": "true",
  },
  banner: {
    js: `// ✅ Custom Anchor browser build for SanctOS
(function() {
  console.log("[SanctOS] ⚙️ Loading custom Anchor browser runtime...");
})();`,
  },
  footer: {
    js: `
// ✅ Expose critical symbols for SanctOS
if (typeof window !== "undefined") {
  window.anchor = window.anchor || {};
  if (typeof AnchorProvider !== "undefined") window.anchor.AnchorProvider = AnchorProvider;
  if (typeof Provider !== "undefined") window.anchor.Provider = Provider;
  if (typeof Program !== "undefined") window.anchor.Program = Program;
  if (typeof utils !== "undefined") window.anchor.utils = utils;
  console.log("[SanctOS] 🧩 AnchorProvider + Program exported globally");
}`,
  },
});
