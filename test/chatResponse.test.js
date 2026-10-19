import test from 'node:test';
import assert from 'node:assert/strict';
import { readConversationState, waitForReply } from '../src/chat.js';

const state = (patch = {}) => ({ replies: [], users: [], generating: false, composerText: '', loginRequired: false, error: null, ...patch });
const reply = (text, id = 'new') => ({ id, text, afterUser: true });
const user = { id: 'new-user', text: 'question' };
const options = { pollMs: 500, timeoutMs: 180_000, acknowledgementMs: 15_000 };
function pageAt(getState) {
  let elapsed = 0;
  return { evaluate: async () => getState(elapsed), waitForTimeout: async ms => { elapsed += ms; }, elapsed: () => elapsed };
}

test('slow first reply remains valid after the old 20 second node deadline', async () => {
  const page = pageAt(ms => state({ users: [user], generating: ms < 60_000,
    replies: ms >= 55_000 ? [reply('completed')] : [] }));
  assert.equal(await waitForReply(page, {}, state(), options), 'completed');
  assert.ok(page.elapsed() >= 63_000);
});

test('old stable reply and a submitted user message never count as a new reply', async () => {
  const before = state({ replies: [reply('old', 'old')] });
  const page = pageAt(() => state({ users: [user], replies: [reply('old', 'old')] }));
  await assert.rejects(waitForReply(page, {}, before, options), e => e.code === 'REPLY_NOT_FOUND' && e.diagnostics.accepted);
});

test('React remount with the same message id is not a new response', async () => {
  const before = state({ replies: [reply('old', 'old')] });
  const page = pageAt(() => state({ replies: [{ ...before.replies[0] }] }));
  await assert.rejects(waitForReply(page, {}, before, options), e => e.code === 'MESSAGE_NOT_SUBMITTED');
});

test('no stop button: only a fresh reply stable for five seconds completes', async () => {
  const page = pageAt(ms => state({ users: [user], replies: [reply(ms < 2000 ? 'partial' : 'final')] }));
  assert.equal(await waitForReply(page, {}, state(), options), 'final');
  assert.ok(page.elapsed() >= 7000);
});

test('stable partial text while generating must time out, never succeed', async () => {
  const page = pageAt(() => state({ users: [user], generating: true, replies: [reply('partial')] }));
  await assert.rejects(waitForReply(page, {}, state(), options), e => e.code === 'RESPONSE_TIMEOUT');
});

test('a missing acknowledgement is distinct from a missing response', async () => {
  const page = pageAt(() => state({ composerText: 'question' }));
  await assert.rejects(waitForReply(page, {}, state(), options), e => e.code === 'MESSAGE_NOT_SUBMITTED' && !e.diagnostics.accepted);
  assert.equal(page.elapsed(), 15_000);
});

test('login required during generation immediately reports reauthentication', async () => {
  const page = pageAt(() => state({ users: [user], loginRequired: true }));
  await assert.rejects(waitForReply(page, {}, state(), options), e => e.code === 'LOGIN_REQUIRED' && e.needReauth);
});

test('a page error preserves the actual failure instead of reporting missing DOM', async () => {
  const page = pageAt(() => state({ error: 'Too many requests' }));
  await assert.rejects(waitForReply(page, {}, state(), options), e => e.code === 'CHAT_PAGE_ERROR' && /Too many requests/.test(e.message));
});

test('cancellation interrupts an in-flight page read', async () => {
  const controller = new AbortController();
  const page = { evaluate: () => new Promise(() => {}) };
  const work = waitForReply(page, {}, state(), { ...options, signal: controller.signal });
  controller.abort('test cancellation');
  await assert.rejects(work, e => e.code === 'CANCELLED');
});

test('identical reply text with new message ids and virtualized old nodes is accepted', async () => {
  const before = state({ replies: [reply('same answer', 'old')], users: [{ id: 'old-user', text: 'question' }] });
  const page = pageAt(() => state({ users: [user], replies: [reply('same answer')] }));
  assert.equal(await waitForReply(page, {}, before, options), 'same answer');
});

test('a newly rendered historical reply before this user turn cannot complete the run', async () => {
  const page = pageAt(() => state({ users: [user], replies: [{ ...reply('old visible again'), afterUser: false }] }));
  await assert.rejects(waitForReply(page, {}, state(), options), e => e.code === 'REPLY_NOT_FOUND');
});

test('a timeout not divisible by the polling interval still throws', async () => {
  const page = pageAt(() => state({ users: [user] }));
  await assert.rejects(waitForReply(page, {}, state(), { ...options, timeoutMs: 751 }), e => e.code === 'REPLY_NOT_FOUND');
});

test('a frozen page read has a deadline and does not leave the account waiting forever', async () => {
  let calls = 0;
  const page = { evaluate: () => { calls++; return new Promise(() => {}); } };
  await assert.rejects(waitForReply(page, {}, state(), { ...options, readTimeoutMs: 20 }),
    e => e.code === 'PAGE_READ_TIMEOUT' && e.diagnostics.stage === 'reading-page');
  assert.equal(calls, 1, 'no accumulating reads against the frozen renderer');
});

test('closed pages fail before any DOM access', async () => {
  await assert.rejects(readConversationState({ isClosed: () => true, evaluate: () => assert.fail('closed page read') }, {}),
    e => e.code === 'PAGE_CLOSED');
});

test('timeout retains structural diagnostics without copying message text', async () => {
  const dom = { rawAssistantCount: 3, rawUserCount: 2, markdownCount: 0, turnCount: 2 };
  const page = pageAt(() => state({ users: [user], dom }));
  await assert.rejects(waitForReply(page, {}, state(), { ...options, timeoutMs: 500 }), e => {
    assert.deepEqual(e.diagnostics.dom, dom);
    assert.equal(JSON.stringify(e.diagnostics).includes('question'), false);
    return e.code === 'REPLY_NOT_FOUND';
  });
});

