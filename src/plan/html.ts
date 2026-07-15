export const PLAN_REVIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plan review · Plan → Adversarial Review → To Spec · Pi Prompt</title>
<link rel="stylesheet" href="/browser/styles.css">
<script type="module" src="/browser/app.js"></script>
</head>
<body>
<a class="skip-link" href="#stage-content">Skip to current stage</a>
<header class="app-header">
  <div class="brand"><span class="brand-mark" aria-hidden="true">π</span><div><p>Pi Prompt</p><h1>Plan workflow</h1></div></div>
  <div class="header-progress" aria-live="polite"><span><small>Time</small><strong id="progress-elapsed">0:00</strong></span><span><small>Budget</small><strong id="progress-budget">—</strong></span></div>
</header>
<div id="auth-lost" class="auth-lost" hidden role="alert"><h2>Review authorization is unavailable</h2><p>Open this review from its private Pi link. Refreshing the original review tab remains authorized for this server port.</p><p>If the server was restarted or this tab was opened without its private link, run <code>/prompt resume</code> in Pi.</p></div>
<main id="plan-content" class="review-shell" tabindex="-1" hidden>
  <nav class="stage-nav" aria-label="Plan workflow stages">
    <ol>
      <li><button id="stage-plan" type="button" data-stage="plan" aria-current="step"><span class="stage-number">1</span><span><strong>Plan</strong><small id="stage-plan-state">Current</small></span></button></li>
      <li aria-hidden="true" class="stage-arrow">→</li>
      <li><button id="stage-grill" type="button" data-stage="grill" disabled><span class="stage-number">2</span><span><strong>Adversarial Review</strong><small id="stage-grill-state">Unavailable</small></span></button></li>
      <li aria-hidden="true" class="stage-arrow">→</li>
      <li><button id="stage-spec" type="button" data-stage="spec" disabled><span class="stage-number">3</span><span><strong>To Spec</strong><small id="stage-spec-state">Unavailable</small></span></button></li>
    </ol>
  </nav>

  <section class="prompt-card" aria-labelledby="prompt-heading"><div class="section-heading"><div><p class="eyebrow">Original prompt</p><h2 id="prompt-heading">What you asked Pi to plan</h2></div><span id="plan-context" class="meta-pill"></span></div><pre id="original-prompt" class="original-prompt"></pre></section>
  <section id="live-progress" class="run-card" role="status" aria-live="polite" aria-label="Current stage activity" hidden><div class="run-heading"><div class="run-title"><span id="progress-spinner" class="progress-spinner" aria-hidden="true">◐</span><div><p id="progress-eyebrow" class="eyebrow">Thinking</p><h2 id="progress-headline">Planning is starting</h2></div></div></div><p id="progress-detail" class="progress-detail">Preparing the planning run.</p></section>
  <div id="snapshot-error" class="snapshot-error" role="alert" aria-live="assertive" hidden></div>
  <section id="clarification-section" class="clarification-section" aria-labelledby="clarification-heading" hidden><div class="section-heading"><div><p class="eyebrow">Clarification</p><h2 id="clarification-heading">A few choices before planning continues</h2></div></div><form id="clarification-form" novalidate><div id="clarification-questions"></div><div id="clarification-error" class="form-error" role="alert" hidden></div><button id="clarification-submit" type="submit" class="primary">Continue planning</button></form></section>

  <section id="stage-content" class="plan-section" aria-labelledby="stage-heading" tabindex="-1">
    <div class="section-heading"><div><p id="stage-eyebrow" class="eyebrow">Durable original</p><h2 id="stage-heading">Plan · Review and annotate</h2><p id="stage-description" class="stage-description">Your selected-text comments stay attached to this Plan revision.</p></div><span id="annotation-count" class="meta-pill">0 comments</span></div>
    <section id="grill-feedback-controls" class="grill-feedback-controls" aria-labelledby="grill-feedback-heading" hidden>
      <div class="grill-feedback-heading"><div><h3 id="grill-feedback-heading">Choose feedback to address</h3><p id="grill-selection-count" role="status" aria-live="polite">0 of 0 open findings selected</p></div><div class="grill-bulk-actions"><button id="grill-select-all" type="button" class="quiet">Select all open feedback</button><button id="grill-clear-selection" type="button" class="quiet">Clear selection</button></div></div>
      <label for="grill-revision-instruction">Optional instruction</label><textarea id="grill-revision-instruction" maxlength="16384" rows="2" placeholder="Add a modest direction for this revision…"></textarea>
      <button id="address-grill-feedback" type="button" class="primary">Address selected feedback</button>
    </section>
    <div id="document-surface" class="document-surface" aria-busy="false"><div id="plan-tree"></div><div id="spec-tree" hidden></div><div id="agent-work-overlay" class="agent-work-overlay" role="status" aria-live="polite" hidden><div class="agent-work-status"><span class="agent-work-spinner" aria-hidden="true"></span><strong id="agent-work-label">Agent working…</strong></div></div></div>
  </section>
</main>

<form id="selection-composer" class="selection-composer" hidden>
  <p id="selection-provenance" class="composer-provenance">Your comment</p>
  <label id="selection-label" for="selection-comment">Add a comment to this selection</label>
  <textarea id="selection-comment" maxlength="8192" rows="5" placeholder="Change, remove, clarify…"></textarea>
  <label id="selection-revision-label" class="select-note" hidden><input id="selection-revision" type="checkbox"> <span id="selection-revision-text">Include in next revision</span></label>
  <div class="composer-actions"><button id="selection-status" type="button" class="quiet" hidden>Dismiss</button><button id="selection-cancel" type="button" class="quiet">Close</button><button id="selection-save" type="submit" class="primary">Save comment</button></div>
</form>

<footer id="action-bar" class="action-bar" hidden>
  <div id="plan-lifecycle-actions"><button id="reopen-button" type="button" class="quiet">Reopen in Pi</button><button id="pause-button" type="button" class="quiet">Pause Plan</button><button id="cancel-button" type="button" class="danger quiet">Cancel Plan</button></div>
  <div id="plan-stage-actions"><button id="retry-generation-button" type="button" class="primary" hidden>Retry Plan generation</button><button id="revise-button" type="button">Revise Plan from comments</button><button id="run-grill-button" type="button" class="primary">Run Adversarial Review</button><button id="to-spec-button" type="button" class="primary" hidden>Continue to To Spec</button></div>
  <div id="spec-stage-actions" hidden><button id="spec-pause-button" type="button" class="quiet">Pause Spec</button><button id="spec-cancel-button" type="button" class="danger quiet">Cancel Spec</button><button id="spec-generate-button" type="button">Generate Spec</button><button id="spec-revise-button" type="button">Revise Spec from comments</button><button id="spec-retry-stage-button" type="button" class="primary" hidden>Retry Spec send</button><button id="spec-accept-button" type="button" class="primary">Accept &amp; send Spec</button></div>
</footer>
<dialog id="dialog" aria-labelledby="dialog-title" aria-describedby="dialog-body"><form method="dialog"><h2 id="dialog-title"></h2><p id="dialog-body"></p><div class="dialog-actions"><button value="cancel" class="quiet">Go back</button><button id="dialog-confirm" value="confirm" class="primary">Confirm</button></div></form></dialog>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
</body>
</html>`;
