import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Job Copilot",
    description: "Let Claude or ChatGPT fill job applications for you. You review and submit.",
    permissions: ["storage", "identity", "scripting", "activeTab"],
    // The Worker this extension talks to (local dev and *.workers.dev deployments).
    host_permissions: ["https://jobs.smudgee.xyz/*", "http://localhost/*", "https://*.workers.dev/*"],
    // Asked for only when the user turns on "Work on every career site" in the popup.
    optional_host_permissions: ["<all_urls>"],
    action: { default_title: "Job Copilot" },
  },
});
