import { describe, expect, it, vi } from 'vitest';
import { redis } from '@devvit/web/server';
import type { MenuItemRequest, T3, UiResponse } from '@devvit/web/shared';
import { createApp } from './app';
import { collectPostUrls, extractAllBodyUrls, formatSignature } from './adversarial-reviewer';
import {
  createModTest,
  expectAllEndpointsCovered,
  type FakeHttp,
  type FakeRedditWorld,
  type ScenarioRunner,
} from './test-harness';

// ─── Fake Reddit + Supabase ───────────────────────────────────────────────────

const SUPABASE_HOST = 'eimdgqymjwfljtapnuyl.supabase.co';
const SUPABASE = `https://${SUPABASE_HOST}`;
const PENDING_JOBS_KEY = 'bot:adversarial:pdfjobs';
const RETRY_QUEUE_KEY = 'bot:adversarial:retry-queue';
/** The requesting user in these tests. */
const REQUESTER = 'alice';

type FakePost = {
  id: T3;
  title: string;
  selftext?: string;
  url?: string;
  removed?: boolean;
  spam?: boolean;
  flair?: { templateId?: string };
};

type JobRow = { status: string; result: string | null; error: string | null };

/**
 * Seeds the requester (optionally a moderator) and fakes the Supabase REST API
 * on its declared domain: POST /rest/v1/review_jobs (configurable status),
 * GET review_jobs?post_id=eq.<id>, and bot_logs writes.
 */
function installReviewWorld(
  world: FakeRedditWorld,
  http: FakeHttp,
  opts: { isMod?: boolean } = {}
) {
  const jobs = new Map<string, JobRow>();
  let submitStatus = 201;
  if (opts.isMod) world.mod(REQUESTER);
  else world.user(REQUESTER);

  http.stub(SUPABASE_HOST, () => new Response(null, { status: 201 }), {
    path: '/rest/v1/bot_logs',
  });
  http.stub(SUPABASE_HOST, () => new Response(null, { status: submitStatus }), {
    path: '/rest/v1/review_jobs',
    method: 'POST',
  });
  http.stub(
    SUPABASE_HOST,
    (call) => {
      const id = new URL(call.url).searchParams.get('post_id')?.replace(/^eq\./, '') ?? '';
      const row = jobs.get(id);
      return Response.json(row ? [row] : []);
    },
    { path: '/rest/v1/review_jobs', method: 'GET' }
  );

  return {
    seed(post: FakePost) {
      const rec = world.seedPost({
        id: post.id,
        title: post.title,
        selftext: post.selftext,
        url: post.url ?? '',
        author: REQUESTER,
        flair: post.flair,
        removed: post.removed,
      });
      if (post.spam) rec.spam = true;
      if (post.removed) world.removedIds.add(post.id);
    },
    setJob(postId: string, row: JobRow) {
      jobs.set(postId, row);
    },
    failSubmissions(status: number) {
      submitStatus = status;
    },
    submissions: () =>
      http
        .callsTo(SUPABASE_HOST)
        .filter((c) => c.method === 'POST' && c.path === '/rest/v1/review_jobs')
        .map((c) => ({ url: c.url, method: c.method, body: c.json })),
  };
}

const test = createModTest({
  appFactory: createApp,
  settings: {
    adversarialReviewerEnabled: true,
    supabaseUrl: SUPABASE,
    supabaseServiceRoleKey: 'service-role',
    botSignature: 'I am a bot.',
  },
});

const request = (postId: T3): MenuItemRequest => ({ targetId: postId, location: 'post' });
const menu = (runner: ScenarioRunner, postId: T3) =>
  runner.as(REQUESTER).menu('adversarial-review', request(postId));
const toastText = (res: UiResponse): string | undefined =>
  typeof res.showToast === 'string' ? res.showToast : res.showToast?.text;
const pendingIds = async () =>
  (await redis.zRange(PENDING_JOBS_KEY, 0, -1)).map((e) => (typeof e === 'string' ? e : e.member));

// ─── Pure helpers ─────────────────────────────────────────────────────────────

