import { describe, expect, it, vi } from 'vitest';
import { reddit, redis } from '@devvit/web/server';
import type { MenuItemRequest, T3, UiResponse } from '@devvit/web/shared';
import { createApp } from './app';
import { collectPostUrls, extractAllBodyUrls, formatSignature } from './adversarial-reviewer';
import { createModTest, type FakeRedditWorld } from './test-harness';

// ─── Fake Reddit + Supabase ───────────────────────────────────────────────────

const SUPABASE = 'https://supabase.test';
const PENDING_JOBS_KEY = 'bot:adversarial:pdfjobs';
const RETRY_QUEUE_KEY = 'bot:adversarial:retry-queue';

type FakePost = {
  id: T3;
  title: string;
  selftext?: string;
  url?: string;
  subredditName?: string;
  removed?: boolean;
  spam?: boolean;
  flair?: { templateId?: string };
};

type FetchCall = { url: string; method: string; body: unknown };
type JobRow = { status: string; result: string | null; error: string | null };

/**
 * Per-test fake for the Reddit calls `@devvit/test` leaves unimplemented
 * (getPostById details, getCurrentUser, getModerators) and for the Supabase
 * REST API, reached through a spied `fetch`. No network or Reddit login.
 */
function installReviewWorld(world: FakeRedditWorld, opts: { isMod?: boolean } = {}) {
  const posts = new Map<string, FakePost>();
  const calls: FetchCall[] = [];
  const jobs = new Map<string, JobRow>();
  let submitStatus = 201;

  vi.spyOn(reddit, 'getPostById').mockImplementation((async (id: T3) => {
    const post = posts.get(id);
    if (!post) throw new Error(`no post ${id}`);
    return {
      ...post,
      addComment: (options: { text: string }) => reddit.submitComment({ id: post.id, ...options }),
    };
  }) as unknown as typeof reddit.getPostById);

  vi.spyOn(reddit, 'getCurrentUser').mockResolvedValue({
    id: 't2_alice',
    username: 'alice',
  } as unknown as Awaited<ReturnType<typeof reddit.getCurrentUser>>);

  vi.spyOn(reddit, 'getModerators').mockImplementation((() => ({
    all: async () => (opts.isMod ? [{ username: 'alice' }] : []),
  })) as unknown as typeof reddit.getModerators);

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (!url.startsWith(SUPABASE)) throw new Error(`unexpected fetch ${url}`);
    if (method === 'POST' && url.endsWith('/rest/v1/review_jobs')) {
      return new Response(null, { status: submitStatus });
    }
    const match = /review_jobs\?post_id=eq\.([^&]+)/.exec(url);
    if (method === 'GET' && match) {
      const row = jobs.get(match[1]!);
      return Response.json(row ? [row] : []);
    }
    return new Response(null, { status: 404 });
  });

  return {
    seed(post: FakePost) {
      world.seedPost({ id: post.id, title: post.title, selftext: post.selftext });
      posts.set(post.id, { subredditName: 'testsub', ...post });
    },
    setJob(postId: string, row: JobRow) {
      jobs.set(postId, row);
    },
    failSubmissions(status: number) {
      submitStatus = status;
    },
    submissions: () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/review_jobs')),
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
const menu = (runner: { menu: (s: string, r: unknown) => Promise<UiResponse> }, postId: T3) =>
  runner.menu('adversarial-review', request(postId));
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
  test('is refused when the reviewer is disabled', async ({ world, runner, mocks }) => {
    const fake = installReviewWorld(world);
    mocks.settings.update({ adversarialReviewerEnabled: false });
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
    runner,
  }) => {
    const fake = installReviewWorld(world);
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

  test('treats a 409 (job already exists) as queued', async ({ world, runner }) => {
    const fake = installReviewWorld(world);
    fake.failSubmissions(409);
    fake.seed({ id: 't3_dup', title: 'Dup', selftext: 'https://example.com/x.pdf' });

    const res = await menu(runner, 't3_dup');

    expect(toastText(res)).toBe('Review request queued. Please wait.');
    expect(await pendingIds()).toEqual(['t3_dup']);
  });

  test('allows only one review per post', async ({ world, runner }) => {
    const fake = installReviewWorld(world, { isMod: true });
    fake.seed({ id: 't3_once', title: 'Once', selftext: 'https://example.com/x.pdf' });

    await menu(runner, 't3_once');
    const second = await menu(runner, 't3_once');

    expect(toastText(second)).toBe('This post has already been reviewed.');
    expect(fake.submissions()).toHaveLength(1);
  });

  test('refuses removed posts and releases the post lock', async ({ world, runner }) => {
    const fake = installReviewWorld(world);
    fake.seed({ id: 't3_gone', title: 'Gone', selftext: '', removed: true });

    const res = await menu(runner, 't3_gone');

    expect(toastText(res)).toBe('Removed posts cannot be reviewed.');
    expect(await redis.get('bot:adversarial:lock:t3_gone')).toBeUndefined();
  });

  test('enforces the required flair when one is configured', async ({ world, runner, mocks }) => {
    const fake = installReviewWorld(world);
    mocks.settings.update({ adversarialReviewerFlairId: 'flair-review' });
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

  test('limits non-moderators to one review request per UTC day', async ({ world, runner }) => {
    const fake = installReviewWorld(world);
    fake.seed({ id: 't3_q1', title: 'Q1', selftext: 'https://a.io' });
    fake.seed({ id: 't3_q2', title: 'Q2', selftext: 'https://b.io' });

    await menu(runner, 't3_q1');
    const second = await menu(runner, 't3_q2');

    expect(toastText(second)).toBe('You can only request one review per day.');
    expect(await redis.get('bot:adversarial:lock:t3_q2')).toBeUndefined();
    const day = new Date().toISOString().slice(0, 10);
    expect(await redis.get(`bot:adversarial:user:t2_alice:${day}`)).toBe('1');
  });

  test('exempts moderators from the daily quota', async ({ world, runner }) => {
    const fake = installReviewWorld(world, { isMod: true });
    fake.seed({ id: 't3_m1', title: 'M1', selftext: 'https://a.io' });
    fake.seed({ id: 't3_m2', title: 'M2', selftext: 'https://b.io' });

    await menu(runner, 't3_m1');
    const second = await menu(runner, 't3_m2');

    expect(toastText(second)).toBe('Review request queued. Please wait.');
  });

  test('falls back to the retry queue when Supabase rejects the job', async ({ world, runner }) => {
    const fake = installReviewWorld(world);
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
    runner,
  }) => {
    const fake = installReviewWorld(world);
    fake.seed({ id: 't3_text', title: 'Text only', selftext: 'Pure prose.' });

    const res = await menu(runner, 't3_text');
    expect(res.showForm?.name).toBe('adversarial-no-link');
    expect(fake.submissions()).toHaveLength(0);

    const submitted = await runner.form('adversarial-no-link', {
      manuscriptUrl: '  https://zenodo.org/m.pdf  ',
    });

    expect(toastText(submitted)).toBe('Review request queued. Please wait.');
    expect(fake.submissions()[0]?.body).toMatchObject({
      post_id: 't3_text',
      pdf_url: 'https://zenodo.org/m.pdf',
    });
    expect(await redis.get('bot:adversarial:pending-form:t2_alice')).toBeUndefined();
  });

  test('a blank no-link form reviews the post text only', async ({ world, runner }) => {
    const fake = installReviewWorld(world);
    fake.seed({ id: 't3_blank', title: 'Blank', selftext: 'Prose.' });

    await menu(runner, 't3_blank');
    await runner.form('adversarial-no-link', { manuscriptUrl: '' });

    expect(fake.submissions()[0]?.body).toMatchObject({ post_id: 't3_blank', pdf_url: null });
  });

  test('multi-link posts get a picker that includes Other and None', async ({ world, runner }) => {
    const fake = installReviewWorld(world);
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
    }) => {
      const fake = installReviewWorld(world);
      fake.seed({ id: 't3_pick', title: 'Pick', selftext: 'https://a.io/1 https://b.io/2' });

      await menu(runner, 't3_pick');
      await runner.form('adversarial-multi-link', {
        selectedUrl: c.selectedUrl,
        customUrl: c.customUrl,
      });

      expect(fake.submissions()[0]?.body).toMatchObject({
        post_id: 't3_pick',
        pdf_url: c.expected,
      });
    });
  }

  test('an expired form context is reported instead of queuing', async ({ world, runner }) => {
    const fake = installReviewWorld(world);

    const res = await runner.form('adversarial-no-link', { manuscriptUrl: 'https://a.io' });

    expect(toastText(res)).toBe('Form expired. Please try again.');
    expect(fake.submissions()).toHaveLength(0);
  });
});

