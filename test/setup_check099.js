// First-open setup, App login and Start fresh in Chromium (Playwright),
// against the fresh instance the DOM launcher runs on :3458 (nodes and
// prices on the local stub, so nothing reaches a real service).
// Prints PASS/FAIL per check, then FAILURES: N; exits 0 when all pass.
'use strict';
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:3458/';
const failures = [];
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL'), '-', 'setup: ' + name, cond ? '' : '| ' + String(detail).slice(0, 200));
  if (!cond) failures.push(name);
}

(async () => {
  const browser = await chromium.launch();
  const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  const vis = (sel) => p.isVisible(sel);
  try {
    await p.goto(BASE); await p.waitForTimeout(1200);
    check('welcome shows on a fresh install, tabs hidden', await vis('#setup-welcome') && !(await vis('#tabs')));
    await p.click('#btn-setup-start'); await p.waitForTimeout(150);
    check('step 1 is the app password (choose one: none is set)', await vis('#setup-pw1') && !(await vis('#setup-password-env'))
      && (await p.textContent('#setup-stepno')) === 'Step 1 of 6', await p.textContent('#setup-stepno'));
    await p.fill('#setup-pw1', 'short'); await p.fill('#setup-pw2', 'short'); await p.click('#btn-setup-pw-set'); await p.waitForTimeout(150);
    check('a short password is refused', /at least 12/.test(await p.textContent('#setup-password-msg')));
    await p.click('#btn-setup-pw-skip'); await p.waitForTimeout(150);
    check('skipping shows the warning', await vis('#setup-skip-modal .modal'));
    await p.click('#btn-setup-skip-back'); await p.waitForTimeout(100);
    check('"Set a password" returns to the step', !(await vis('#setup-skip-modal .modal')) && await vis('#setup-pw1'));
    await p.click('#btn-setup-pw-skip'); await p.click('#btn-setup-skip-confirm'); await p.waitForTimeout(300);
    check('"Skip anyway" goes to the nodes step', await vis('#setup-nodes'));
    check('non-default nodes open on "Choose own nodes" with the node fields',
      await p.isChecked('#setup-nodes-own') && await vis('#setup-card #btc-primary-url'));
    await p.click('#btn-setup-nodes-save'); await p.waitForTimeout(400);
    check('saving goes to the price step', await vis('#setup-prices'));
    await p.click('#btn-setup-prices-own'); await p.waitForTimeout(150);
    check('"Choose other sources" shows the price selects', await vis('#setup-card #set-price-source1'));
    await p.selectOption('#set-price-source2', 'kraken');
    await p.click('#btn-setup-prices-save'); await p.waitForTimeout(400);
    check('the triggers page starts with every entry collapsed', await vis('#setup-checkin')
      && !(await p.$('#setup-checkin details[open]')) && !(await vis('#setup-checkin details p')));
    await p.click('#setup-checkin details:first-of-type summary'); await p.waitForTimeout(100);
    check('opening Check-in explains it', await vis('#setup-checkin details:first-of-type p')
      && /check in regularly/.test(await p.textContent('#setup-checkin details:first-of-type p')));
    await p.click('#btn-setup-checkin-next'); await p.waitForTimeout(150);
    check('first transaction step', await vis('#setup-tx'));
    await p.click('#btn-setup-tx-add'); await p.waitForTimeout(200);
    check('Add opens the add form over setup', await vis('#add-modal .modal'));
    await p.click('#btn-btc-add-cancel'); await p.waitForTimeout(300);
    await p.click('#btn-setup-tx-skip'); await p.waitForTimeout(200);
    check('done: the last page has the logo, the backup note and no summary rows',
      await vis('#setup-done .setup-done-logo img') && /encrypted backup/.test(await p.textContent('#setup-done'))
        && !(await p.$('#setup-summary')), await p.textContent('#setup-done'));
    await p.click('#btn-setup-finish'); await p.waitForTimeout(800);
    check('the dashboard after setup', await vis('#tabs') && !(await vis('#setup-card')));
    check('no check-in card without a check-in transaction', !(await vis('#checkin-card')));
    await p.reload(); await p.waitForTimeout(1000);
    check('setup does not return after a reload', !(await vis('#setup-card')));

    await p.goto(BASE + '#settings'); await p.waitForTimeout(800);
    check('the price choice was saved', (await p.inputValue('#set-price-source2')) === 'kraken');
    check('App login: the no-password notice', await vis('#login-card-none'));
    await p.fill('#login-new1', 'correct horse battery'); await p.fill('#login-new2', 'correct horse battery');
    await p.click('#btn-login-set'); await p.waitForTimeout(400);
    check('a password set in Settings', await vis('#login-card-app') && !/requires/.test(await p.textContent('#login-card-app')));
    await p.reload(); await p.waitForTimeout(1000);
    check('this browser stays logged in', !(await vis('#login-modal .modal')));
    await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(1000);
    check('the login screen without a session', await vis('#login-modal .modal'));
    await p.click('#login-forgot summary'); await p.waitForTimeout(100);
    check('"Forgot password?" shows the on-machine reset', /--reset-password/.test(await p.textContent('#login-forgot-body')));
    await p.fill('#login-password', 'correct horse battery'); await p.click('#btn-login'); await p.waitForTimeout(1200);
    check('logged in', !(await vis('#login-modal .modal')));

    await p.goto(BASE + '#settings'); await p.waitForTimeout(800);
    await p.fill('#login-cur', 'wrong password here'); await p.fill('#login-chg1', 'another long password'); await p.fill('#login-chg2', 'another long password');
    await p.click('#btn-login-change'); await p.waitForTimeout(400);
    check('a wrong current password is refused', /current password is wrong/.test(await p.textContent('#logout-msg')));
    await p.fill('#login-cur', 'correct horse battery'); await p.click('#btn-login-change'); await p.waitForTimeout(500);
    check('the password changed', /changed/.test(await p.textContent('#logout-msg')));
    check('the Start fresh card says the Standby password goes too',
      (await p.textContent('#fresh-login-note')) === 'Your Standby password is removed too, so setup asks for a new one.',
      await p.textContent('#fresh-login-note'));
    await p.click('#btn-fresh-delete'); await p.waitForTimeout(150);
    check('start fresh asks for the password', await vis('#fresh-password') && await vis('#fresh-backup-row'));
    await p.fill('#fresh-password', 'another long password'); await p.click('#btn-fresh-go'); await p.waitForTimeout(200);
    check('start fresh needs DELETE typed', /Type DELETE/.test(await p.textContent('#fresh-msg')));
    await p.fill('#fresh-confirm', 'DELETE'); await p.fill('#fresh-password', 'nope nope nope'); await p.click('#btn-fresh-go'); await p.waitForTimeout(400);
    check('a wrong password is refused', /wrong password/.test(await p.textContent('#fresh-msg')));
    await p.fill('#fresh-password', 'another long password'); await p.click('#btn-fresh-go'); await p.waitForTimeout(1500);
    check('after start fresh, setup runs again', await vis('#setup-welcome'));
    await p.click('#btn-setup-start'); await p.waitForTimeout(150);
    check('start fresh removed the password: setup asks for a new one', await vis('#setup-pw1') && !(await vis('#setup-password-done')));
    await p.fill('#setup-pw1', 'a brand new password'); await p.fill('#setup-pw2', 'a brand new password');
    await p.click('#btn-setup-pw-set'); await p.waitForTimeout(500);
    check('the new password is set from setup', await vis('#setup-nodes'));
    await p.click('#btn-setup-back'); await p.waitForTimeout(150);
    check('back on the password step it now says one is set', await vis('#setup-password-done'));
    await p.click('#btn-setup-back'); await p.click('#btn-setup-skip-all'); await p.waitForTimeout(800);
    check('skip setup with a password set goes straight to the dashboard', await vis('#tabs'));
    await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(1000);
    await p.fill('#login-password', 'a brand new password'); await p.click('#btn-login'); await p.waitForTimeout(1200);
    check('the new password logs in', !(await vis('#login-modal .modal')));
    check('no page errors', errs.length === 0, JSON.stringify(errs));
  } catch (e) {
    check('ran to the end', false, e.message);
  }
  await browser.close();
  console.log('FAILURES: ' + failures.length + (failures.length ? '' : ' (none)'));
  process.exit(failures.length ? 1 : 0);
})();
