import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { firstVisible, readConversationState, sendPrompt, waitForReply } from '../src/chat.js';

const executablePath = process.env.GPT_ACCOUNT_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const selectors = JSON.parse(fs.readFileSync(new URL('../config/selectors.json', import.meta.url)));

test('real DOM: input verification waits through the existing pre-send pause for editor updates', {
  skip: !fs.existsSync(executablePath), timeout: 20_000,
}, async t => {
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  await page.setContent(`<main id="turns"></main>
    <div id="prompt-textarea" contenteditable="true"></div>
    <button data-testid="send-button">Send</button>
    <script>
      window.submissions = [];
      const input = document.querySelector('#prompt-textarea');
      input.oninput = () => {
        const text = input.innerText;
        if (!text) return;
        input.innerText = '';
        setTimeout(() => { input.innerText = window.corrupt ? 'wrong prompt' : text; }, 100);
      };
      document.querySelector('button').onclick = () => {
        window.submissions.push(input.innerText);
        input.innerText = '';
        const n = window.submissions.length;
        turns.insertAdjacentHTML('beforeend', '<div data-message-author-role="user" data-message-id="u' + n + '">question</div><div data-message-author-role="assistant" data-message-id="a' + n + '"><div class="markdown">complete</div></div>');
      };
    </script>`);
  const prompt = 'C# async/await: MoveNext()\n\nPlease explain.';
  const timing = { pollMs: 50, fallbackStableMs: 100, timeoutMs: 2000 };
  assert.equal(await sendPrompt(page, selectors, prompt, timing), 'complete');
  const submissions = await page.evaluate(() => window.submissions);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].replace(/\s+/g, ' '), prompt.replace(/\s+/g, ' '));
  await page.evaluate(() => { window.corrupt = true; });
  await assert.rejects(sendPrompt(page, selectors, prompt, timing), error =>
    error.code === 'COMPOSER_INPUT_MISMATCH' && error.diagnostics.actualLength === 'wrong prompt'.length);
  assert.equal(await page.evaluate(() => window.submissions.length), 1, 'a genuine mismatch still must not submit');
});

test('real DOM: a submitted message survives a navigation slower than the click timeout', {
  skip: !fs.existsSync(executablePath), timeout: 25_000,
}, async t => {
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let submissions = 0;
  await page.exposeFunction('recordSubmission', () => { submissions++; });
  await page.route('**/*', async route => {
    if (route.request().url() !== 'https://fixture.invalid/pending') return route.abort();
    // Fulfilled locally. Navigation lasts longer than the 5 second click budget,
    // but the response still fits within the overall reply budget.
    await new Promise(resolve => setTimeout(resolve, 6000));
    await route.fulfill({ contentType: 'text/html', body: `<div data-message-author-role="user" data-message-id="u">question</div>
      <div data-message-author-role="assistant" data-message-id="a"><div class="markdown">complete</div></div>
      <div id="prompt-textarea" contenteditable="true"></div>` });
  });
  await page.setContent(`<main id="turns"></main>
    <div id="prompt-textarea" contenteditable="true"></div>
    <button data-testid="send-button">Send</button>
    <script>
      window.submissions = 0;
      document.querySelector('button').onclick = () => {
        window.submissions++;
        window.recordSubmission();
        document.querySelector('#prompt-textarea').innerText = '';
        turns.innerHTML = '<div data-message-author-role="user" data-message-id="u">question</div><div data-message-author-role="assistant" data-message-id="a"><div class="markdown">complete</div></div>';
        location.href = 'https://fixture.invalid/pending';
      };
    </script>`);
  assert.equal(await sendPrompt(page, selectors, 'question', {
    pollMs: 50, fallbackStableMs: 100, timeoutMs: 10_000,
  }), 'complete');
  assert.equal(submissions, 1, 'a slow navigation must not cause another submission');
});

