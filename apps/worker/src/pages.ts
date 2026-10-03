// Public pages: home, privacy policy, terms.

import { esc, page } from "./html";

const CONTACT = "tanishsaini26@gmail.com";
const UPDATED = "3 October 2026";

const HOME_STYLE = `
.hero{display:grid;grid-template-columns:1.05fr 1fr;gap:40px;align-items:center;padding:28px 0 8px}
.hero h1{font-size:44px;line-height:1.1;letter-spacing:-.5px;margin:0 0 14px}
.hero p.lead{font-size:19px;color:var(--muted);margin:0 0 22px}
.cta{display:flex;flex-wrap:wrap;gap:12px}.cta .btn{width:auto;margin:0;padding:12px 20px}
.shot{border-radius:14px;border:1px solid var(--line);box-shadow:0 18px 50px rgba(20,30,60,.16);width:100%;height:auto;display:block;background:#fff}
.connector{margin-top:18px;font-size:14px;color:var(--muted)}.copy{display:flex;gap:8px;margin-top:6px}
.copy code{flex:1;padding:9px 12px;font-size:14px}.copy button{flex:none;padding:0 14px;border-radius:9px;border:1px solid var(--line);background:var(--card);color:var(--text);font:inherit;cursor:pointer}
section{padding:36px 0 0}section>h2{font-size:28px;margin:0 0 6px;letter-spacing:-.3px}section>p.sub{color:var(--muted);margin:0 0 22px}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.step{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden}
.step img{width:100%;height:auto;display:block;border-bottom:1px solid var(--line)}.step div{padding:16px 18px}.step b{display:block;font-size:17px;margin-bottom:4px}
.step .n{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--soft);color:var(--accent);font-size:13px;font-weight:700;margin-right:6px}
.chips{display:flex;flex-wrap:wrap;gap:10px}.chips span{padding:7px 14px;border-radius:999px;background:var(--card);border:1px solid var(--line);font-size:14px}
.promise{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.promise div{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px}
.promise b{display:block;margin-bottom:4px}
details.faq{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin:10px 0}details.faq summary{cursor:pointer;font-weight:600}
@media (max-width:820px){.hero{grid-template-columns:1fr}.hero h1{font-size:34px}.steps,.promise{grid-template-columns:1fr}.top nav{display:none}}
`;

