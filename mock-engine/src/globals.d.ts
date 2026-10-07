// The folder is host-agnostic: it compiles with `"lib": ["ES2019"], "types": []`, so neither the
// DOM nor Node globals exist. Only the ambients the engine actually touches are declared, and only
// the members it calls — `Console` is declared as an interface so a host that DOES ship lib.dom or
// @types/node merges with it instead of colliding.
//
// `crypto` needs nothing here: CryptoRandomNumberGenerator reaches it through a cast on globalThis.

interface Console {
    warn(...data: unknown[]): void;
    error(...data: unknown[]): void;
}

declare var console: Console;
