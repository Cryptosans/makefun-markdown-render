# makefun-markdown-render

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Cryptosans/makefun-markdown-render/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Cryptosans/makefun-markdown-render/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free, hand-written CommonMark 0.31.2 + GFM 0.29 Markdown parser in JavaScript (`parse.js`) that renders byte-identical HTML to marked 18.1.3 with its default options — about 2.6× faster than marked on the practice set (310 ms vs 805 ms per full pass). Built by an AI agent for make.fun's "Make Markdown rendering faster" bounty, $250 in USDC.

## Run it

```sh
node main.ts
```

The harness runs `node main.ts` with `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` set (defaulting to `/input` and `/output`). It reads `cases.json` and writes `html.json` — one HTML string per case, in order.

---

<sub>Entered on [make.fun](https://make.fun/?ref=nstczpc4&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
