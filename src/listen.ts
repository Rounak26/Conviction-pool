// Where scripts/serve.ts listens. Pure so it can be unit-tested without starting a server.
//
//  - Local development: 127.0.0.1:5173, reachable only from this machine.
//  - Render (sets RENDER=true and PORT): 0.0.0.0:$PORT, so the platform's proxy can reach it.
//  - HOST and PORT override either default.

export function listenAddress(env: Record<string, string | undefined>): { host: string; port: number } {
  return {
    host: env.HOST || (env.RENDER ? "0.0.0.0" : "127.0.0.1"),
    port: Number(env.PORT) || 5173,
  };
}