describe('URL helpers', () => {
  it('extracts unique http(s) URLs from body text, stopping at markdown delimiters', () => {
    expect(
      extractAllBodyUrls(
        'See [paper](https://arxiv.org/abs/1234) and https://example.com/a.pdf, ' +
          'again https://arxiv.org/abs/1234 <https://x.org/y>'
      )
    ).toEqual(['https://arxiv.org/abs/1234', 'https://example.com/a.pdf,', 'https://x.org/y']);
  });

  it('puts a non-reddit link-post URL first and dedupes body links', () => {
    expect(
      collectPostUrls('https://zenodo.org/r/1', 'body https://zenodo.org/r/1 https://b.io')
    ).toEqual(['https://zenodo.org/r/1', 'https://b.io']);
  });

  it('ignores reddit.com link-post URLs', () => {
    expect(collectPostUrls('https://www.reddit.com/r/x/comments/abc', 'no links')).toEqual([]);
  });
});

describe('formatSignature', () => {
  it('returns empty for blank signatures', () => {
    expect(formatSignature(undefined)).toBe('');
    expect(formatSignature('   ')).toBe('');
  });

  it('superscripts each word after a rule', () => {
    expect(formatSignature(' I am a bot. ')).toBe('\n\n---\n\n^I ^am ^a ^bot.');
  });
});

// ─── Menu action ──────────────────────────────────────────────────────────────

describe('menu: request adversarial review', () => {
  test('is refused when the reviewer is disabled', async ({ world, http, runner, configure }) => {
    const fake = installReviewWorld(world, http);
    configure({ adversarialReviewerEnabled: false });
    fake.seed({ id: 't3_off', title: 'Theory', selftext: 'https://example.com/p.pdf' });

    const res = await menu(runner, 't3_off');

    expect(res.showToast).toEqual({
      text: 'Adversarial reviewer is disabled.',
      appearance: 'neutral',
    });
    expect(fake.submissions()).toHaveLength(0);
  });

  test('queues a Supabase job directly when the post has exactly one link', async ({
    world,
    http,
    runner,
  }) => {
    const fake = installReviewWorld(world, http);
    fake.seed({
      id: 't3_one',
      title: 'My TOE',
      selftext: 'Manuscript: https://example.com/toe.pdf',
    });

    const res = await menu(runner, 't3_one');

    expect(res.showToast).toEqual({
      text: 'Review request queued. Please wait.',
      appearance: 'neutral',
    });
    const [call] = fake.submissions();
    expect(call?.body).toEqual({
      post_id: 't3_one',
      pdf_url: 'https://example.com/toe.pdf',
      title: 'My TOE',
      body: 'Manuscript: https://example.com/toe.pdf',
      subreddit_name: 'testsub',
    });
    expect(await pendingIds()).toEqual(['t3_one']);
    expect(await redis.get('bot:adversarial:lock:t3_one')).toBe('1');
  });

  test('treats a 409 (job already exists) as queued', async ({ world, http, runner }) => {
    const fake = installReviewWorld(world, http);
    fake.failSubmissions(409);
    fake.seed({ id: 't3_dup', title: 'Dup', selftext: 'https://example.com/x.pdf' });

    const res = await menu(runner, 't3_dup');

    expect(toastText(res)).toBe('Review request queued. Please wait.');
    expect(await pendingIds()).toEqual(['t3_dup']);
  });

  test('allows only one review per post', async ({ world, http, runner }) => {
    const fake = installReviewWorld(world, http, { isMod: true });
    fake.seed({ id: 't3_once', title: 'Once', selftext: 'https://example.com/x.pdf' });

    await menu(runner, 't3_once');
    const second = await menu(runner, 't3_once');

    expect(toastText(second)).toBe('This post has already been reviewed.');
    expect(fake.submissions()).toHaveLength(1);
  });

  test('refuses removed posts and releases the post lock', async ({ world, http, runner }) => {
    const fake = installReviewWorld(world, http);
    fake.seed({ id: 't3_gone', title: 'Gone', selftext: '', removed: true });

    const res = await menu(runner, 't3_gone');

    expect(toastText(res)).toBe('Removed posts cannot be reviewed.');
    expect(await redis.get('bot:adversarial:lock:t3_gone')).toBeUndefined();
  });

  test('enforces the required flair when one is configured', async ({
    world,
    http,
    runner,
    configure,
  }) => {
    const fake = installReviewWorld(world, http);
    configure({ adversarialReviewerFlairId: 'flair-review' });
    fake.seed({
      id: 't3_noflair',
      title: 'A',
      selftext: 'https://a.io',
      flair: { templateId: 'other' },
    });
    fake.seed({
      id: 't3_flair',
      title: 'B',
      selftext: 'https://b.io',
      flair: { templateId: 'flair-review' },
    });

    const refused = await menu(runner, 't3_noflair');
    const allowed = await menu(runner, 't3_flair');

    expect(toastText(refused)).toBe('This post does not have the required flair for a review.');
    expect(await redis.get('bot:adversarial:lock:t3_noflair')).toBeUndefined();
    expect(toastText(allowed)).toBe('Review request queued. Please wait.');
  });

  test('limits non-moderators to one review request per UTC day', async ({
    world,
    http,
    runner,
  }) => {
    const fake = installReviewWorld(world, http);
    fake.seed({ id: 't3_q1', title: 'Q1', selftext: 'https://a.io' });
    fake.seed({ id: 't3_q2', title: 'Q2', selftext: 'https://b.io' });

    await menu(runner, 't3_q1');
    const second = await menu(runner, 't3_q2');

    expect(toastText(second)).toBe('You can only request one review per day.');
    expect(await redis.get('bot:adversarial:lock:t3_q2')).toBeUndefined();
    const day = new Date().toISOString().slice(0, 10);
    expect(await redis.get(`bot:adversarial:user:t2_alice:${day}`)).toBe('1');
  });

  test('exempts moderators from the daily quota', async ({ world, http, runner }) => {
    const fake = installReviewWorld(world, http, { isMod: true });
    fake.seed({ id: 't3_m1', title: 'M1', selftext: 'https://a.io' });
    fake.seed({ id: 't3_m2', title: 'M2', selftext: 'https://b.io' });

    await menu(runner, 't3_m1');
    const second = await menu(runner, 't3_m2');

    expect(toastText(second)).toBe('Review request queued. Please wait.');
  });

  test('falls back to the retry queue when Supabase rejects the job', async ({
    world,
    http,
    runner,
  }) => {
    const fake = installReviewWorld(world, http);
    fake.failSubmissions(503);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fake.seed({ id: 't3_down', title: 'Down', selftext: 'https://a.io/p.pdf' });

    const res = await menu(runner, 't3_down');

    expect(toastText(res)).toBe('Could not queue right now — will retry automatically.');
    expect(await pendingIds()).toEqual([]);
    const retry = await redis.zRange(RETRY_QUEUE_KEY, 0, -1);
    expect(retry).toHaveLength(1);
    const entry = JSON.parse(typeof retry[0] === 'string' ? retry[0] : retry[0]!.member);
    expect(entry).toMatchObject({ postId: 't3_down', pdfUrl: 'https://a.io/p.pdf', attempts: 1 });
  });
});

