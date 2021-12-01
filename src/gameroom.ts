import handleErrors from './handleErrors';

type Session = {
  webSocket: WebSocket;
  blockedMessages?: string[];
  id: string | null;
  quit: boolean;
}

type GameState = {
  id: string,
  version: number,
  state: any
}

export class GameRoom {
  state: DurableObjectState
  env: Env
  sessions: Session[]
  game: GameState | null = null

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sessions = [];
    // `blockConcurrencyWhile()` ensures no requests are delivered until
    // initialization completes.
    this.state.blockConcurrencyWhile(async () => {
        this.game = await this.getGame();
    });
  }

  private async getGame(): Promise<GameState | null> {
    let stored = await this.state.storage?.get<string>("game");    
    return stored ? JSON.parse(stored) : null;
  }

  // Handle HTTP requests from clients.
  async fetch(request: Request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);

      switch (url.pathname) {
        case "/websocket": {
          // The request is to `/api/room/<name>/websocket`. A client is trying to establish a new
          // WebSocket session.
          if (request.headers.get("Upgrade") != "websocket") {
            return new Response("expected websocket", {status: 400});
          }

          // Get the client's IP address for use with the rate limiter.
          let ip = request.headers.get("CF-Connecting-IP");

          // To accept the WebSocket request, we create a WebSocketPair (which is like a socketpair,
          // i.e. two WebSockets that talk to each other), we return one end of the pair in the
          // response, and we operate on the other end. Note that this API is not part of the
          // Fetch API standard; unfortunately, the Fetch API / Service Workers specs do not define
          // any way to act as a WebSocket server today.
          let pair = new WebSocketPair();

          // We're going to take pair[1] as our end, and return pair[0] to the client.
          await this.handleSession(pair[1]);

          // Now we return the other end of the pair to the client.
          return new Response(null, { status: 101, webSocket: pair[0] });
        }

        default:
          return new Response("Not found", {status: 404});
      }
    });
  }

  // handleSession() implements our WebSocket-based game protocol.
  async handleSession(webSocket: WebSocket) {
    // Accept our end of the WebSocket. This tells the runtime that we'll be terminating the
    // WebSocket in JavaScript, not sending it elsewhere.
    webSocket.accept();

    // Create our session and add it to the sessions list.
    // We don't send any messages to the client until it has sent us the initial user info
    // message. Until then, we will queue messages in `session.blockedMessages`.
    const session: Session = {webSocket, blockedMessages: [], id: null, quit: false};
    this.sessions.push(session);

    const currentGame = await this.getGame();
    if(currentGame) {
      session.blockedMessages?.push(JSON.stringify(currentGame));
    }

    // Set event handlers to receive messages.
    webSocket.addEventListener("message", async msg => await this.handleMessage(msg, session));

    // On "close" and "error" events, remove the WebSocket from the sessions list and broadcast
    // a quit message.
    let closeOrErrorHandler = (evt: unknown) => {
      session.quit = true;
      this.sessions = this.sessions.filter(member => member !== session);
      if (session.id) {
        this.broadcast(JSON.stringify({quit: session.id}));
      }
    };
    webSocket.addEventListener('close', closeOrErrorHandler);
    webSocket.addEventListener('error', closeOrErrorHandler);
  }

  async handleMessage(msg: MessageEvent, session: Session) {
    try {
      if (session.quit) {
        // Whoops, when trying to send to this WebSocket in the past, it threw an exception and
        // we marked it broken. But somehow we got another message? I guess try sending a
        // close(), which might throw, in which case we'll try to send an error, which will also
        // throw, and whatever, at least we won't accept the message. (This probably can't
        // actually happen. This is defensive coding.)
        session.webSocket.close(1011, "WebSocket broken.");
        return;
      }

      // I guess we'll use JSON.
      let json = msg.data.toString();
      let data: GameState = JSON.parse(json);

      if (!session.id) {
        if(!data.id) {
          // What to do if their first message did not include an id
          session.webSocket.send(JSON.stringify({error: "First message missing session ID"}));
          session.webSocket.close(1009, "Missing ID");
          return;
        }

        // The first message the client sends is the user info message with their name. Save it
        // into their session object.
        session.id = "" + data.id;

        // Deliver all the messages we queued up since the user connected.
        session.blockedMessages?.forEach(queued => {
          session.webSocket.send(queued);
        });
        delete session.blockedMessages;

        // Broadcast to all other connections that this user has joined.
        this.broadcast(JSON.stringify({joined: session.id}));

        return;
      }    

      if(data.id !== session.id)
      {
        session.webSocket.send(JSON.stringify({
          error: "Session ID incorrect",
        }));
        return;
      }

      // The client may send a ping payload with just an ID to keep the websocket alive
      if(!data.state) return;

      // Check version number
      if(this.game && data.version <= this.game.version)
      {
        session.webSocket.send(JSON.stringify({
          error: "Message out of order",
          gameState: this.game
        }));
        return;
      }

      // Construct sanitized message for storage and broadcast.
      this.game = data;
      let gameStr = JSON.stringify(this.game);

      // Save message
      await this.state.storage?.put("game", gameStr);

      // Broadcast the message to all other WebSockets.
      this.broadcast(gameStr);
    } catch (err: any) {
      // Report any exceptions directly back to the client. As with our handleErrors() this
      // probably isn't what you'd want to do in production, but it's convenient when testing.
      session.webSocket.send(JSON.stringify({error: err.stack}));
    }
  }

  // broadcast() broadcasts a message to all clients.
  broadcast(message: string) {
    if(typeof(message) !== "string") message = JSON.stringify(message);

    // Iterate over all the sessions sending them messages.
    let quitters: Session[] = [];
    this.sessions = this.sessions.filter(session => {
      if (session.id) {
        try {
          session.webSocket.send(message);
          return true;
        } catch (err) {
          // Whoops, this connection is dead. Remove it from the list and arrange to notify
          // everyone below.
          session.quit = true;
          quitters.push(session);
          return false;
        }
      } else {
        // This session hasn't sent the initial user info message yet, so we're not sending them
        // messages yet (no secret lurking!). Queue the message to be sent later.
        session.blockedMessages?.push(message);
        return true;
      }
    });

    quitters.forEach(quitter => {
      if (quitter.id) {
        this.broadcast(JSON.stringify({quit: quitter.id}));
      }
    });
  }
}

interface Env {}
