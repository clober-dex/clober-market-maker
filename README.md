# clober-market-maker

To install dependencies:

```bash
bun install
```

Setting private key in `.env`
```text
PRIVATE_KEY=0x...
RPC_URL=
```

To run:

```bash
CHAIN_ID=421614 bun run index.ts
```

To run mock taker bot:

Setting taker private key in `.env`
```text
BASE_RPC_URL=
TAKER_PRIVATE_KEY=
SLACK_TAKER_WEBHOOK=
```

```bash
bun run mock/taker-bot.ts
```

This project was created using `bun init` in bun v1.0.20. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