// ─── Forms ────────────────────────────────────────────────────────────────────

describe('forms', () => {
  test('no-link posts get a manuscript-URL form, then queue with the submitted URL', async ({
    world,
    http,
    runner,
  }) => {
    const fake = installReviewWorld(world, http);
    fake.seed({ id: 't3_text', title: 'Text only', selftext: 'Pure prose.' });

    const res = await menu(runner, 't3_text');
    expect(res.showForm?.name).toBe('adversarial-no-link');
    expect(fake.submissions()).toHaveLength(0);

    const submitted = await runner.as(REQUESTER).form('adversarial-no-link', {
      manuscriptUrl: '  https://zenodo.org/m.pdf  ',
    });

    expect(toastText(submitted)).toBe('Review request queued. Please wait.');
    expect(fake.submissions()[0]?.body).toMatchObject({
      post_id: 't3_text',
      pdf_url: 'https://zenodo.org/m.pdf',
    });
    expect(await redis.get('bot:adversarial:pending-form:t2_alice')).toBeUndefined();
  });

  test('a blank no-link form reviews the post text only', async ({ world, http, runner }) => {
    const fake = installReviewWorld(world, http);
    fake.seed({ id: 't3_blank', title: 'Blank', selftext: 'Prose.' });

    await menu(runner, 't3_blank');
    await runner.as(REQUESTER).form('adversarial-no-link', { manuscriptUrl: '' });

    expect(fake.submissions()[0]?.body).toMatchObject({ post_id: 't3_blank', pdf_url: null });
  });

  test('multi-link posts get a picker that includes Other and None', async ({
    world,
    http,
    runner,
  }) => {
    const fake = installReviewWorld(world, http);
    fake.seed({ id: 't3_multi', title: 'Multi', selftext: 'https://a.io/1 https://b.io/2' });

    const res = await menu(runner, 't3_multi');

    expect(res.showForm?.name).toBe('adversarial-multi-link');
    const select = res.showForm?.form.fields[0] as { options: { value: string }[] };
    expect(select.options.map((o) => o.value)).toEqual([
      'https://a.io/1',
      'https://b.io/2',
      'other',
      'none',
    ]);
  });

  for (const c of [
    {
      selectedUrl: ['https://b.io/2'] as string[] | string,
      customUrl: '',
      expected: 'https://b.io/2' as string | null,
    },
    { selectedUrl: ['other'], customUrl: ' https://c.io/3 ', expected: 'https://c.io/3' },
    { selectedUrl: ['none'], customUrl: '', expected: null },
    { selectedUrl: 'https://a.io/1', customUrl: '', expected: 'https://a.io/1' },
  ]) {
    test(`multi-link selection ${JSON.stringify(c.selectedUrl)} queues ${c.expected}`, async ({
      world,
      runner,
      http,
    }) => {
      const fake = installReviewWorld(world, http);
      fake.seed({ id: 't3_pick', title: 'Pick', selftext: 'https://a.io/1 https://b.io/2' });

      await menu(runner, 't3_pick');
      await runner.as(REQUESTER).form('adversarial-multi-link', {
        selectedUrl: c.selectedUrl,
        customUrl: c.customUrl,
      });

      expect(fake.submissions()[0]?.body).toMatchObject({
        post_id: 't3_pick',
        pdf_url: c.expected,
      });
    });
  }

  test('an expired form context is reported instead of queuing', async ({
    world,
    http,
    runner,
  }) => {
    const fake = installReviewWorld(world, http);

    const res = await runner
      .as(REQUESTER)
      .form('adversarial-no-link', { manuscriptUrl: 'https://a.io' });

    expect(toastText(res)).toBe('Form expired. Please try again.');
    expect(fake.submissions()).toHaveLength(0);
  });
});

