// The synthetic defect fixture. fixtures/account-form.html wraps this same form so both stay in step.
export const FIXTURE_HTML = `<form id="synthetic-account" aria-labelledby="account-heading">
  <h2 id="account-heading">Create a synthetic test account</h2>
  <label for="display-name">Display name</label>
  <input id="display-name" name="displayName" required>
  <input id="email" name="email" type="email" required autocomplete="email" aria-describedby="email-error">
  <label for="password">Test password</label>
  <input id="password" name="password" type="password" required autocomplete="new-password">
  <p id="email-error">Enter a test email address.</p>
  <div>
    <span>Contact preference</span>
    <input id="contact-email" type="radio" name="contact"><label for="contact-email">Email</label>
    <input id="contact-phone" type="radio" name="contact"><label for="contact-phone">Phone</label>
  </div>
  <button type="submit">Create test account</button>
</form>`;