test('real DOM: missing or hidden legacy composers do not delay a ready fallback', {
  skip: !fs.existsSync(executablePath), timeout: 20_000,
}, async t => {
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  await page.setContent(`<div contenteditable="true" role="textbox">Earlier generic candidate</div>
    <div id="prompt-textarea" contenteditable="true" hidden>Hidden legacy composer</div>
    <form data-chatgpt-composer>
      <div contenteditable="true" role="textbox" hidden>Hidden first match</div>
      <div id="ready" contenteditable="true" role="textbox">Ready</div>
    </form>`);
  for (const legacy of ['hidden', 'absent']) {
    if (legacy === 'absent') await page.locator('#prompt-textarea').evaluate(node => node.remove());
    const startedAt = performance.now();
    const composer = await firstVisible(page, selectors.composer, 15000);
    const elapsedMs = performance.now() - startedAt;
    assert.equal(await composer.getAttribute('id'), 'ready', 'preserve candidate priority and skip hidden matches');
    assert.ok(elapsedMs < 1500, `ready fallback must not wait for the old 3750 ms timeout: ${elapsedMs}`);
    t.diagnostic(`${legacy} legacy selector, ready fallback: ${Math.round(elapsedMs)} ms`);
  }
  const startedAt = performance.now();
  await assert.rejects(firstVisible(page, ['#missing-a', '#missing-b', '#missing-c'], 300), /Timeout/);
  assert.ok(performance.now() - startedAt < 1500, 'missing candidates share one timeout budget');
});

test('real DOM: nested role/article fallbacks, multiline input, hidden send buttons and streaming', {
  skip: !fs.existsSync(executablePath), timeout: 20_000,
}, async t => {
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  // Entirely local fixture; no accounts, profiles or ChatGPT requests.
  await page.route('**/*', route => route.abort());
  await page.setContent(`
    <section id="turns"><article data-turn="assistant"><section data-message-author-role="assistant" data-message-id="old"><div class="markdown">old answer</div></section></article></section>
    <div id="prompt-textarea" contenteditable="true">stale draft</div>
    <button data-testid="send-button" style="display:none">hidden</button>
    <button aria-label="Send prompt">Send</button>
    <button data-testid="stop-button" style="display:none">Stop</button>
    <script>
      window.submissions = [];
      const input = document.querySelector('#prompt-textarea');
      const stop = document.querySelector('[data-testid="stop-button"]');
      input.addEventListener('keydown', e => {
        if(e.key === 'Enter' && !e.shiftKey) window.submissions.push('premature enter');
      });
      document.querySelector('[aria-label="Send prompt"]').onclick = () => {
        window.submissions.push(input.innerText);
        input.innerText = '';
        const u = document.createElement('article'); u.dataset.turn = 'user'; u.dataset.turnId = 'new-user'; u.innerText = 'question'; turns.append(u);
        stop.style.display = '';
        const a = document.createElement('article'); a.dataset.turn = 'assistant'; a.dataset.turnId = 'new'; a.innerHTML = '<div class="markdown">partial</div>'; turns.append(a);
        setTimeout(() => { a.querySelector('.markdown').innerText = 'complete answer'; stop.style.display = 'none'; }, 180);
      };
    </script>`);
  const before = await readConversationState(page, selectors);
  assert.equal(before.replies.length, 1, 'nested article and role are one message');
  assert.equal(before.replies[0].id, 'old');
  const prompt = 'first line\n\nsecond line';
  const timing = {};
  const result = await sendPrompt(page, selectors, prompt, { pollMs: 50, stableMs: 100, fallbackStableMs: 150, timeoutMs: 3000, timing });
  assert.equal(result, 'complete answer');
  const submissions = await page.evaluate(() => window.submissions);
  assert.equal(submissions.length, 1, 'exactly one complete submission');
  assert.equal(submissions[0].replace(/\s+/g, ' '), prompt.replace(/\s+/g, ' '), 'all lines replace the stale draft');
  const after = await readConversationState(page, selectors);
  assert.equal(after.replies.at(-1).id, 'new');
  assert.equal(after.replies.at(-1).afterUser, true);
  assert.equal(timing.stage, 'completed');
  assert.ok(timing.preSendPauseMs >= 250 && timing.preSendPauseMs <= 900, 'human pause remains in use');
  assert.ok(timing.submitMs >= timing.preSendPauseMs);
  assert.ok(timing.firstReplyMs >= 0 && timing.firstReplyMs <= timing.replyWaitMs);
  assert.ok(timing.completionWaitMs >= 100);
  assert.ok(timing.domReads > 1);
  assert.equal(JSON.stringify(timing).includes('first line'), false, 'timings contain no message content');
});