// ─── Scheduler: pdf-review-poll ───────────────────────────────────────────────

describe('scheduler: pdf-review-poll', () => {
  const poll = (runner: { postJson: <T>(p: string, b: unknown) => Promise<T> }) =>
    runner.postJson<Record<string, unknown>>('/internal/scheduler/pdf-review-poll', {});

  test('does nothing without Supabase config', async ({ world, runner, mocks }) => {
    installReviewWorld(world);
    mocks.settings.update({ supabaseUrl: '' });

    expect(await poll(runner)).toEqual({ status: 'no supabase config' });
  });

  test('posts a finished review with signature, distinguishes and locks it', async ({
    world,
    runner,
    mocks,
  }) => {
    const fake = installReviewWorld(world);
    mocks.settings.update({
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

  test('leaves queued/processing jobs pending', async ({ world, runner }) => {
    const fake = installReviewWorld(world);
    await redis.zAdd(PENDING_JOBS_KEY, { score: Date.now(), member: 't3_wait' });
    fake.setJob('t3_wait', { status: 'processing', result: null, error: null });

    await poll(runner);

    expect(await pendingIds()).toEqual(['t3_wait']);
    expect(world.commentsOn('t3_wait')).toHaveLength(0);
  });

  test('drops failed jobs and releases the post lock so it can be re-requested', async ({
    world,
    runner,
  }) => {
    const fake = installReviewWorld(world);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await redis.set('bot:adversarial:lock:t3_fail', '1');
    await redis.zAdd(PENDING_JOBS_KEY, { score: Date.now(), member: 't3_fail' });
    fake.setJob('t3_fail', { status: 'failed', result: null, error: 'pdf unreadable' });

    await poll(runner);

    expect(await pendingIds()).toEqual([]);
    expect(await redis.get('bot:adversarial:lock:t3_fail')).toBeUndefined();
  });

  test('expires jobs older than one hour', async ({ world, runner }) => {
    installReviewWorld(world);
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

  test('resubmits due retry-queue entries and moves them to pending', async ({ world, runner }) => {
    const fake = installReviewWorld(world);
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
    runner,
  }) => {
    const fake = installReviewWorld(world);
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
    runner,
  }) => {
    const fake = installReviewWorld(world);
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
