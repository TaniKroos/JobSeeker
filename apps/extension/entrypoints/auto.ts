// Registered on every website when the user opts in ("Work on every career site" in the popup).
// Stays idle unless the page has a form or a job posting.
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { runOnPage } from "../lib/page";

export default defineUnlistedScript(() => {
  runOnPage("lazy");
});