// ─── Scheduler: pdf-review-poll ───────────────────────────────────────────────

describe('scheduler: pdf-review-poll', () => {
  const poll = async (runner: { runTask: (name: string) => Promise<unknown> }) =>
    (await runner.runTask('pdf-review-poll')) as Record<string, unknown>;

  test('does nothing without Supabase config', async ({ world, http, runner, configure }) => {
    installReviewWorld(world, http);
    configure({ supabaseUrl: '' });

    expect(await poll(runner)).toEqual({ status: 'no supabase config' });
  });

  test('posts a finished review with signature, distinguishes and locks it', async ({
    world,
    http,
    runner,
    configure,
  }) => {
    const fake = installReviewWorld(world, http);
    configure({
      adversarialReviewerLockComment: true,
      adversarialReviewerStickyComment: true,
    });
    fake.seed({ id: 't3_done', title: 'Done', selftext: '' });
    await redis.zAdd(PENDING_JOBS_KEY, { score: Date.now(), member: 't3_done' });
    fake.setJob('t3_done', { status: 'done', result: 'Major flaws found.', error: null });

    const res = await poll(runner);

    expect(res).toMatchObject({ status: 'ok', checked: 1 });
    const [comment] = world.commentsOn('t3_done');
    expect(comment?.body).toBe('Major flaws found.\n\n---\n\n^I ^am ^a ^bot.');
    expect(comment?.distinguished).toBe(true);
    expect(comment?.stickied).toBe(true);
    expect(comment?.locked).toBe(true);
    expect(await pendingIds()).toEqual([]);
  });

  test('leaves queued/processing jobs pending', async ({ world, http, runner }) => {
    const fake = installReviewWorld(world, http);
    await redis.zAdd(PENDING_JOBS_KEY, { score: Date.now(), member: 't3_wait' });
    fake.setJob('t3_wait', { status: 'processing', result: null, error: null });

    await poll(runner);

    expect(await pendingIds()).toEqual(['t3_wait']);
    expect(world.commentsOn('t3_wait')).toHaveLength(0);
  });

  test('drops failed jobs and releases the post lock so it can be re-requested', async ({
    world,
    http,
    runner,
  }) => {
    const fake = installReviewWorld(world, http);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await redis.set('bot:adversarial:lock:t3_fail', '1');
    await redis.zAdd(PENDING_JOBS_KEY, { score: Date.now(), member: 't3_fail' });
    fake.setJob('t3_fail', { status: 'failed', result: null, error: 'pdf unreadable' });

    await poll(runner);

    expect(await pendingIds()).toEqual([]);
    expect(await redis.get('bot:adversarial:lock:t3_fail')).toBeUndefined();
  });

  test('expires jobs older than one hour', async ({ world, http, runner }) => {
    installReviewWorld(world, http);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await redis.set('bot:adversarial:lock:t3_old', '1');
    await redis.zAdd(PENDING_JOBS_KEY, {
      score: Date.now() - 2 * 60 * 60 * 1000,
      member: 't3_old',
    });

    await poll(runner);

    expect(await pendingIds()).toEqual([]);
    expect(await redis.get('bot:adversarial:lock:t3_old')).toBeUndefined();
  });

  test('resubmits due retry-queue entries and moves them to pending', async ({
    world,
    http,
    runner,
  }) => {
    const fake = installReviewWorld(world, http);
    const member = JSON.stringify({
      postId: 't3_retry',
      title: 'Retry',
      body: 'b',
      subredditName: 'testsub',
      pdfUrl: null,
      attempts: 1,
    });
    await redis.zAdd(RETRY_QUEUE_KEY, { score: Date.now() - 1000, member });

    const res = await poll(runner);

    expect(res).toMatchObject({ retried: 1 });
    expect(fake.submissions()[0]?.body).toMatchObject({ post_id: 't3_retry', pdf_url: null });
    expect(await redis.zRange(RETRY_QUEUE_KEY, 0, -1)).toHaveLength(0);
    expect(await pendingIds()).toEqual(['t3_retry']);
  });

  test('backs off a still-failing retry with an incremented attempt count', async ({
    world,
    http,
    runner,
  }) => {
    const fake = installReviewWorld(world, http);
    fake.failSubmissions(500);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const member = JSON.stringify({
      postId: 't3_flaky',
      title: 'F',
      body: '',
      subredditName: 'testsub',
      pdfUrl: null,
      attempts: 1,
    });
    await redis.zAdd(RETRY_QUEUE_KEY, { score: Date.now() - 1000, member });

    await poll(runner);

    const retry = await redis.zRange(RETRY_QUEUE_KEY, 0, -1);
    expect(retry).toHaveLength(1);
    const entry = JSON.parse(typeof retry[0] === 'string' ? retry[0] : retry[0]!.member);
    expect(entry.attempts).toBe(2);
    const score = await redis.zScore(
      RETRY_QUEUE_KEY,
      typeof retry[0] === 'string' ? retry[0] : retry[0]!.member
    );
    expect(score).toBeGreaterThan(Date.now());
  });

  test('gives up after the max retry attempts and releases the post lock', async ({
    world,
    http,
    runner,
  }) => {
    const fake = installReviewWorld(world, http);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await redis.set('bot:adversarial:lock:t3_dead', '1');
    const member = JSON.stringify({
      postId: 't3_dead',
      title: 'D',
      body: '',
      subredditName: 'testsub',
      pdfUrl: null,
      attempts: 3,
    });
    await redis.zAdd(RETRY_QUEUE_KEY, { score: Date.now() - 1000, member });

    await poll(runner);

    expect(fake.submissions()).toHaveLength(0);
    expect(await redis.zRange(RETRY_QUEUE_KEY, 0, -1)).toHaveLength(0);
    expect(await redis.get('bot:adversarial:lock:t3_dead')).toBeUndefined();
  });
});

