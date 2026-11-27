# Adversarial Review

**Rigorous, LLM-powered physics critiques—posted right on your Reddit thread.**

A [Reddit Devvit](https://developers.reddit.com/docs) app for communities that want fast, structured peer-style feedback on physics posts and linked manuscripts. Readers request a review from the post menu; the bot queues the work and replies with a **distinguished comment** when the review is ready.

<!-- SCREENSHOT: Post menu open on a physics discussion post, with "Request Adversarial LLM Review" highlighted -->

> 📸 Screenshot coming soon: post menu with **Request Adversarial LLM Review** on a community post

<!-- SCREENSHOT: A finished adversarial review comment under a post, with markdown headers and the bot signature -->

> 📸 Screenshot coming soon: completed review comment (distinguished) under an OP's post

## What it does

- Adds a **post menu** action: **Request Adversarial LLM Review**
- Reads your post (and an optional manuscript link), runs an adversarial physics review, and **posts the result as a comment**
- Handles **DOI, Zenodo, and landing-page links** when a PDF is available; otherwise reviews **post text only**
- **One review per post** for seven days, with sensible limits so the queue stays fair
- **Moderators** control whether the feature is on, which flair qualifies, and how the bot's comment appears

## Key features

- **Post-menu review requests** — any eligible user can ask for a critique from the thread itself
- **Smart link handling** — one link queues automatically; multiple links open a short picker; no links open an optional manuscript URL field
- **Fair-use gates** — disabled when turned off; blocked on removed/spam posts; optional required post flair
- **Daily limit for non-moderators** — one request per user per UTC day (moderators are exempt; **r/llmphysics_dev** skips the daily cap for testing)
- **Async processing** — you get a toast when the job is queued; the comment appears when processing finishes (the app checks for results every five minutes)
- **Moderator polish** — optional sticky and lock on the review comment; customizable bot signature on every reply

## Install the app on your subreddit

This app is published on Reddit's Devvit platform as **`adversarial-review`**. A subreddit **moderator** installs Devvit apps through Reddit's **moderator tools** and **app management** for the community (see [Reddit's Devvit documentation](https://developers.reddit.com/docs) for the current install flow).

After install:

1. Open the app's **subreddit settings** for your community.
2. Turn on **Adversarial Reviewer — Enable** (off by default).
3. Adjust the other subreddit settings below if you want stricter rules or different comment behavior.

> **Note:** **Global** app settings (for example, the Supabase project URL) are configured by whoever operates the hosted app instance, in Devvit’s **global** app settings—not in the subreddit toggles above.

## For moderators — subreddit settings

| Setting | What it does |
| --- | --- |
| **Adversarial Reviewer — Enable** | Master switch. When off, users see *Adversarial reviewer is disabled.* |
| **Adversarial Reviewer — Required flair template ID** | If set, only posts with that flair can request a review. Leave blank to allow any flair. |
| **Adversarial Reviewer — Sticky review comment** | Pin the review comment to the top of the post after it is posted. |
| **Adversarial Reviewer — Lock review comment** | Lock the review comment after posting. |
| **Bot signature** | Text appended to every bot comment (small-print style). Default: *I am a bot. This action was performed automatically. Contact the moderators if you have questions.* Leave blank for no signature. |

## For users — how to request a review

1. Open a post in a subreddit where the app is **enabled**.
2. Open the post **⋯ menu** and choose **Request Adversarial LLM Review**.
3. Follow any prompts, then wait for the **Review request queued. Please wait.** toast.

### What you might see

| Situation | What happens |
| --- | --- |
| Feature off | *Adversarial reviewer is disabled.* |
| Post already reviewed (7 days) | *This post has already been reviewed.* |
| Post removed or spam | *Removed posts cannot be reviewed.* |
| Wrong flair (when required) | *This post does not have the required flair for a review.* |
| Daily limit (non-mod) | *You can only request one review per day.* |
| **No links** in the post | Form: optional **Manuscript URL** (or review post text only) |
| **Two or more links** | Form: pick a link, **Other** (paste a custom URL), or **None — review post text only** |
| **Exactly one link** | Queues immediately with that link |
| Backend busy | *Could not queue right now — will retry automatically.* |
| Form sat too long | *Form expired. Please try again.* |

### Example: post with no external link

Use the menu as usual. If the post has no URLs, you may see:

```
Manuscript URL (optional)
If your post is based on an external manuscript, you may submit a link.
Otherwise, the bot will review your post.
```

Leave the field empty to review the post body only, or paste a direct link to a paper or PDF.

### Example: post with multiple links

You will choose one target:

```
Select manuscript link  →  [one of your links | Other | None — review post text only]
Custom URL              →  (only if you picked Other)
```

### When the review appears

Processing runs in the background. The app looks for finished jobs **every five minutes**. When ready, the bot posts a **distinguished** comment containing the review (plus your configured signature). Stale jobs older than about **one hour** are dropped and the post can be requested again.

On **r/llmphysics_dev**, the per-post lock may clear as soon as the review is posted so you can test again quickly.

## Legal

- [Terms of Service](https://allhailseizure.github.io/adversarial-review/terms/)
- [Privacy Policy](https://allhailseizure.github.io/adversarial-review/privacy/)

## License

This project is licensed under the **MIT License** (Copyright © 2026 Nate Bosma). See [LICENSE](LICENSE) for the full text.