test('real DOM: layoutless message wrappers retain visible content and exclude hidden branches', {
  skip: !fs.existsSync(executablePath), timeout: 20_000,
}, async t => {
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  await page.setContent(`
    <style>.contents { display: contents; }</style>
    <section data-turn="assistant" data-turn-id="old"><div class="markdown">old</div></section>
    <div id="turns"></div>
    <div id="prompt-textarea" contenteditable="true"></div>
  `);
  const before = await readConversationState(page, selectors);
  await page.locator('#turns').evaluate(node => {
    node.innerHTML = `
      <section data-turn="user" data-turn-id="question" class="contents"><span>Question</span></section>
      <section data-turn="assistant" class="contents">
        <div data-message-author-role="assistant" data-message-id="answer" class="contents">
          <div class="markdown">Visible answer</div>
          <div class="markdown" style="display:none">Hidden draft</div>
        </div>
      </section>
      <div style="display:none"><section data-turn="assistant" class="contents"><p>Hidden answer</p></section></div>
      <section data-turn="assistant" style="visibility:hidden"><p>Invisible answer</p></section>
    `;
  });
  const after = await readConversationState(page, selectors);
  assert.deepEqual(after.users.map(item => item.text), ['Question']);
  assert.equal(after.replies.length, 2, 'hidden branches excluded, nested candidates deduplicated');
  assert.equal(after.dom.rawAssistantCount, 5);
  assert.equal(after.dom.rawUserCount, 1);
  assert.equal(after.dom.layoutlessAssistantCount, 3);
  assert.deepEqual(after.replies.at(-1), { id: 'answer', text: 'Visible answer', afterUser: true, streaming: false });
  assert.equal(await waitForReply(page, selectors, before, {
    pollMs: 50, stableMs: 100, fallbackStableMs: 100, timeoutMs: 1000,
  }), 'Visible answer');
});

test('real DOM: display contents with direct text, inline children and hidden drafts', {
  skip: !fs.existsSync(executablePath), timeout: 20_000,
}, async t => {
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  await page.setContent(`<div data-message-author-role="user" style="display:contents">Question</div>
    <div data-message-author-role="assistant" style="display:contents">Hello <b>world</b><div>Next line</div><span hidden>Hidden draft</span></div>`);
  const snapshot = await readConversationState(page, selectors);
  assert.equal(snapshot.users.at(-1)?.text, 'Question');
  assert.equal(snapshot.replies.at(-1)?.text, 'Hello world\nNext line');
});