describe('end to end', () => {
  test('request from the post menu, worker finishes, the */5 poll posts the review', async ({
    world,
    http,
    runner,
    clock,
  }) => {
    const fake = installReviewWorld(world, http);
    clock.set('2026-11-25T12:01:00Z');
    await runner
      .scenario('adversarial review round trip')
      .given('alice has a post linking one manuscript', () =>
        fake.seed({ id: 't3_e2e', title: 'TOE', selftext: 'https://example.com/toe.pdf' })
      )
      .when('alice requests a review from the post menu', ({ runner: r }) =>
        r.as(REQUESTER).menu('adversarial-review', { location: 'post', targetId: 't3_e2e' })
      )
      .and('the Supabase worker finishes the job', () =>
        fake.setJob('t3_e2e', { status: 'done', result: 'Looks shaky.', error: null })
      )
      .and('five minutes pass', async ({ runner: r }) => {
        expect(await r.advance('5m')).toEqual(['pdf-review-poll']);
      })
      .then('the review is posted on the post', ({ world: w }) => {
        expect(w.commentsOn('t3_e2e')[0]?.body).toContain('Looks shaky.');
      })
      .run();
  });
});

// Keep last.
test('every devvit.json endpoint has a scenario', () => {
  expectAllEndpointsCovered();
});
