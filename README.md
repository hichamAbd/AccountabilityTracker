# Tally

A private habit and accountability log that runs entirely in the browser and stores everything as encrypted git commits in this repository. There is no server, no database and no third-party service: GitHub Pages hosts the app and a git branch holds the data.

**Open it:** https://hichamabd.github.io/AccountabilityTracker/, then install it to your home screen (Settings → *Use it like an app*).

## What it does

- **Today**: one big **+** per habit, **−** to remove today's last entry, and Undo after every tap. The ⋯ button lets you log at a past time, with a quantity or a note. Keys `1`–`9` log on a computer.
- **Dashboard**: per-habit totals, per day/week/month rates, change vs the previous period, time since last, streaks (clean streaks for bad habits, weekly streaks for weekly goals), clean/done days, goal kept, busiest weekday, peak hour and typical gap. Charts:
  - Over time: day, week or month bars with a rolling average and goal line. Unfinished periods are faded.
  - Calendar heatmap: 12 months or any year.
  - When it happens: a weekday × hour punch card, by weekday, by hour.
  - Time between entries: a histogram of the gaps.
  - All habits: overview cards and a comparison chart.
- **Calendar**: a month grid per habit or all habits, coloured by frequency. Tap a day to see, edit or add entries.
- **History**: every entry, filter by habit, search notes, edit or delete.
- **Colours**: bad habits go green when rare and red when frequent, and good habits the other way round. Choose from four palettes or your own colours, or use each habit's own colour.
- **Show or hide**: hide habits from Today, archive them, and toggle dashboard sections.
- **Settings**: the token, password, export (JSON/CSV), import and device options sit behind your password.
- **Works offline**: entries are queued on the device and committed when you're back online.

## How data is stored

- The app code is on `main`, served by GitHub Pages.
- Data is on the **`data`** branch, so logging never triggers a Pages rebuild:
  - `vault.json`: password salt, an encrypted check value and your **encrypted** GitHub token.
  - `config.json`: encrypted habits and preferences.
  - `events/YYYY-MM.json`: encrypted entries, one file per month.
- Encryption: AES-256-GCM with a key derived from your password (PBKDF2-SHA256, 400k iterations). The repo is public, but its contents can't be read without the password. Commit times are visible.
- Taps within about a second are batched into one commit. Two devices writing at once are merged, and nothing is lost.
- On a new device or browser, you only need the password: the token is unlocked from `vault.json`.

## Setup (one time)

1. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new). For repository access, choose **Only select repositories** and pick this repo. Set Contents to **Read and write**.
2. Open the site, paste the token and choose a password. The app creates the `data` branch.

The password can't be recovered. If you forget it, the data can't be decrypted (the git history still holds it, encrypted).
