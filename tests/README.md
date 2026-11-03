# Tests

Browser tests (Playwright) against an in-memory fake of the GitHub API, so they never touch the real repo.

```sh
python3 -m http.server 8765   # from the repository root
node tests/test-flow.js       # setup, logging, sync, second device, conflicts, offline, password change
node tests/test-offline.js    # app opens and logs with no network (needs PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1)
node tests/test-visual.js shots   # seeds a year of data and screenshots every screen into ./shots
node tests/icons.js           # regenerates the PNG icons
```
