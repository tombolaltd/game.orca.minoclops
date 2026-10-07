// The simulation block. Kept behind its own barrel so `src/index.ts` gains one line and the
// dev-server bridge needs no change at all — the `POST /sim` route lives in the HTTP middleware.

export * from './runMechanicSimulation';