export function homePage(base: string, storeUrl: string, nonce: string): Response {
  const mcp = `${base}/mcp`;
  const addToChrome = storeUrl
    ? `<a class="btn" href="${esc(storeUrl)}" rel="noopener">Add to Chrome — it's free</a>`
    : `<span class="btn" aria-disabled="true" style="opacity:.75;cursor:default">Chrome extension: coming soon</span>`;
  return page(
    "JobSeeker — your AI assistant fills job applications",
    `<main class="wrap">
  <div class="hero">
    <div>
      <h1>Your AI assistant fills job applications. You review and submit.</h1>
      <p class="lead">JobSeeker connects Claude or ChatGPT to your browser. Find roles, open the application, say “fill it”, and the answers appear on the page, multi-page forms included.</p>
      <div class="cta">${addToChrome}<a class="btn secondary" href="#connect">Connect to Claude or ChatGPT</a></div>
      <div class="connector" id="connect">Add this as a custom connector in Claude (Settings → Connectors) or ChatGPT (Settings → Apps &amp; Connectors → Developer mode):
        <div class="copy"><code id="mcp">${esc(mcp)}</code><button type="button" id="copy">Copy</button></div></div>
    </div>
    <img class="shot" src="/screens/filled.png" width="1280" height="800" alt="A job application with answers filled in and highlighted, and the JobSeeker status pill">
  </div>

  <section id="how"><h2>How it works</h2><p class="sub">Three steps, and you stay in control the whole way.</p>
    <div class="steps">
      <div class="step"><img src="/screens/job-page.png" width="1280" height="800" alt="A job description page with the JobSeeker 'Open application' button" loading="lazy"><div><b><span class="n">1</span>Find a role</b>Ask your assistant, e.g. “backend jobs at Stripe in Bangalore”. It searches the company's live job board, newest first.</div></div>
      <div class="step"><img src="/screens/ready.png" width="1280" height="800" alt="An application form with the pill saying fields are ready" loading="lazy"><div><b><span class="n">2</span>Open the application</b>The extension reads the form's questions. Say “fill it”. It even moves through multi-page forms for you.</div></div>
      <div class="step"><img src="/screens/filled.png" width="1280" height="800" alt="Filled application with fields that need you outlined" loading="lazy"><div><b><span class="n">3</span>Review and submit</b>Answers are highlighted; anything that needs you (like your résumé) is outlined. You click Submit.</div></div>
    </div>
  </section>

  <section><h2>Works where you apply</h2><p class="sub">Job search and form filling on the systems most companies use, plus any job page you open.</p>
    <div class="chips"><span>Greenhouse</span><span>Lever</span><span>Ashby</span><span>Workday</span><span>Oracle Recruiting (e.g. JPMorgan)</span><span>SmartRecruiters</span><span>Workable</span><span>Recruitee</span><span>iCIMS</span><span>Taleo</span><span>SuccessFactors</span><span>Google Forms</span></div>
  </section>

  <section><h2>Your data stays yours</h2><p class="sub">We keep as little as we can.</p>
    <div class="promise">
      <div><b>Your details live in your assistant</b>Your name, experience and answers stay in Claude's or ChatGPT's memory. We don't store a profile.</div>
      <div><b>Just a 90-day list</b>We keep your email and a list of jobs you're applying to (company, role, link, status), deleted after 90 days.</div>
      <div><b>Nothing sent without you</b>JobSeeker never submits an application. You review every answer and click Submit yourself.</div>
    </div>
  </section>

  <section><h2>Questions</h2>
    <details class="faq"><summary>Is it free?</summary><p>Yes, while in early access.</p></details>
    <details class="faq"><summary>Does it submit applications for me?</summary><p>No. It fills the form and can click “Next” on multi-page forms, but it never clicks Submit. You always review and submit.</p></details>
    <details class="faq"><summary>Which assistants work?</summary><p>Claude (claude.ai, desktop) and ChatGPT (developer mode), through the connector above, plus the JobSeeker Chrome extension in your browser.</p></details>
    <details class="faq"><summary>What about my résumé?</summary><p>Browsers don't let extensions attach your files, so you upload it yourself; JobSeeker points to the upload field.</p></details>
    <details class="faq"><summary>How do I delete my data?</summary><p>Ask your assistant to “delete my JobSeeker data”, or email <a href="mailto:${CONTACT}">${CONTACT}</a>. See the <a href="/privacy">privacy policy</a>.</p></details>
  </section>
</main>
<script nonce="${esc(nonce)}">document.getElementById("copy").addEventListener("click",function(){navigator.clipboard.writeText(document.getElementById("mcp").textContent).then(function(){var b=document.getElementById("copy");b.textContent="Copied";setTimeout(function(){b.textContent="Copy"},1500)})});</script>`,
    { extraStyle: HOME_STYLE, nonce },
  );
}

