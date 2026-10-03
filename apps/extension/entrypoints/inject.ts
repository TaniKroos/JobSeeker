// Injected on demand ("Use on this page" in the popup) for career sites outside JOB_SITES.
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { runOnPage } from "../lib/page";

export default defineUnlistedScript(() => {
  runOnPage("manual");
});
