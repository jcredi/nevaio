import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Loopback only by default (F4): the dev server has repeatedly carried
    // file-disclosure advisories, so LAN exposure has to be a deliberate act.
    // For mobile testing on the local network, opt in per-run instead:
    //   npm run dev -- --host
    host: "127.0.0.1",
  },
});
