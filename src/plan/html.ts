export const PLAN_REVIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plan review · Pi Prompt</title>
<link rel="stylesheet" href="/browser/styles.css">
<script type="module" src="/browser/app.js"></script>
</head>
<body>
<a class="skip-link" href="#plan-content">Skip to plan</a>
<header class="app-header">
  <div class="brand"><span class="brand-mark" aria-hidden="true">π</span><div><p>Pi Prompt</p><h1>Plan review</h1></div></div>
  <div class="header-progress" aria-live="polite"><span><small>Time</small><strong id="progress-elapsed">0:00</strong></span><span><small>Budget</small><strong id="progress-budget">—</strong></span></div>
</header>
<div id="auth-lost" class="auth-lost" hidden role="alert">
  <h2>Review authorization is unavailable</h2>
  <p>Open this review from its private Pi link. Refreshing the original review tab remains authorized for this server port.</p>
  <p>If the server was restarted or this tab was opened without its private link, run <code>/prompt resume</code> in Pi.</p>
</div>
<main id="plan-content" class="review-shell" tabindex="-1" hidden>
  <section class="prompt-card" aria-labelledby="prompt-heading">
    <div class="section-heading"><div><p class="eyebrow">Original prompt</p><h2 id="prompt-heading">What you asked Pi to plan</h2></div></div>
    <pre id="original-prompt" class="original-prompt"></pre>
  </section>

  <section id="live-progress" class="run-card" role="status" aria-live="polite" aria-label="Live planner thinking" hidden>
    <div class="run-heading"><div class="run-title"><span id="progress-spinner" class="progress-spinner" aria-hidden="true">◐</span><div><p class="eyebrow">Thinking</p><h2 id="progress-headline">Planning is starting</h2></div></div></div>
    <p id="progress-detail" class="progress-detail">Preparing the planning run.</p>
  </section>

  <div id="snapshot-error" class="snapshot-error" role="alert" aria-live="assertive" hidden></div>

  <section class="plan-section" aria-labelledby="generated-plan-heading">
    <div class="section-heading"><div><p class="eyebrow">Generated plan</p><h2 id="generated-plan-heading">Review and annotate</h2></div><span id="annotation-count" class="meta-pill">0 notes</span></div>
    <div id="plan-tree"></div>
  </section>

  <section id="notes-section" class="notes-section" aria-labelledby="notes-heading" hidden>
    <div class="section-heading compact"><div><p class="eyebrow">Feedback</p><h2 id="notes-heading">Notes</h2></div><fieldset id="filters" class="note-filters"><legend class="sr-only">Filter notes</legend></fieldset></div>
    <div id="annotation-list" class="notes-list"></div>
  </section>
</main>

<form id="selection-composer" class="selection-composer" hidden>
  <label for="selection-comment">Add a note to this selection</label>
  <textarea id="selection-comment" maxlength="8192" rows="3" placeholder="Change, remove, clarify…"></textarea>
  <div><button id="selection-cancel" type="button" class="quiet">Cancel</button><button type="submit" class="primary">Save note</button></div>
</form>

<footer id="action-bar" class="action-bar" hidden>
  <div><button id="reopen-button" class="quiet">Reopen in Pi</button><button id="pause-button" class="quiet">Pause</button><button id="cancel-button" class="danger quiet">Cancel plan</button></div>
  <div><button id="revise-button">Send notes to agent</button><button id="retry-stage-button" class="primary" hidden>Retry staging</button><button id="accept-button" class="primary">Accept plan</button></div>
</footer>
<dialog id="dialog" aria-labelledby="dialog-title" aria-describedby="dialog-body"><form method="dialog"><h2 id="dialog-title"></h2><p id="dialog-body"></p><div class="dialog-actions"><button value="cancel" class="quiet">Go back</button><button id="dialog-confirm" value="confirm" class="primary">Confirm</button></div></form></dialog>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
</body>
</html>`;
