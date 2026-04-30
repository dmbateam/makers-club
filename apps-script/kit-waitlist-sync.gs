// Google Apps Script — auto-add Agentic Design waitlist form responses to Kit.
// Attach to the spreadsheet bound to the Google Form.
// Install:
//   1. Sheet → Extensions → Apps Script → paste this file.
//   2. Project Settings (gear) → Script Properties → add KIT_API_KEY.
//   3. Triggers (clock) → Add trigger: function `onFormSubmit`,
//      source "From spreadsheet", event "On form submit".
//   4. Run `testWithLatestRow` once to authorize + smoke-test.

const KIT_TAG_ID = '19052837'; // "community waitlist"

function onFormSubmit(e) {
  const firstName = String(e.values[1] || '').trim();
  const email = String((e.values[6] || e.values[2]) || '').trim().toLowerCase();

  if (!email || email.indexOf('@') === -1) {
    console.warn('Skipping — no valid email in row:', e.values);
    return;
  }

  const apiKey = PropertiesService.getScriptProperties().getProperty('KIT_API_KEY');
  if (!apiKey) throw new Error('KIT_API_KEY not set in Script Properties');

  // Kit requires 2 calls: create the subscriber first, then attach the tag.
  // POST /v4/tags/:id/subscribers returns 404 for emails Kit hasn't seen before.
  const post = function (path, body) {
    return UrlFetchApp.fetch('https://api.kit.com/v4/' + path, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Kit-Api-Key': apiKey },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
  };

  const create = post('subscribers', { email_address: email, first_name: firstName });
  const createCode = create.getResponseCode();
  if (createCode >= 400) {
    throw new Error('Kit /subscribers ' + createCode + ': ' + create.getContentText().slice(0, 500));
  }

  const tag = post('tags/' + KIT_TAG_ID + '/subscribers', { email_address: email });
  const tagCode = tag.getResponseCode();
  console.log('Kit create=' + createCode + ' tag=' + tagCode + ' for ' + email);
  if (tagCode >= 400) {
    throw new Error('Kit /tags/' + KIT_TAG_ID + '/subscribers ' + tagCode + ': ' +
                    tag.getContentText().slice(0, 500));
  }
}

// Manual smoke test — simulates onFormSubmit with the most recent sheet row.
function testWithLatestRow() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const lastRow = sheet.getLastRow();
  const values = sheet.getRange(lastRow, 1, 1, 7).getValues()[0];
  onFormSubmit({ values: values });
}

// Diagnostic — confirms the API key reaches the right Kit account
// and that KIT_TAG_ID matches a real tag. Run this if onFormSubmit is failing.
function diagnose() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('KIT_API_KEY');
  console.log('KIT_TAG_ID constant: ' + KIT_TAG_ID);
  console.log('KIT_API_KEY present: ' + Boolean(apiKey) +
              '  prefix=' + (apiKey ? apiKey.slice(0, 6) : 'null') +
              '  len=' + (apiKey ? apiKey.length : 0));

  const acct = UrlFetchApp.fetch('https://api.kit.com/v4/account', {
    headers: { 'X-Kit-Api-Key': apiKey || '' }, muteHttpExceptions: true,
  });
  console.log('GET /account -> ' + acct.getResponseCode() + ' ' + acct.getContentText().slice(0, 300));

  const tags = UrlFetchApp.fetch('https://api.kit.com/v4/tags', {
    headers: { 'X-Kit-Api-Key': apiKey || '' }, muteHttpExceptions: true,
  });
  console.log('GET /tags -> ' + tags.getResponseCode() + ' ' + tags.getContentText().slice(0, 800));
}