test('compact polling preserves total message counts in failure diagnostics', async () => {
  const page = pageAt(() => state({ users: [user], assistantCount: 12, userCount: 13 }));
  await assert.rejects(waitForReply(page, {}, state(), { ...options, timeoutMs: 500 }), e => {
    assert.equal(e.diagnostics.assistantCount, 12);
    assert.equal(e.diagnostics.userCount, 13);
    return e.code === 'REPLY_NOT_FOUND';
  });
});

test('completion stability includes time spent reading a slow renderer', async t => {
  let now = 0;
  let reads = 0;
  t.mock.method(Date, 'now', () => now);
  const page = {
    async evaluate() {
      now += 2000;
      reads++;
      return state({ users: [user], generating: reads === 1, replies: [reply('complete')] });
    },
    async waitForTimeout(ms) { now += ms; },
  };
  const timing = {};
  assert.equal(await waitForReply(page, {}, state(), { ...options, timing }), 'complete');
  assert.equal(reads, 4, 'two equal idle samples 5 seconds apart already satisfy the 3 second stability requirement');
  assert.equal(timing.completionWaitMs, 5000);
});

test('reply deadline is checked before starting another DOM read', async t => {
  let now = 0;
  let reads = 0;
  t.mock.method(Date, 'now', () => now);
  const page = {
    evaluate() {
      reads++;
      return reads === 1 ? Promise.resolve(state({ users: [user] })) : new Promise(() => {});
    },
    async waitForTimeout(ms) { now += ms + 100; },
  };
  await assert.rejects(waitForReply(page, {}, state(), { ...options, pollMs: 100, timeoutMs: 150 }),
    e => e.code === 'REPLY_NOT_FOUND' && e.diagnostics.elapsedMs >= 150);
  assert.equal(reads, 1, 'an exhausted reply budget must not start a 1 ms read and misreport a frozen page');
});

test('remaining reply budget expiring during a read retains the response timeout reason', async t => {
  let now = 0;
  let reads = 0;
  t.mock.method(Date, 'now', () => now);
  const page = {
    evaluate() {
      reads++;
      if (reads === 1) return Promise.resolve(state({ users: [user], generating: true, replies: [reply('partial')] }));
      now = 60;
      return new Promise(() => {});
    },
    async waitForTimeout(ms) { now += ms; },
  };
  await assert.rejects(waitForReply(page, {}, state(), { ...options, pollMs: 50, timeoutMs: 60, readTimeoutMs: 1000 }),
    e => e.code === 'RESPONSE_TIMEOUT' && e.diagnostics.replyLength === 7);
  assert.equal(reads, 2, 'do not retry an outstanding page read');
});

test('a slow read during generation uses the remaining reply budget instead of a separate 10 second cutoff', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let resolveRead;
  let reads = 0;
  const page = {
    evaluate() {
      reads++;
      if (reads === 1) return Promise.resolve(state({ users: [user], generating: true }));
      if (reads === 2) return new Promise(resolve => { resolveRead = resolve; });
      return Promise.resolve(state({ users: [user], replies: [reply('complete')] }));
    },
    waitForTimeout(ms) { return new Promise(resolve => setTimeout(resolve, ms)); },
  };
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const work = waitForReply(page, {}, state(), options);
  // Attach both handlers before ticking to avoid unhandled rejection noise on
  // the old implementation, whose short read deadline rejects at 10 seconds.
  let outcome;
  work.then(value => { outcome = { value }; }, error => { outcome = { error }; });
  await flush();
  t.mock.timers.tick(500); await flush();
  assert.equal(reads, 2);
  t.mock.timers.tick(12_000); await flush();
  assert.equal(outcome, undefined, 'the response is still within its 180 second budget');
  resolveRead(state({ users: [user], replies: [reply('complete')] }));
  await flush();
  for (let i = 0; i < 7; i++) { t.mock.timers.tick(500); await flush(); }
  assert.equal(await work, 'complete');
});

test('a permanently blocked read still ends at the reply budget without accumulating reads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let reads = 0;
  const page = {
    evaluate() {
      reads++;
      return reads === 1
        ? Promise.resolve(state({ users: [user], generating: true, replies: [reply('partial')] }))
        : new Promise(() => {});
    },
    waitForTimeout(ms) { return new Promise(resolve => setTimeout(resolve, ms)); },
  };
  const work = waitForReply(page, {}, state(), options);
  const rejected = assert.rejects(work, error => error.code === 'RESPONSE_TIMEOUT' && error.diagnostics.replyLength === 7);
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  await flush();
  t.mock.timers.tick(500); await flush();
  t.mock.timers.tick(180_000); await flush();
  await rejected;
  assert.equal(reads, 2);
});

test('repeated navigation interruptions remain bounded and other read failures are not retried', async () => {
  let navigations = 0;
  const navigating = pageAt(() => { navigations++; throw new Error('Execution context was destroyed, most likely because of a navigation'); });
  await assert.rejects(waitForReply(navigating, {}, state(), { ...options, timeoutMs: 1500 }),
    error => error.code === 'MESSAGE_NOT_SUBMITTED');
  assert.equal(navigations, 3);
  let reads = 0;
  const broken = pageAt(() => { reads++; throw new Error('unrelated evaluation error'); });
  await assert.rejects(waitForReply(broken, {}, state(), options), /unrelated evaluation error/);
  assert.equal(reads, 1);
});
