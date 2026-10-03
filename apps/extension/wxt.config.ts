import { defineConfig } from "wxt";

const PROD_SERVER = "https://jobs.smudgee.xyz/*";

export default defineConfig({
  zip: { artifactTemplate: "jobseeker-{{version}}-{{browser}}{{mode}}.zip" },
  // `wxt build --mode store` / `wxt zip --mode store`: the Chrome Web Store build. It only talks to the
  // production server and leaves out the optional all-sites permission (slower review; add in an update).
  manifest: ({ mode }) => {
    const store = mode === "store";
    return {
      name: "JobSeeker",
      description: "Your AI assistant fills job applications for you. You review and submit.",
      homepage_url: "https://jobs.smudgee.xyz",
      permissions: ["storage", "identity", "scripting", "activeTab"],
      host_permissions: store ? [PROD_SERVER] : [PROD_SERVER, "http://localhost/*", "https://*.workers.dev/*"],
      // Asked for only when the user turns on "Work on every career site" in the popup.
      ...(store ? {} : { optional_host_permissions: ["<all_urls>"] }),
      icons: { 16: "icon/16.png", 32: "icon/32.png", 48: "icon/48.png", 128: "icon/128.png" },
      action: { default_title: "JobSeeker", default_icon: { 16: "icon/16.png", 32: "icon/32.png" } },
    };
  },
});
