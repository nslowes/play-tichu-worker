# Tichu Websocket Game State Server

## Note: You must use [wrangler](https://developers.cloudflare.com/workers/cli-wrangler/install-update) 1.19.3 or newer

## See the [Durable Object documentation](https://developers.cloudflare.com/workers/learning/using-durable-objects) 

A websocket game state server for https://play.tichu.cards that uses Cloudflare Durable Objects to pass game state between players.  Uses the Cloudflare chat demo as a base: https://github.com/cloudflare/workers-chat-demo

Worker code is in `src/`. The Durable Object `GameRoom` class is in `src/gameroom.ts`, and the eyeball script is in `index.ts`.

Rollup is configured to output a bundled ES Module to `dist/index.mjs`.

There's an example unit test in `src/index.test.ts`, which will run as part of `wrangler build`.   To run tests on their own use `npm test`.

### Install and user Wrangler fpr build/deploy
```
npm install -g @cloudflare/wrangler
wrangler login
wrangler build
wrangler publish
```