export function privacyPage(): Response {
  return page(
    "Privacy policy · JobSeeker",
    `<main class="doc legal"><div class="card">
<h1>Privacy policy</h1><p class="muted">Effective ${UPDATED}</p>
<p>JobSeeker (“we”) lets an AI assistant you use (Claude or ChatGPT) search jobs, fill job applications in your browser through the JobSeeker Chrome extension, and keep a short list of your applications. This policy explains what we collect, why, and your choices. We designed JobSeeker to keep as little personal data as possible.</p>

<h2>What we keep</h2>
<table><tr><th>Data</th><th>Why</th><th>How long</th></tr>
<tr><td>Your email address and Google account ID (from “Continue with Google”; scopes <code>openid</code> and <code>email</code> only)</td><td>To know which account is yours</td><td>Until you ask us to delete your account</td></tr>
<tr><td>Applications you track: company, role, job link, status, applied date</td><td>Your application list</td><td>Deleted 90 days after the last update</td></tr>
<tr><td>The questions on an application page you have open (labels, options, whether each is answered; <b>not</b> what you typed)</td><td>So your assistant can answer them</td><td>Up to 1 hour, or until you close the page</td></tr>
<tr><td>Sign-in tokens for the connector and the extension (stored hashed or encrypted)</td><td>Keeping you signed in</td><td>Until they expire (extension: 90 days) or you sign out</td></tr></table>

<h2>What we don't keep</h2>
<ul><li>No profile, résumé or saved answers. Facts about you (name, experience, notice period, visa status…) stay in your assistant's own memory; your assistant sends them with a request when filling a form and we use them only for that request.</li>
<li>No passwords or payment details: the extension skips those fields.</li>
<li>No access to your email, Google Drive or other Google data.</li>
<li>No browsing history: the extension only reads application forms and job pages on job sites (or a page where you click “Use on this page”).</li></ul>

<h2>How it's used and shared</h2>
<p>We use this data only to provide JobSeeker. We don't sell it, use it for advertising, or use it to decide creditworthiness. It is shared only with:</p>
<ul><li><b>Your AI assistant</b> (Anthropic or OpenAI), when it calls JobSeeker's tools on your behalf. What they do with it is governed by their privacy policies.</li>
<li><b>Cloudflare</b>, which hosts JobSeeker (servers, database and logs).</li>
<li>Authorities, if required by law.</li></ul>
<p>JobSeeker's use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. The extension's use of data complies with the <a href="https://developer.chrome.com/docs/webstore/program-policies/limited-use">Chrome Web Store User Data Policy</a>, including the Limited Use requirements.</p>

<h2>Security</h2>
<p>Data is encrypted in transit (HTTPS) and at rest on Cloudflare. Sign-in tokens are stored hashed or encrypted, the extension never puts its token in a web address, and request logs (kept a few days) contain no answers you type.</p>

<h2>Your rights</h2>
<p>Under India's Digital Personal Data Protection Act, 2023 (and similar laws where you live) you can ask to access, correct or erase your data, and raise a grievance. You can:</p>
<ul><li>ask your assistant to “delete my JobSeeker data” (erases your application list and signs out the extension),</li>
<li>disconnect the connector and remove the extension to stop all access,</li>
<li>email us at <a href="mailto:${CONTACT}">${CONTACT}</a> for anything else, including deleting your account. We reply within 30 days.</li></ul>

<h2>Cookies</h2><p>We only use short-lived, essential cookies during sign-in. No tracking or advertising cookies.</p>
<h2>Children</h2><p>JobSeeker is for people aged 18 and over.</p>
<h2>Changes</h2><p>If we change this policy we'll update the date above, and for significant changes we'll show a notice on this site.</p>
<h2>Contact and grievance officer</h2><p>JobSeeker support, <a href="mailto:${CONTACT}">${CONTACT}</a>, Delhi, India.</p>
</div></main>`,
    { description: "What JobSeeker keeps (very little), why, and your choices." },
  );
}

export function termsPage(): Response {
  return page(
    "Terms of use · JobSeeker",
    `<main class="doc legal"><div class="card">
<h1>Terms of use</h1><p class="muted">Effective ${UPDATED}</p>
<p>These terms apply to the JobSeeker website, connector and Chrome extension (“JobSeeker”). By using JobSeeker you agree to them.</p>
<h2>1. Who can use it</h2><p>You must be 18 or older and able to agree to these terms. JobSeeker is free during early access and is provided “as is”.</p>
<h2>2. You're in charge of your applications</h2>
<ul><li>JobSeeker fills forms with answers from your AI assistant. AI can make mistakes: <b>review every answer before you submit</b>. JobSeeker never submits an application for you.</li>
<li>You're responsible for everything you submit, including that it's true and that you're allowed to share it.</li></ul>
<h2>3. Acceptable use</h2><p>Don't use JobSeeker to submit false or misleading information, to apply on someone else's behalf without their permission, to break job sites' terms, or to send applications in bulk or overload any site. Don't try to access other users' data or interfere with the service.</p>
<h2>4. Other services</h2><p>Job sites and AI assistants (such as Claude or ChatGPT) are run by other companies under their own terms. We're not responsible for them, for their availability, or for hiring decisions. JobSeeker doesn't guarantee interviews or jobs.</p>
<h2>5. Changes, suspension and ending</h2><p>We may change, pause or stop JobSeeker, and may suspend accounts that break these terms. You can stop using it at any time and ask us to delete your data (see the <a href="/privacy">privacy policy</a>).</p>
<h2>6. Liability</h2><p>To the extent the law allows, JobSeeker is provided without warranties, and we aren't liable for indirect or consequential losses, or for losses from answers you submitted. Nothing here limits liability that can't be limited by law.</p>
<h2>7. Governing law</h2><p>These terms are governed by the laws of India, and the courts of Delhi have jurisdiction.</p>
<h2>8. Changes to these terms</h2><p>We'll update the date above when these terms change; continuing to use JobSeeker means you accept the new terms.</p>
<h2>Contact</h2><p><a href="mailto:${CONTACT}">${CONTACT}</a></p>
</div></main>`,
    { description: "The rules for using JobSeeker." },
  );
}