// Synthetic fixture using the publicly recorded September Chat/Work markers:
// https://github.com/steipete/oracle/issues/517
test('real DOM: Chat/Work grouped turns, role headings, new markdown and duplicate answer text', {
  skip: !fs.existsSync(executablePath), timeout: 30_000,
}, async t => {
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  await page.setContent(`<main id="turns"></main>
    <form data-chatgpt-composer>
      <div data-composer-markdown contenteditable="true" role="textbox"></div>
      <button type="button" data-testid="composer-send-button">Send</button>
      <button type="button" data-testid="composer-stop-button" hidden>Stop</button>
    </form>
    <button aria-label="Stop reading aloud">Read aloud control unrelated to generation</button>
    <script>
      window.submissions = [];
      const input = document.querySelector('[contenteditable]');
      const stop = document.querySelector('[data-testid="composer-stop-button"]');
      document.querySelector('[data-testid="composer-send-button"]').onclick = () => {
        window.submissions.push(input.innerText);
        input.innerText = '';
        stop.hidden = false;
        const n = window.submissions.length;
        const group = document.createElement('section');
        group.dataset.turnKey = 'turn-' + n;
        group.innerHTML = '<div data-content-search-unit-key="turn-' + n + ':0:user"><div data-user-message-bubble="true">same question</div></div>' +
          '<div data-content-search-unit-key="turn-' + n + ':1:analysis"><p>Thinking: not an answer</p></div>';
        turns.append(group);
        setTimeout(() => {
          group.insertAdjacentHTML('beforeend', '<div data-content-search-unit-key="turn-' + n + ':2:assistant" style="display:contents"><h4 data-conversation-role="assistant">ChatGPT said</h4><div data-markdown-text-style="assistant-message">Same answer</div><div data-markdown-text-style="assistant-message">Second paragraph</div></div><div class="turn-action-controls"><button>Copy</button></div>');
          stop.hidden = true;
        }, 120);
      };
    </script>`);
  const timing = { pollMs: 50, stableMs: 100, fallbackStableMs: 150, timeoutMs: 3000 };
  for (let i = 0; i < 2; i++) {
    const result = await sendPrompt(page, selectors, 'same question', timing);
    assert.equal(result, 'Same answer\nSecond paragraph');
  }
  const snapshot = await readConversationState(page, selectors);
  assert.equal(snapshot.users.length, 2);
  assert.equal(snapshot.replies.length, 2);
  const legacyOnly = await readConversationState(page, {
    ...selectors,
    assistantMessage: ["[data-message-author-role='assistant']", "article[data-turn='assistant']"],
    userMessage: ["[data-message-author-role='user']", "article[data-turn='user']"],
  });
  assert.equal(legacyOnly.users.length, 0, 'old selectors reproduce zero users on the new layout');
  assert.equal(legacyOnly.replies.length, 0, 'old selectors reproduce zero replies despite rendered answers');
  assert.notEqual(snapshot.users[0].id, snapshot.users[1].id);
  assert.notEqual(snapshot.replies[0].id, snapshot.replies[1].id);
  assert.equal(snapshot.replies[1].afterUser, true);
  assert.equal(snapshot.generating, false, 'read aloud is not answer generation');
  assert.equal(await page.evaluate(() => window.submissions.length), 2);
  // Historical body reads are unnecessary while polling the next reply. Make
  // them fail loudly so this checks the work avoided, not just output shape.
  await page.evaluate(() => {
    const old = document.querySelector('[data-turn-key]');
    for (const node of old.querySelectorAll('[data-user-message-bubble], [data-markdown-text-style]')) {
      Object.defineProperty(node, 'innerText', { get() { throw new Error('historical body reread'); } });
    }
  });
  const compact = await readConversationState(page, selectors, { latestOnly: true });
  assert.deepEqual(compact.users, snapshot.users.slice(-1));
  assert.deepEqual(compact.replies, snapshot.replies.slice(-1));
  assert.equal(compact.assistantCount, 2);
  assert.equal(compact.userCount, 2);
  assert.equal(compact.generating, snapshot.generating);
  assert.deepEqual(compact.dom, snapshot.dom);
});

test('real DOM: role heading identifies a search unit, never becomes the answer itself', {
  skip: !fs.existsSync(executablePath), timeout: 20_000,
}, async t => {
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  await page.setContent(`<section data-turn-key="group">
    <div data-chatgpt-search-unit-key="group:0:user"><div data-user-message-bubble="true">Question</div></div>
    <div data-content-search-unit-key="opaque-final-key"><header><h4 data-conversation-role="assistant">ChatGPT said</h4></header>
      <section><div data-markdown-text-style="assistant-message">The answer</div></section>
    </div></section>`);
  const snapshot = await readConversationState(page, selectors);
  assert.equal(snapshot.replies.at(-1)?.text, 'The answer');
  assert.equal(snapshot.replies.at(-1)?.id, 'opaque-final-key');
  assert.equal(snapshot.users.at(-1)?.id, 'group:0:user');
  await page.locator('[data-markdown-text-style]').evaluate(node => node.remove());
  const headingOnly = await readConversationState(page, selectors);
  assert.equal(headingOnly.replies.at(-1)?.text, '', 'a role heading alone is not a completed answer');
  await page.locator('[data-content-search-unit-key]').evaluate(node => {
    node.setAttribute('data-content-search-unit-key', 'group:2:assistant');
    node.setAttribute('data-markdown-text-style', 'assistant-message');
    node.innerText = 'Answer on the unit itself';
  });
  const mergedRoot = await readConversationState(page, selectors);
  assert.equal(mergedRoot.replies.at(-1)?.text, 'Answer on the unit itself');
});
