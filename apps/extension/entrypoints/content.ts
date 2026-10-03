import { defineContentScript } from "wxt/utils/define-content-script";
import { runOnPage } from "../lib/page";
import { JOB_SITES } from "../lib/sites";

export default defineContentScript({
  matches: JOB_SITES,
  allFrames: true, // Greenhouse forms are often embedded in an iframe on company career sites
  runAt: "document_idle",
  main() {
    runOnPage("site");
  },
});
